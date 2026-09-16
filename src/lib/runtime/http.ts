/**
 * runtime/http.ts — HTTP 服务:Bun 上走 `Bun.serve`,Node 上走 node:http + Fetch 的 Request/Response。
 *
 * 只覆盖仓库里用到的形状:`fetch(req: Request) => Response | Promise<Response>`、随机端口、
 * `stop(force?)`、`port`。WebSocket 升级(yi-ws-server)不在这里 —— Node 没有原生 ws 服务端,
 * 那一处仍直接用 Bun.serve(见 no-bun-globals.test.ts 的白名单)。
 */
export interface ServeOptions {
  hostname?: string
  port?: number
  /** 秒;Bun 的连接空闲超时(上限 255)。Node 上映射到 server.requestTimeout / headersTimeout。 */
  idleTimeout?: number
  fetch(request: Request): Response | Promise<Response>
}
export interface Server {
  readonly port: number
  readonly hostname: string
  /** Bun.serve 返回时端口已定;Node 的 listen 是异步的。读端口前先 `await ready`。 */
  readonly ready: Promise<void>
  stop(force?: boolean): void
}

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

export function serve(options: ServeOptions): Server {
  if (isBun()) {
    const bun = (globalThis as unknown as { Bun: { serve: (o: ServeOptions) => { port: number; hostname: string; stop(force?: boolean): void } } }).Bun
    const server = bun.serve(options)
    return { get port() { return server.port }, get hostname() { return server.hostname }, ready: Promise.resolve(), stop: force => server.stop(force) }
  }
  return nodeServe(options)
}

function nodeServe(options: ServeOptions): Server {
  const http = require('node:http') as typeof import('node:http')
  const {Readable} = require('node:stream') as typeof import('node:stream')
  const hostname = options.hostname ?? '0.0.0.0'
  const server = http.createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host ?? `${hostname}:${(server.address() as {port: number}).port}`}${req.url ?? '/'}`
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const v of value) headers.append(key, v)
        else headers.set(key, value)
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
        // @ts-expect-error Node 的 fetch 需要这个标记才接受流式 body
        duplex: hasBody ? 'half' : undefined,
      })
      const response = await options.fetch(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => { res.setHeader(key, value) })
      if (!response.body) { res.end(); return }
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500
      res.end()
      void error
    }
  })
  if (options.idleTimeout !== undefined) {
    server.requestTimeout = options.idleTimeout * 1000
    server.headersTimeout = Math.min(server.requestTimeout, 60_000)
  }
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(options.port ?? 0, hostname)
  const address = () => server.address() as {port: number} | null
  return {
    get port() { return address()?.port ?? 0 },
    hostname,
    ready,
    stop(force) { if (force) server.closeAllConnections(); server.close() },
  }
}
