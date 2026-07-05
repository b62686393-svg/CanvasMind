/**
 * Cloudflare D1 REST API 客户端。
 *
 * 背景：Cloudflare Containers 运行的是真实 Node.js 进程，没有 Workers 运行时的 D1
 * 原生 binding。为了让 @prisma/adapter-d1 在容器内可用，这里通过 D1 的 HTTP API
 * 实现一份 D1Database 接口兼容对象，再交给 Prisma 的 D1 适配器。
 *
 * 业务逻辑零改动：所有 service 文件依旧使用 prisma.xxx，底层访问透明切换。
 */

// D1 结果元信息（仅保留 Prisma 适配器实际读取的字段）。
interface D1ResultMeta {
  duration?: number
  changes?: number
  last_row_id?: number | string
  served_by?: string
  rows_read?: number
  rows_written?: number
}

// D1 单条查询结果。
interface D1Result<T = Record<string, unknown>> {
  results?: T[]
  success: boolean
  meta?: D1ResultMeta
}

// D1 预处理语句接口。
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  all<T = unknown>(): Promise<D1Result<T>>
  run<T = unknown>(): Promise<D1Result<T>>
}

// D1 数据库接口（与 @cloudflare/workers-types 的 D1Database 对齐）。
interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<unknown>
  dump(): Promise<ArrayBuffer>
}

// D1 REST API 单次查询响应。
interface D1QueryResponse {
  result: Array<{
    results: Record<string, unknown>[]
    success: boolean
    meta?: D1ResultMeta
  }>
  success: boolean
  errors: Array<{ code?: number; message?: string }>
  messages: unknown[]
}

// D1 REST API 批量查询响应。
interface D1BatchResponse {
  result: Array<{
    results: Record<string, unknown>[]
    success: boolean
    meta?: D1ResultMeta
  }>
  success: boolean
  errors: Array<{ code?: number; message?: string }>
  messages: unknown[]
}

// D1 REST API 配置。
interface D1RestClientOptions {
  /** Cloudflare 账户 ID。 */
  accountId: string
  /** D1 数据库 ID。 */
  databaseId: string
  /** 拥有 D1 读写权限的 API Token。 */
  apiToken: string
  /** 自定义请求超时（毫秒），默认 30 秒。 */
  requestTimeoutMs?: number
}

// 把任意值转成 D1 REST API 可接受的参数形式。
// BigInt / Buffer 等特殊类型统一转成字符串，避免 JSON 序列化丢失精度。
const normalizeParam = (value: unknown): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return String(value)
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'toISOString' in value && typeof (value as { toISOString: unknown }).toISOString === 'function') {
    return (value as { toISOString: () => string }).toISOString()
  }
  return value
}

/**
 * 基于原生 fetch 的 D1 HTTP API 客户端。
 * 实现 D1Database 接口，可直接传给 @prisma/adapter-d1。
 */
export class D1RestClient implements D1Database {
  private readonly queryEndpoint: string
  private readonly batchEndpoint: string
  private readonly authHeaders: Record<string, string>
  private readonly requestTimeoutMs: number

  constructor(options: D1RestClientOptions) {
    if (!options.accountId) throw new Error('D1RestClient 缺少 accountId')
    if (!options.databaseId) throw new Error('D1RestClient 缺少 databaseId')
    if (!options.apiToken) throw new Error('D1RestClient 缺少 apiToken')

    const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}`
    this.queryEndpoint = `${base}/query`
    this.batchEndpoint = `${base}/batch`
    this.authHeaders = {
      Authorization: `Bearer ${options.apiToken}`,
      'Content-Type': 'application/json',
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  private async postJson<T>(endpoint: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`D1 REST API 请求失败: HTTP ${response.status} ${response.statusText}${text ? ` · ${text}` : ''}`)
      }

      const json = (await response.json()) as T
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  prepare(sql: string): D1PreparedStatement {
    // 预处理语句在 bind 时累积参数，执行时发起一次 REST 请求。
    return new D1RestPreparedStatement(this, sql)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // 从每条预处理语句中提取 SQL 与参数，组装成批量请求体。
    const payloads = statements.map((stmt) => {
      if (!(stmt instanceof D1RestPreparedStatement)) {
        throw new Error('D1RestClient.batch 仅支持由本客户端 prepare 生成的语句')
      }
      return { sql: stmt.sql, params: stmt.boundParams }
    })

    const data = await this.postJson<D1BatchResponse>(this.batchEndpoint, { statements: payloads })

    if (!data.success) {
      const msg = data.errors?.[0]?.message || 'D1 批量查询失败'
      throw new Error(msg)
    }

    return data.result.map((item) => ({
      results: (item.results ?? []) as T[],
      success: item.success,
      meta: item.meta,
    }))
  }

  async exec(query: string): Promise<unknown> {
    // exec 用于执行多语句脚本，复用 query 端点。
    const data = await this.postJson<D1QueryResponse>(this.queryEndpoint, { sql: query })

    if (!data.success) {
      const msg = data.errors?.[0]?.message || 'D1 exec 失败'
      throw new Error(msg)
    }

    return {
      count: data.result.length,
      duration: data.result.reduce((sum, item) => sum + (item.meta?.duration ?? 0), 0),
    }
  }

  async dump(): Promise<ArrayBuffer> {
    // dump 用于导出数据库快照，当前未使用，保留接口完整性。
    const response = await fetch(`${this.queryEndpoint.replace('/query', '/dump')}`, {
      method: 'GET',
      headers: this.authHeaders,
    })
    if (!response.ok) {
      throw new Error(`D1 dump 请求失败: HTTP ${response.status}`)
    }
    return response.arrayBuffer()
  }

  // 供预处理语句调用：执行单条 SQL。
  async runSql<T = unknown>(sql: string, params: unknown[]): Promise<D1Result<T>> {
    const data = await this.postJson<D1QueryResponse>(this.queryEndpoint, {
      sql,
      params: params.map(normalizeParam),
    })

    if (!data.success) {
      const msg = data.errors?.[0]?.message || 'D1 查询失败'
      throw new Error(msg)
    }

    const item = data.result[0] ?? { results: [], success: false, meta: {} }
    return {
      results: (item.results ?? []) as T[],
      success: item.success,
      meta: item.meta,
    }
  }
}

/**
 * D1 预处理语句实现。
 * 通过 bind 链式累积参数，执行时调用宿主客户端发起 REST 请求。
 */
class D1RestPreparedStatement implements D1PreparedStatement {
  boundParams: unknown[] = []

  constructor(
    private readonly client: D1RestClient,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.boundParams.push(...values)
    return this
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const result = await this.client.runSql<T>(this.sql, this.boundParams)
    const row = result.results?.[0]
    if (!row) return null
    if (colName) return (row as Record<string, T>)[colName] ?? null
    return row as T
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.client.runSql<T>(this.sql, this.boundParams)
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.client.runSql<T>(this.sql, this.boundParams)
  }
}

/**
 * 从环境变量创建 D1 REST 客户端。
 *
 * 所需环境变量：
 * - CLOUDFLARE_ACCOUNT_ID
 * - CLOUDFLARE_D1_DATABASE_ID
 * - CLOUDFLARE_API_TOKEN（需具备 D1 读写权限）
 */
export const createD1RestClient = (): D1RestClient => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      '缺少 D1 访问配置，请设置 CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_D1_DATABASE_ID、CLOUDFLARE_API_TOKEN。',
    )
  }

  return new D1RestClient({ accountId, databaseId, apiToken })
}
