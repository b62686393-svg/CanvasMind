/**
 * Cloudflare D1 迁移运行器。
 *
 * 工作方式：
 * 1. 在 D1 中维护 _d1_migrations 追踪表，记录已应用的迁移。
 * 2. 读取 migrations/ 目录下的 .sql 文件（按文件名排序），逐个应用未执行的迁移。
 * 3. 若 migrations/ 为空，则通过 prisma migrate diff 从 schema 生成初始 DDL 并应用。
 *
 * 用法：node d1-migrate.mjs
 *
 * 环境变量：CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_D1_DATABASE_ID、CLOUDFLARE_API_TOKEN
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations')

// 读取环境变量。
const readEnv = () => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !databaseId || !apiToken) {
    throw new Error('缺少 D1 环境变量（CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN）')
  }
  return { accountId, databaseId, apiToken }
}

// 执行 D1 REST API 查询。
const d1Query = async (env, sql, params = []) => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/d1/database/${env.databaseId}/query`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`D1 REST API 失败: HTTP ${response.status} ${response.statusText}${text ? ` · ${text}` : ''}`)
  }

  const data = await response.json()
  if (!data.success) {
    const msg = data.errors?.[0]?.message || 'D1 查询失败'
    throw new Error(msg)
  }
  return data.result?.[0] ?? { results: [], success: true }
}

// 运行子命令并收集输出。
const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} 失败 (${code})\n${stderr || stdout}`))
    })
  })

// 通过 prisma migrate diff 从 schema 生成初始 DDL。
const generateInitialSql = async () => {
  console.info('[d1-migrate] migrations/ 为空，正在通过 prisma migrate diff 生成初始 DDL')
  const { stdout } = await runCommand('npx', [
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ])
  return stdout
}

// 读取 migrations/ 目录下所有 .sql 文件。
const readMigrationFiles = async () => {
  if (!existsSync(MIGRATIONS_DIR)) return []
  const entries = await fs.readdir(MIGRATIONS_DIR)
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort()
  const result = []
  for (const name of sqlFiles) {
    const content = await fs.readFile(path.resolve(MIGRATIONS_DIR, name), 'utf8')
    result.push({ name, content })
  }
  return result
}

// 主流程。
const main = async () => {
  const env = readEnv()

  // 1. 确保追踪表存在。
  await d1Query(
    env,
    `CREATE TABLE IF NOT EXISTS _d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  )

  // 2. 读取待应用的迁移。
  let migrations = await readMigrationFiles()

  // 若没有迁移文件，从 schema 动态生成。
  let generatedMode = false
  if (migrations.length === 0) {
    const sql = await generateInitialSql()
    migrations = [{ name: '0001_init.sql', content: sql }]
    generatedMode = true
  }

  // 3. 查询已应用的迁移。
  const applied = await d1Query(env, 'SELECT name FROM _d1_migrations')
  const appliedNames = new Set((applied.results ?? []).map((row) => row.name))

  // 4. 逐个应用未执行的迁移。
  let appliedCount = 0
  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue

    console.info(`[d1-migrate] 正在应用迁移: ${migration.name}`)

    // D1 exec 端点支持多语句；这里拆分后逐条执行以获得更好的错误定位。
    // 注意：保留原始语句完整性，仅在分号后拆分。
    const statements = migration.content
      .split(/;\s*(?:\n|$)/)
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0 && !stmt.startsWith('--'))

    for (const stmt of statements) {
      try {
        await d1Query(env, stmt)
      } catch (error) {
        // 忽略"已存在"类错误，避免幂等执行失败。
        const msg = String(error?.message || error)
        if (/already exists|duplicate/i.test(msg)) {
          console.info(`[d1-migrate] 跳过已存在对象: ${msg.slice(0, 80)}`)
          continue
        }
        throw new Error(`迁移 ${migration.name} 执行失败: ${msg}\n语句: ${stmt.slice(0, 200)}`)
      }
    }

    await d1Query(env, 'INSERT INTO _d1_migrations (name) VALUES (?)', [migration.name])
    appliedCount += 1
    console.info(`[d1-migrate] 已应用迁移: ${migration.name}`)
  }

  // 5. 若使用了动态生成模式，把 SQL 落盘以便复用。
  if (generatedMode && migrations.length > 0) {
    await fs.mkdir(MIGRATIONS_DIR, { recursive: true })
    await fs.writeFile(path.resolve(MIGRATIONS_DIR, migrations[0].name), migrations[0].content, 'utf8')
    console.info(`[d1-migrate] 已保存迁移文件: ${migrations[0].name}`)
  }

  if (appliedCount === 0) {
    console.info(`[d1-migrate] 已是最新，无需迁移（共 ${migrations.length} 个迁移）`)
  } else {
    console.info(`[d1-migrate] 完成，已应用 ${appliedCount} 个迁移（共 ${migrations.length} 个迁移）`)
  }
}

main().catch((error) => {
  console.error('[d1-migrate] 迁移失败', error)
  process.exit(1)
})
