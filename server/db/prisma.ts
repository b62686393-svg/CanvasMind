import 'dotenv/config'
import { PrismaD1 } from '@prisma/adapter-d1'
import prismaClientPackage from '@prisma/client'
import type { PrismaClient as PrismaClientInstance } from '@prisma/client'
import { createD1RestClient } from './d1-rest-client'

const { PrismaClient } = prismaClientPackage

declare global {
  // eslint-disable-next-line no-var
  var __cananaPrisma__: PrismaClientInstance | undefined
}

// 判断是否使用 Cloudflare D1（生产部署）。
const isD1Mode = () =>
  Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_D1_DATABASE_ID &&
      process.env.CLOUDFLARE_API_TOKEN,
  )

// 判断是否使用本地 SQLite（开发模式）。
const isLocalSqliteMode = () => {
  const url = String(process.env.DATABASE_URL || '').trim()
  return url.startsWith('file:')
}

/**
 * PrismaClient 单例。
 * 开发模式下复用实例，避免 Vite / Node 热更新反复创建连接。
 *
 * 双模式数据库访问：
 * - Cloudflare 部署：通过 D1 REST API 客户端访问 Cloudflare D1（SQLite）。
 * - 本地开发：通过 better-sqlite3 驱动访问本地 SQLite 文件。
 *
 * 所有 service 文件依旧使用 prisma.xxx，业务逻辑零改动。
 */
const createPrismaClient = () => {
  let adapter: unknown

  if (isD1Mode()) {
    // 生产：Cloudflare D1 via REST API。
    const d1 = createD1RestClient()
    adapter = new PrismaD1(d1 as never)
  } else if (isLocalSqliteMode()) {
    // 本地开发：SQLite 文件。
    // 动态导入避免在生产环境（无 better-sqlite3 原生依赖）中加载失败。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3')
    adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL })
  } else {
    throw new Error(
      '数据库未配置。请设置 CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_D1_DATABASE_ID/CLOUDFLARE_API_TOKEN（D1）或 DATABASE_URL=file:./prisma/dev.db（本地 SQLite）。',
    )
  }

  return new PrismaClient({
    adapter: adapter as never,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

/**
 * 判断数据库是否已配置。
 * 支持 D1（三项环境变量）和本地 SQLite（file: 前缀 DATABASE_URL）两种模式。
 */
export const isPrismaConfigured = () => isD1Mode() || isLocalSqliteMode()

export const getPrismaClient = () => {
  if (globalThis.__cananaPrisma__) {
    return globalThis.__cananaPrisma__
  }

  const prisma = createPrismaClient()

  globalThis.__cananaPrisma__ = prisma

  return prisma
}

export const prisma = new Proxy({} as PrismaClientInstance, {
  get(_target, prop, receiver) {
    const client = getPrismaClient()
    return Reflect.get(client, prop, receiver)
  },
})

export default prisma
