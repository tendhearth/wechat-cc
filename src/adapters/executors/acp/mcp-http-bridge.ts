/** Session-owned transport only: no tool dispatch, tier decisions, or persistent secrets. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { AcpHttpMcpServer, AcpStdioMcpServer } from './acp-agent-provider'

export interface McpHttpBridge {
  servers: AcpHttpMcpServer[]
  readonly active: boolean
  /** Exact ACP title learned only from this bridge's tools/list responses. */
  hasTool(title: string): boolean
  processGroups(): readonly number[]
  /** Revokes synchronously, then waits for sockets and children to close. */
  close(): Promise<void>
  redact(text: string): string
  createTextRedactor(): (chunk: string, final?: boolean) => string
}

/** Compare fixed-size hashes even for missing/malformed credentials. */
export function mcpBearerMatches(header: string | undefined, token: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}

export async function createMcpHttpBridge(
  specs: readonly AcpStdioMcpServer[],
  options: { cwd: string; spawn?: typeof nodeSpawn; signal?: AbortSignal; log?: (tag: string, line: string) => void },
): Promise<McpHttpBridge> {
  const token = randomBytes(32).toString('base64url')
  let active = true, closing: Promise<void> | undefined
  let requestErrorLogged = false
  const toolTitles = new Set<string>()
  const entries: Array<{ child: ChildProcess; transport: StreamableHTTPServerTransport; hasExited(): boolean; getStream?: ServerResponse; flush(): void }> = []
  const server = createServer((req, res) => { void handle(req, res) })
  const close = (): Promise<void> => {
    active = false // Before any await: every endpoint, including in-flight body reads, is revoked.
    toolTitles.clear()
    if (closing) return closing
    closing = (async () => {
      const outcomes = await Promise.allSettled(entries.map(async ({ child, transport, hasExited }) => {
        await transport.close().catch(() => {})
        try { child.stdin?.end() } catch { /* closed */ }
        const signal = (sig: NodeJS.Signals) => {
          try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig) }
          catch { /* A dying group can transiently reject signals; the exit check below is authoritative. */ }
        }
        const alive = () => {
          if (!child.pid) return !hasExited()
          try { process.kill(-child.pid, 0); return true }
          catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
        }
        const deadline = Date.now() + 750
        signal('SIGTERM')
        let killed = false
        while (!hasExited() || alive()) {
          if (!killed && Date.now() >= deadline - 400) { signal('SIGKILL'); killed = true }
          if (Date.now() >= deadline) throw new Error('mcp_process_not_exited')
          await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
      }))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      options.signal?.removeEventListener('abort', abortBridge)
      const failed = outcomes.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw new Error('mcp_process_cleanup_failed', { cause: failed.reason })
    })()
    return closing
  }
  const fail = () => {
    // Never log child stderr, RPC bodies, headers, argv, or error objects containing credentials.
    if (active) options.log?.('MCP', 'Grok MCP transport stopped')
    void close().catch(() => options.log?.('MCP', 'Grok MCP process cleanup unconfirmed'))
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!active || !mcpBearerMatches(req.headers.authorization, token)) { res.writeHead(401).end(); return }
    const address = server.address()
    const origin = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    if (req.headers.host !== origin.slice(7) || (req.headers.origin !== undefined && req.headers.origin !== origin)) { res.writeHead(403).end(); return }
    const entry = entries[Number(req.url?.match(/^\/mcp\/(\d+)$/)?.[1] ?? NaN)]
    if (!entry) { res.writeHead(404).end(); return }
    // The SDK installs its GET stream before writing HTTP headers. Track only successful
    // SSE responses; flush queued notifications once that stream can receive them.
    if (req.method === 'GET') {
      const writeHead = res.writeHead
      res.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
        const result = writeHead.apply(this, args)
        if (this.statusCode === 200) {
          entry.getStream = res
          entry.flush()
        }
        return result
      } as ServerResponse['writeHead']
      res.on('close', () => { if (entry.getStream === res) entry.getStream = undefined })
    }
    try { await entry.transport.handleRequest(req, res) }
    catch { if (!res.headersSent) res.writeHead(400).end(); else res.end() }
  }
  const abortBridge = () => { void close().catch(() => {}) }
  options.signal?.addEventListener('abort', abortBridge, { once: true })
  try {
    if (options.signal?.aborted) throw new Error('mcp_bridge_closed')
    for (const spec of specs) {
      if (!active) throw new Error('mcp_bridge_closed')
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
      const child = (options.spawn ?? nodeSpawn)(spec.command, spec.args, {
        cwd: options.cwd, env: Object.fromEntries(spec.env.map(e => [e.name, e.value])),
        stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true,
      })
      let ended = false
      const pending = new Map<RequestId, string>()
      const notifications: JSONRPCMessage[] = []
      let queuedBytes = 0
      const entry = { child, transport, hasExited: () => ended, getStream: undefined as ServerResponse | undefined, flush: () => {
        while (notifications.length && active && (entry.getStream || pending.size)) {
          const message = notifications.shift()!
          queuedBytes -= Buffer.byteLength(serializeMessage(message))
          const relatedRequestId = entry.getStream ? undefined : pending.keys().next().value
          void transport.send(message, { relatedRequestId }).catch(fail)
        }
      } }
      entries.push(entry)
      const started = new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', () => reject(new Error('mcp_process_start_failed')))
      })
      child.once('exit', () => { ended = true; fail() })
      child.once('error', () => { ended = true; fail() })
      child.stderr?.resume() // Drain without retaining/logging potentially private server diagnostics.
      let buffer = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('end', fail)
      child.stdout?.on('error', fail)
      child.stdout?.on('data', chunk => {
        buffer += String(chunk)
        while (active && buffer.includes('\n')) {
          const end = buffer.indexOf('\n'), line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) { fail(); return }
          try {
            const message = deserializeMessage(line)
            const response = 'id' in message && !('method' in message)
            if (response) {
              if (message.id !== undefined && pending.get(message.id) === 'tools/list' && 'result' in message && Array.isArray(message.result.tools)) {
                for (const tool of message.result.tools) {
                  if (tool && typeof tool.name === 'string') toolTitles.add(`${spec.name}__${tool.name}`)
                }
              }
              void transport.send(message).catch(fail)
              if (message.id !== undefined) pending.delete(message.id)
            } else {
              notifications.push(message)
              queuedBytes += Buffer.byteLength(serializeMessage(message))
              if (notifications.length > 100 || queuedBytes > 4 * 1024 * 1024) { fail(); return }
              entry.flush()
            }
          } catch { fail(); return }
        }
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) fail()
      })
      transport.onmessage = message => {
        if (!active || ended || !child.stdin?.writable) { fail(); return }
        if ('method' in message && 'id' in message && message.id !== undefined) pending.set(message.id, message.method)
        entry.flush()
        try { child.stdin.write(serializeMessage(message), error => { if (error) fail() }) } catch { fail() }
      }
      transport.onclose = () => { if (active) fail() }
      child.stdin?.on('error', fail)
      transport.onerror = () => {
        // The SDK also reports request-level 4xx here; it already answered that request.
        if (!active || requestErrorLogged) return
        requestErrorLogged = true
        options.log?.('MCP', 'Grok MCP request error (recoverable)')
      }
      await transport.start()
      await started
      if (!active || ended) throw new Error('mcp_process_exited')
    }
    if (!active) throw new Error('mcp_bridge_closed')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    if (!active) throw new Error('mcp_bridge_closed')
    server.on('error', fail)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mcp_listen_failed')
    return {
      processGroups: () => entries.flatMap(e => e.child.pid ? [e.child.pid] : []),
      hasTool: title => active && toolTitles.has(title),
      get active() { return active }, close, redact: text => text.replaceAll(token, '[redacted]'),
      createTextRedactor: () => {
        let held = ''
        return (chunk, final = false) => {
          const text = (held + chunk).replaceAll(token, '[redacted]')
          let length = 0
          if (!final) for (let i = 1; i < token.length; i++) { if (text.endsWith(token.slice(0, i))) length = i }
          held = length ? text.slice(-length) : ''
          return length ? text.slice(0, -length) : text
        }
      },
      servers: specs.map((spec, i) => ({ type: 'http', name: spec.name, url: `http://127.0.0.1:${address.port}/mcp/${i}`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] })),
    }
  } catch {
    await close()
    throw new Error('mcp_bridge_start_failed')
  }
}
