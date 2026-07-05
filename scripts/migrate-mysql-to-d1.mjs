/**
 * MySQL → Cloudflare D1 数据迁移脚本。
 *
 * 从源 MySQL 数据库读取所有表数据，转换类型后写入 D1。
 *
 * 用法：
 *   MYSQL_SOURCE_URL="mysql://user:pass@host:3306/dbname" \
 *   CLOUDFLARE_ACCOUNT_ID=xxx \
 *   CLOUDFLARE_D1_DATABASE_ID=xxx \
 *   CLOUDFLARE_API_TOKEN=xxx \
 *   node scripts/migrate-mysql-to-d1.mjs
 *
 * 依赖：mysql2（需先 npm install mysql2）
 *
 * 类型转换规则：
 * - MySQL datetime/timestamp → ISO 8601 字符串（D1 DateTime）
 * - MySQL decimal → number（D1 Float）
 * - MySQL bigint → number（D1 BigInt，安全范围内）
 * - MySQL json → 原样保留（D1 Json）
 * - Buffer/BLOB → base64 字符串
 */
import mysql from 'mysql2/promise'

// ─── 配置 ──────────────────────────────────────────────────────
const SOURCE_URL = process.env.MYSQL_SOURCE_URL
const D1 = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
}

if (!SOURCE_URL || !D1.accountId || !D1.databaseId || !D1.apiToken) {
  console.error('缺少环境变量：MYSQL_SOURCE_URL / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN')
  process.exit(1)
}

// 按外键依赖排序的表迁移顺序（父表在前，子表在后）。
// 与 Prisma schema 的 @@map 名一致。
const TABLE_ORDER = [
  'app_users',
  'admin_audit_logs',
  'auth_verification_codes',
  'auth_method_configs',
  'app_user_auth_identities',
  'app_sessions',
  'ai_provider_configs',
  'ai_provider_custom_models',
  'ai_providers',
  'ai_models',
  'ai_skills',
  'ai_skill_dependencies',
  'ai_skill_prompt_templates',
  'ai_skill_workflow_templates',
  'ai_skill_plan_templates',
  'ai_skill_stage_templates',
  'workflow_definitions',
  'workflow_definition_versions',
  'object_storage_configs',
  'generation_sessions',
  'generation_records',
  'generation_outputs',
  'asset_items',
  'asset_favorites',
  'agent_runs',
  'agent_run_steps',
  'agent_process_sections',
  'membership_levels',
  'membership_plans',
  'user_subscriptions',
  'membership_orders',
  'recharge_packages',
  'recharge_orders',
  'card_batches',
  'card_codes',
  'card_redeem_records',
  'point_account_logs',
  'reward_rules',
  'reward_claim_records',
  'user_checkin_records',
  'system_settings',
]

const BATCH_SIZE = 50 // 每批插入行数

// ─── D1 REST API ──────────────────────────────────────────────
const d1Query = async (sql, params = []) => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${D1.accountId}/d1/database/${D1.databaseId}/query`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${D1.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`D1 API 失败: ${response.status} ${text.slice(0, 300)}`)
  }

  const data = await response.json()
  if (!data.success) {
    throw new Error(data.errors?.[0]?.message || 'D1 查询失败')
  }
  return data.result?.[0]
}

// ─── 类型转换 ──────────────────────────────────────────────────
const convertValue = (value) => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// ─── 迁移单个表 ──────────────────────────────────────────────
const migrateTable = async (connection, tableName) => {
  console.info(`[migrate] 读取 ${tableName} ...`)

  const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``)

  if (!rows || rows.length === 0) {
    console.info(`[migrate] ${tableName}: 0 行，跳过`)
    return 0
  }

  // 从第一行获取列名。
  const columns = Object.keys(rows[0])
  const totalRows = rows.length
  console.info(`[migrate] ${tableName}: ${totalRows} 行，${columns.length} 列`)

  // 分批插入。
  for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE)
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    const sql = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders}`

    const params = []
    for (const row of batch) {
      for (const col of columns) {
        params.push(convertValue(row[col]))
      }
    }

    try {
      await d1Query(sql, params)
    } catch (error) {
      const msg = String(error?.message || error)
      // 忽略"已存在"错误（幂等重跑场景）。
      if (/UNIQUE constraint failed|already exists/i.test(msg)) {
        console.info(`[migrate] ${tableName} 批次 ${offset}-${offset + batch.length} 部分已存在，跳过`)
        continue
      }
      throw new Error(`${tableName} 插入失败 (行 ${offset}-${offset + batch.length}): ${msg}`)
    }
  }

  console.info(`[migrate] ${tableName}: 完成`)
  return totalRows
}

// ─── 主流程 ──────────────────────────────────────────────────
const main = async () => {
  console.info('[migrate] 连接源 MySQL 数据库 ...')
  const connection = await mysql.createConnection(SOURCE_URL)

  // 先确保 D1 表结构已就绪（提示用户）。
  console.info('[migrate] 请确保 D1 表结构已通过 d1-migrate.mjs 创建完毕。')

  // 关闭外键检查，避免插入顺序问题。
  await d1Query('PRAGMA foreign_keys = OFF')

  let totalMigrated = 0
  const stats = {}

  try {
    for (const tableName of TABLE_ORDER) {
      // 检查 MySQL 中是否存在该表。
      const [tables] = await connection.query(
        `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName],
      )

      if (!tables || tables.length === 0) {
        console.info(`[migrate] ${tableName}: MySQL 中不存在，跳过`)
        continue
      }

      const count = await migrateTable(connection, tableName)
      stats[tableName] = count
      totalMigrated += count
    }
  } finally {
    await d1Query('PRAGMA foreign_keys = ON')
    await connection.end()
  }

  console.info('\n[migrate] 迁移完成汇总:')
  for (const [table, count] of Object.entries(stats)) {
    console.info(`  ${table}: ${count} 行`)
  }
  console.info(`  总计: ${totalMigrated} 行`)
}

main().catch((error) => {
  console.error('[migrate] 迁移失败', error)
  process.exit(1)
})
