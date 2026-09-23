/**
 * 社交工具面(spec 2026-09-05-social-tools §1):十个工具只是 internal API
 * 的薄壳 —— 这里断言的是「打对路由 + body 形状 + 路由 JSON 原样回给模型」,
 * 不断言任何中文文案(文案是模型的活)。走 InMemoryTransport 起真的
 * McpServer,和 federated-source.test.ts 同一套。
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerSocialTools } from './tools-social'
import { InternalApiError, type InternalApiClient } from './client'

type Call = { method: string; path: string; body?: unknown }

function fakeClient(routes: Record<string, unknown>): { client: InternalApiClient; calls: Call[] } {
  const calls: Call[] = []
  const client: InternalApiClient = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      const r = routes[`${method} ${path}`]
      if (r instanceof Error) throw r
      if (r === undefined) throw new InternalApiError(`no fixture for ${method} ${path}`, 404, path, { error: 'not_found' })
      return r as never
    },
  }
  return { client, calls }
}

async function harness(routes: Record<string, unknown>) {
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
  const { client: api, calls } = fakeClient(routes)
  registerSocialTools(server, api)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), mcp.connect(clientT)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }> }
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  }
  return { mcp, calls, call }
}

const TEN = ['social_seek', 'wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit']

describe('registerSocialTools', () => {
  it('registers exactly the ten social tools', async () => {
    const { mcp } = await harness({})
    const names = (await mcp.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual([...TEN].sort())
  })

  it('wish_list → GET /v1/social/wishes, route JSON returned verbatim', async () => {
    const fixture = { wishes: [{ id: 'w1', text: '找搭子', status: 'open', postcards: [{ reply_id: 'ab12cd34', via_label: '阿A', preview: '我朋友常去', at: 't', requested: false }] }] }
    const { calls, call } = await harness({ 'GET /v1/social/wishes': fixture })
    expect(await call('wish_list')).toEqual(fixture)
    expect(calls).toEqual([{ method: 'GET', path: '/v1/social/wishes', body: undefined }])
  })

  it('wish_send / wish_cancel post { id } from ref', async () => {
    const { calls, call } = await harness({
      'POST /v1/social/wish/send': { ok: true, sent_to: 2 },
      'POST /v1/social/wish/cancel': { ok: true, status: 'cancelled' },
    })
    expect(await call('wish_send', { ref: 'w1' })).toEqual({ ok: true, sent_to: 2 })
    expect(await call('wish_cancel', { ref: 'w1' })).toEqual({ ok: true, status: 'cancelled' })
    expect(calls.map(c => [c.path, c.body])).toEqual([
      ['/v1/social/wish/send', { id: 'w1' }],
      ['/v1/social/wish/cancel', { id: 'w1' }],
    ])
  })

  it('intro_request / intro_accept / intro_decline post { reply_id } from reply_ref', async () => {
    const { calls, call } = await harness({
      'POST /v1/social/intro/request': { ok: true, reply_id: 'ab12cd34' },
      'POST /v1/social/intro/accept': { ok: true, reply_id: 'ab12cd34' },
      'POST /v1/social/intro/decline': { ok: false, reason: 'not_found' },
    })
    expect(await call('intro_request', { reply_ref: 'ab' })).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect(await call('intro_accept', { reply_ref: 'ab12' })).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect(await call('intro_decline', { reply_ref: 'zz' })).toEqual({ ok: false, reason: 'not_found' })
    expect(calls.map(c => [c.path, c.body])).toEqual([
      ['/v1/social/intro/request', { reply_id: 'ab' }],
      ['/v1/social/intro/accept', { reply_id: 'ab12' }],
      ['/v1/social/intro/decline', { reply_id: 'zz' }],
    ])
  })

  it('intro_offers / relationships are plain GETs returned verbatim', async () => {
    const offers = { offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] }
    const rels = [{ id: 'peer:cc-1', kind: 'peer', label: '阿A', origin: '配对' }]
    const { calls, call } = await harness({ 'GET /v1/social/intro/offers': offers, 'GET /v1/social/relationships': rels })
    expect(await call('intro_offers')).toEqual(offers)
    expect(await call('relationships')).toEqual(rels)
    expect(calls.map(c => c.path)).toEqual(['/v1/social/intro/offers', '/v1/social/relationships'])
  })

  it('visit posts {} without target and { target } with one', async () => {
    const { calls, call } = await harness({ 'POST /v1/social/visit': { ok: true, started: true } })
    await call('visit')
    await call('visit', { target: '阿A' })
    expect(calls.map(c => c.body)).toEqual([{}, { target: '阿A' }])
  })

  it('a 503 from the route becomes a structured error text, never an MCP exception', async () => {
    const { call } = await harness({
      'POST /v1/social/intro/request': new InternalApiError('503', 503, '/v1/social/intro/request', { error: 'social_not_wired' }),
    })
    const r = await call('intro_request', { reply_ref: 'ab' })
    expect(String(r.error)).toContain('503')
    expect(String(r.error)).toContain('social_not_wired')
  })

  it('social_seek is unchanged: proposes via POST /v1/social/wish and adds the hint', async () => {
    const { calls, call } = await harness({ 'POST /v1/social/wish': { ok: true, id: 'w9', preview: '想找周末爬山的朋友' } })
    const r = await call('social_seek', { topic: '周末爬山搭子', city: '北京' })
    expect(r).toMatchObject({ ok: true, id: 'w9', preview: '想找周末爬山的朋友' })
    expect(String(r.hint)).toContain('派 w9')
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/social/wish', body: { text: '周末爬山搭子(北京)' } })
  })

  it('rejects a one-character ref at the schema layer (server prefix match needs ≥2)', async () => {
    const { mcp, calls } = await harness({})
    // SDK 版本不同,参数校验失败可能是 isError 结果也可能是 JSON-RPC 错误;两种都算拒绝。
    let rejected = false
    try {
      const res = await mcp.callTool({ name: 'intro_request', arguments: { reply_ref: 'a' } }) as { isError?: boolean }
      rejected = res.isError === true
    } catch { rejected = true }
    expect(rejected).toBe(true)
    expect(calls).toEqual([])   // 没打到 internal API
  })
})
