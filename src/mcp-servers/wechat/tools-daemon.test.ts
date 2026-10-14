/**
 * terminal_sessions(2026-10-14):CC 自己的只读工具,与微信「终端」同一份列表、同一套措辞。
 * 注册门(只给 admin 会话)在 integration.test.ts;分级(daemon_introspect)在 user-tier.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerDaemonTools } from './tools-daemon'
import { InternalApiError, type InternalApiClient } from './client'

async function harness(respond: (method: string, path: string) => unknown) {
  const calls: string[] = []
  const api: InternalApiClient = { async request(method, path) { calls.push(`${method} ${path}`); return respond(method, path) as never } }
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
  registerDaemonTools(server, api)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(a), mcp.connect(b)])
  const call = async (args: Record<string, unknown> = {}) => {
    const res = await mcp.callTool({ name: 'terminal_sessions', arguments: args }) as { content: Array<{ text: string }> }
    return res.content[0]!.text
  }
  return { calls, call, mcp }
}

const now = Date.now()
const row = (i: number, over: Record<string, unknown> = {}) => ({
  session_id: `s${i}-full`, code: `s${i}`, source: 'codex', status: 'idle', stale: false, project: `p${i}`, cwd: `/w/p${i}`,
  machine: null, origin_agent: null, last_summary: `第 ${i} 个做完了`, last_event_at: now - (i + 1) * 60_000, last_prompt_at: null, created_at: now - 3_600_000, pending: null, ...over,
})

describe('terminal_sessions', () => {
  it('读 GET /v1/cli/sessions,回与微信「终端」同样的纯文本;等批准的带怎么回', async () => {
    const h = await harness(() => ({ ok: true, sessions: [
      row(0, { source: 'claude', status: 'waiting', last_summary: null, pending: { tool: 'Bash', summary: 'npm publish', since: now - 60_000, hash: 'k3x9z', reply_code: '07' } }),
      row(1),
    ] }))
    expect((await h.mcp.listTools()).tools.map(t => t.name)).toContain('terminal_sessions')
    const text = await h.call()
    expect(h.calls).toEqual(['GET /v1/cli/sessions?limit=50'])
    expect(text).toContain('✋ 等你批准 · p0 · Claude Code · 码 s0')
    expect(text).toContain('回「y 07」放行')
    expect(text).toContain('· 做完了 · p1 · Codex · 码 s1')
    expect(text).toContain('第 1 个做完了')
  })

  it('limit 控制条数;默认 8', async () => {
    const h = await harness(() => ({ ok: true, sessions: Array.from({ length: 12 }, (_, i) => row(i)) }))
    expect(await h.call()).toContain('(还有 4 个没列出)')
    expect(await h.call({ limit: 3 })).toContain('(还有 9 个没列出)')
  })

  it('daemon 报错 ⇒ 结构化错误,不抛', async () => {
    const h = await harness(() => { throw new InternalApiError('not wired', 503, '/v1/cli/sessions', { error: 'cli_sessions_not_wired' }) })
    const text = await h.call()
    expect(JSON.parse(text).error).toContain('503')
  })
})
