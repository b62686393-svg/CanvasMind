/**
 * Cloudflare Worker 前门。
 *
 * 职责：将所有入站请求透明转发给 Cloudflare Container 内运行的 CanvasMind
 * 后端（node:http 服务），包括 API、SSE 流、静态前端资源。
 *
 * 容器实例由 Durable Object 编排，首次请求自动冷启动，后续复用运行中实例。
 * 后端业务逻辑、交互、API 路径全部不变。
 */
import { Container } from '@cloudflare/containers'

// 容器内 node:http 服务监听端口，与 Dockerfile 的 APP_PORT 一致。
export class CanvasMindContainer extends Container {
  defaultPort = 5409
}

interface Env {
  CANVASMIND_CONTAINER: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 使用固定名称获取单例容器实例。
    const id = env.CANVASMIND_CONTAINER.idFromName('default')
    const stub = env.CANVASMIND_CONTAINER.get(id)

    // 透明转发请求与响应（含 SSE 流式响应）。
    return stub.fetch(request)
  },
}
