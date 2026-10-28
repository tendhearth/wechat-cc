import { describe, it, expect } from 'vitest'
import { PHONE_CALLS, makePhoneApi, phoneCallRequest, toProtocolRequest, type PhoneCallRequest } from './phone-calls'
import { PHONE_API_SCHEMAS } from './api'
import { ROUTES } from './routes'

const specs = Object.entries(PHONE_CALLS).flatMap(([ns, ms]) => Object.entries(ms).map(([m, s]) => ({ name: `${ns}.${m}`, key: s.key as string })))

describe('PHONE_CALLS(类型化客户端的表)', () => {
  it('每条都在路由表里、都有返回形状;一个键只登记一次', () => {
    for (const s of specs) {
      expect(ROUTES[s.key as keyof typeof ROUTES], s.name).toBeDefined()
      expect(PHONE_API_SCHEMAS[s.key], s.name).toBeDefined()
    }
    const keys = specs.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('查询串与搬家前手写的逐字一致:按给的顺序、undefined 不带、字符串编码、数字原样', () => {
    const path = (r: PhoneCallRequest) => r.path
    expect(path(phoneCallRequest(PHONE_CALLS.matters.list))).toBe('/m/api/matters')
    expect(path(phoneCallRequest(PHONE_CALLS.matters.inputReceipt, { query: { id: 'a b', requestId: 'r/1' } })))
      .toBe(`/m/api/matter/input-receipt?id=${encodeURIComponent('a b')}&requestId=${encodeURIComponent('r/1')}`)
    expect(path(phoneCallRequest(PHONE_CALLS.chat.page, { query: { before: undefined, limit: undefined } }))).toBe('/m/api/chat')
    expect(path(phoneCallRequest(PHONE_CALLS.chat.page, { query: { before: 'x', limit: 5 } }))).toBe('/m/api/chat?before=x&limit=5')
    expect(path(phoneCallRequest(PHONE_CALLS.chat.file, { query: { id: 'm&1', i: 2, offset: 131072 } }))).toBe('/m/api/chat/file?id=m%261&i=2&offset=131072')
    expect(path(phoneCallRequest(PHONE_CALLS.sessions.list, { query: { provider: 'codex', cursor: undefined, q: '' } }))).toBe('/m/api/sessions?provider=codex&q=')
    expect(path(phoneCallRequest(PHONE_CALLS.stickers.get, { suffix: 'a b.png', query: { b64: 1 } }))).toBe('/m/api/sticker/a%20b.png?b64=1')
    expect(path(phoneCallRequest(PHONE_CALLS.home.get, { query: { limit: 20 } }))).toBe('/m/api/home?limit=20')
  })

  it('方法从键里取;正文、retry 原样交给传输;协议请求带 JSON 头', () => {
    const r = phoneCallRequest(PHONE_CALLS.matters.stop, { body: { id: 'm', runId: 'r' }, retry: false })
    expect(r).toEqual({ key: 'POST /m/api/matter/stop', method: 'POST', path: '/m/api/matter/stop', body: { id: 'm', runId: 'r' }, retry: false })
    expect(toProtocolRequest(r)).toEqual({ method: 'POST', path: '/m/api/matter/stop', body: '{"id":"m","runId":"r"}', headers: { 'content-type': 'application/json' }, retry: false })
    expect(toProtocolRequest(phoneCallRequest(PHONE_CALLS.set.state))).toEqual({ method: 'GET', path: '/set/api/state' })
  })

  it('makePhoneApi:每个命名空间.方法都接到同一个传输上', async () => {
    const seen: PhoneCallRequest[] = []
    const api = makePhoneApi(async req => { seen.push(req); return { ok: true, matters: [] } })
    expect(await api.matters.list()).toEqual({ ok: true, matters: [] })
    await api.matters.get({ query: { id: 'x' } })
    expect(seen.map(s => `${s.key} ${s.path}`)).toEqual(['GET /m/api/matters /m/api/matters', 'GET /m/api/matter /m/api/matter?id=x'])
    for (const s of specs) {
      const [ns, m] = s.name.split('.') as [keyof typeof api, string]
      expect(typeof (api[ns] as Record<string, unknown>)[m], s.name).toBe('function')
    }
  })
})
