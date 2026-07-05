import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// SQLite 本地文件用于 prisma CLI（generate / migrate diff）。
// 生产环境通过 D1 REST API 访问，不使用此 URL 建立真实连接。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL') ?? 'file:./prisma/dev.db',
  },
})
