/**
 * ACP(Agent Client Protocol v1)的传输层:stdio 上换行分隔的 JSON-RPC 2.0。
 * 真机(cursor-agent acp,2026-09-17 spike)一行一条,没有 Content-Length 头。
 * 只管配对与回复,不认识任何方法名。
 */
export interface AcpRpcError { code: number; message: string; data?: unknown }
export interface AcpConnectionOptions {
  rpcTimeoutMs: number
  /** agent → client 请求:返回值作为 result;抛错 ⇒ error 回复(code 取 err.code 数字,否则 -32603)。 */
  onRequest(method: string, params: unknown, id: string | number): Promise<unknown>
  onNotification(method: string, params: unknown): void
  /** 协议层无法继续(解析失败、行超长、写失败)。只触发一次。 */
  onFatal(error: Error): void
}
export interface AcpConnection {
  /** timeoutMs 缺省 rpcTimeoutMs;0 ⇒ 不限时(session/prompt 由服务层 watchdog 兜底)。 */
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>
  notify(method: string, params: unknown): void
  /** 拒绝所有挂起请求;之后 request 直接 reject,晚到的 agent 请求回 -32603。 */
  dispose(reason: Error): void
}
export class AcpRequestError extends Error {
  code: number; data?: unknown
  constructor(error: AcpRpcError) { super(error.message); this.name = 'AcpRequestError'; this.code = error.code; this.data = error.data }
}

const MAX_LINE = 4 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function createAcpConnection(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream, options: AcpConnectionOptions): AcpConnection {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  let sequence = 0, buffer = '', disposed: Error | undefined, fatal = false
  const fail = (message: string) => { if (fatal) return; fatal = true; options.onFatal(new Error(message)) }
  // Node's Writable emits 'error' for write-after-end regardless of the write() callback; without a
  // listener that throws as an unhandled event. The callback below still handles ordinary write failures.
  stdin.on('error', () => fail('acp_protocol_write_failed'))
  const write = (message: Record<string, unknown>) => {
    try { stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', error => { if (error) fail('acp_protocol_write_failed') }) }
    catch { fail('acp_protocol_write_failed') }
  }
  const respond = (id: string | number, outcome: { result: unknown } | { error: AcpRpcError }) => write({ id, ...outcome })
  const handle = (message: Record<string, unknown>) => {
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (hasId && typeof message.method !== 'string') {
      // 响应
      const entry = typeof id === 'number' ? pending.get(id) : undefined
      if (!entry) return
      pending.delete(id as number); if (entry.timer) clearTimeout(entry.timer)
      if (object(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') entry.reject(new AcpRequestError(message.error as unknown as AcpRpcError))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    if (!hasId) { options.onNotification(message.method, message.params); return }
    if (disposed) { respond(id as string | number, { error: { code: -32603, message: disposed.message } }); return }
    void options.onRequest(message.method, message.params, id as string | number).then(
      result => respond(id as string | number, { result: result === undefined ? null : result }),
      (error: unknown) => {
        const code = object(error) && typeof error.code === 'number' ? error.code : -32603
        respond(id as string | number, { error: { code, message: error instanceof Error ? error.message : String(error) } })
      },
    )
  }
  stdout.on('data', chunk => {
    if (fatal) return
    buffer += String(chunk)
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) { buffer = ''; fail('acp_line_too_long'); return }
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
      if (!line) continue
      if (line.length > MAX_LINE) { fail('acp_line_too_long'); return }
      let message: unknown
      try { message = JSON.parse(line) } catch { fail('acp_invalid_protocol_message'); return }
      if (!object(message)) { fail('acp_invalid_protocol_message'); return }
      handle(message)
    }
  })
  return {
    request(method, params, timeoutMs = options.rpcTimeoutMs) {
      if (disposed) return Promise.reject(disposed)
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const entry: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject }
        if (timeoutMs > 0) entry.timer = setTimeout(() => { pending.delete(id); reject(new Error(`acp_rpc_timeout: ${method}`)) }, timeoutMs)
        pending.set(id, entry)
        write({ id, method, params })
      })
    },
    notify(method, params) { if (!disposed) write({ method, params }) },
    dispose(reason) {
      if (disposed) return
      disposed = reason
      for (const [id, entry] of pending) { pending.delete(id); if (entry.timer) clearTimeout(entry.timer); entry.reject(reason) }
    },
  }
}
