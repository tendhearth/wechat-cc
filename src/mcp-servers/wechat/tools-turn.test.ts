/**
 * 回复交付(spec 2026-10-03 §4.5 / §4.6):daemon 模式的 provider 不再有 reply 族工具 ——
 * 话写在最后;语音 / 表情 / 文件是本轮附件(不带 chat_id);admin 才有往别处发的 message。
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTurnTools } from './tools-turn'
import { registerMessagingTools } from './tools-messaging'
import type { InternalApiClient } from './client'

type Call = { method: string; path: string; body?: unknown }

async function harness(register: (s: McpServer, c: InternalApiClient) => void) {
  const calls: Call[] = []
  const api: InternalApiClient = { async request(method, path, body) { calls.push({ method, path, body }); return { ok: true, attached: true } as never } }
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
  register(server, api)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(a), mcp.connect(b)])
  const names = async () => (await mcp.listTools()).tools.map(t => t.name).sort()
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args }) as { content: Array<{ text: string }> }
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  }
  return { calls, names, call, mcp }
}

describe('registerMessagingTools({ replyDelivery: daemon }) —— 回复族工具全部不注册', () => {
  it('只留下不说话的表情查询与反馈', async () => {
    const h = await harness((s, c) => registerMessagingTools(s, c, { replyDelivery: 'daemon' }))
    expect(await h.names()).toEqual(['search_online_sticker_candidates', 'sticker_feedback'])
  })

  it('缺省仍是今天的工具表(legacy 不变)', async () => {
    const h = await harness((s, c) => registerMessagingTools(s, c))
    expect(await h.names()).toContain('reply')
    expect(await h.names()).toContain('reply_voice')
  })
})

describe('registerTurnTools', () => {
  it('非 admin:voice / sticker / attach_file,没有 message', async () => {
    const h = await harness((s, c) => registerTurnTools(s, c, { admin: false }))
    expect(await h.names()).toEqual(['attach_file', 'sticker', 'voice'])
  })

  it('admin 才有 message', async () => {
    const h = await harness((s, c) => registerTurnTools(s, c, { admin: true }))
    expect(await h.names()).toEqual(['attach_file', 'message', 'sticker', 'voice'])
  })

  it('附件工具不带 chat_id:voice → POST /v1/turn/attach {kind:voice,text}', async () => {
    const h = await harness((s, c) => registerTurnTools(s, c, { admin: false }))
    const tools = (await h.mcp.listTools()).tools
    for (const t of tools) expect(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})).not.toContain('chat_id')
    expect(await h.call('voice', { text: '晚安' })).toEqual({ ok: true, attached: true })
    expect(h.calls).toEqual([{ method: 'POST', path: '/v1/turn/attach', body: { kind: 'voice', text: '晚安' } }])
  })

  it('sticker / attach_file 原样带参数', async () => {
    const h = await harness((s, c) => registerTurnTools(s, c, { admin: false }))
    await h.call('sticker', { tag: '庆祝' })
    await h.call('sticker', { mood: '开心', id: 'g1', url: 'https://media.giphy.com/x.gif' })
    await h.call('attach_file', { path: '/tmp/a.pdf' })
    expect(h.calls.map(c => c.body)).toEqual([
      { kind: 'sticker', tag: '庆祝' },
      { kind: 'sticker', mood: '开心', id: 'g1', url: 'https://media.giphy.com/x.gif' },
      { kind: 'file', path: '/tmp/a.pdf' },
    ])
  })

  it('message → POST /v1/wechat/message {to,text}', async () => {
    const h = await harness((s, c) => registerTurnTools(s, c, { admin: true }))
    await h.call('message', { to: 'owner', text: '也在微信上告诉你一声' })
    expect(h.calls).toEqual([{ method: 'POST', path: '/v1/wechat/message', body: { to: 'owner', text: '也在微信上告诉你一声' } }])
  })
})
