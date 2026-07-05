import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

// 执行子命令；默认收集输出，必要时再决定是否原样透传。
const runCommand = (command, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const outputChunks = []
    const errorChunks = []

    // 启动子进程。
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })

    child.stdout?.on('data', (chunk) => {
      outputChunks.push(chunk)
      if (options.forwardStdout) {
        process.stdout.write(chunk)
      }
    })

    child.stderr?.on('data', (chunk) => {
      errorChunks.push(chunk)
      if (options.forwardStderr) {
        process.stderr.write(chunk)
      }
    })

    // 监听命令执行失败场景。
    child.on('error', reject)

    // 根据退出码判断命令是否成功。
    child.on('close', (code) => {
      const stdout = Buffer.concat(outputChunks).toString('utf8')
      const stderr = Buffer.concat(errorChunks).toString('utf8')

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(`${command} ${args.join(' ')} 执行失败，退出码: ${code}\n${stderr || stdout}`))
    })
  })
}

// 判断生产环境配置文件是否存在。
const hasProductionEnvFile = async () => {
  try {
    await fs.access(path.resolve(process.cwd(), '.env.production'))
    return true
  } catch {
    return false
  }
}

// 判断是否为 D1 模式（生产 Cloudflare 部署）。
const isD1Mode = () =>
  Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_D1_DATABASE_ID &&
      process.env.CLOUDFLARE_API_TOKEN,
  )

// 从 D1 迁移脚本输出里提取核心信息，避免把整段原始日志直接打出来。
const summarizeD1MigrateOutput = (rawText) => {
  const normalizedText = String(rawText || '')
  const appliedMatch = normalizedText.match(/已应用迁移[：:]\s*(\S+)/i)
  const skippedMatch = /已是最新|无需迁移/i.test(normalizedText)
  const totalMatch = normalizedText.match(/共\s*(\d+)\s*个迁移/i)

  return {
    databaseName: 'Cloudflare D1',
    databaseAddress: process.env.CLOUDFLARE_D1_DATABASE_ID || 'unknown',
    migrationCount: totalMatch?.[1] || '',
    statusText: skippedMatch
      ? '已是最新'
      : appliedMatch
        ? `已应用迁移: ${appliedMatch[1]}`
        : '迁移检查已完成',
  }
}

// 从 Prisma db push 输出里提取核心信息（本地 SQLite 模式）。
const summarizePrismaPushOutput = (rawText) => {
  const normalizedText = String(rawText || '')
  const appliedMatch = /already in sync|no changes|applied/i.test(normalizedText)

  return {
    databaseName: 'SQLite (local)',
    databaseAddress: process.env.DATABASE_URL || 'unknown',
    migrationCount: '',
    statusText: appliedMatch ? 'Schema 已同步' : '迁移检查已完成',
  }
}

const resolveRedisStatusText = () => {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.REDIS_ENABLED || '').trim().toLowerCase())
  if (!enabled) {
    return '未启用'
  }

  const host = String(process.env.REDIS_HOST || '').trim() || '127.0.0.1'
  const port = String(process.env.REDIS_PORT || '').trim() || '6379'
  const database = String(process.env.REDIS_DATABASE || '').trim() || '0'
  return `已启用 (${host}:${port}/${database})`
}

// 启动生产环境应用。
const start = async () => {
  const hasEnvFile = await hasProductionEnvFile()
  console.info('[start-production] 启动准备中')
  console.info(`[start-production] 环境文件: ${hasEnvFile ? '.env.production' : '未检测到 .env.production，使用当前进程环境变量'}`)

  // 先执行数据库迁移，确保表结构已就绪。
  // D1 模式通过 REST API 应用迁移；本地 SQLite 模式通过 prisma db push 同步 schema。
  console.info('[start-production] 正在检查数据库迁移')
  let migrationSummary
  if (isD1Mode()) {
    const migrateResult = await runCommand('node', ['scripts/d1-migrate.mjs'])
    migrationSummary = summarizeD1MigrateOutput(`${migrateResult.stdout}\n${migrateResult.stderr}`)
  } else {
    const migrateResult = await runCommand('npx', ['prisma', 'db', 'push'])
    migrationSummary = summarizePrismaPushOutput(`${migrateResult.stdout}\n${migrateResult.stderr}`)
  }
  console.info(
    `[start-production] 数据库迁移检查完成: ${migrationSummary.databaseName || 'unknown'} @ ${migrationSummary.databaseAddress || 'unknown'} · `
    + `${migrationSummary.migrationCount || '0'} 个迁移 · ${migrationSummary.statusText}`,
  )

  // 根据运行环境决定是否显式加载 .env.production。
  const serverArgs = hasEnvFile
    ? ['--env-file=.env.production', 'dist-service/server/index.js']
    : ['dist-service/server/index.js']

  console.info(`[start-production] Redis: ${resolveRedisStatusText()}`)
  console.info('[start-production] 正在启动后端服务')

  // 再启动正式后端服务，由后端统一承载 API 与静态前端。
  await runCommand('node', serverArgs, {
    forwardStdout: true,
    forwardStderr: true,
  })
}

// 执行启动流程，并在失败时返回非零退出码。
start().catch((error) => {
  // 输出启动失败原因，便于排查部署问题。
  console.error('[start-production] 启动失败', error)
  process.exit(1)
})
