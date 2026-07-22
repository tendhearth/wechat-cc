import { describe, it, expect, vi } from 'vitest'
import { penpalRoutes } from './routes-penpal'
import type { InternalApiDeps } from './types'

const CH_OPEN = { id: 'ch1', seek_id: 's1', status: 'open', degree: 1, peer_agent_id: 'buddy', relay_via: null }
const CH_RELAY = { id: 'ch2', seek_id: 's2', status: 'open', degree: 2, peer_agent_id: null, relay_via: 'w' }
const CH_PENDING = { id: 'ch3', seek_id: 's3', status: 'pending', degree: 1, peer_agent_id: 'x', relay_via: null }
const L_IN = { id: 'l1', channel_id: 'ch1', direction: 'in', sealed_ciphertext: 'CT', nonce: 'N', tag: 'T', plaintext: '你好呀', created_at: '2026-07-22T00:00:00.000Z', read_at: null }

function makeDeps(over: Record<string, unknown> = {}) {
  const letterStore = {
    listForChannel: vi.fn(() => [L_IN]),
    unreadCountByChannel: vi.fn(() => [{ channel_id: 'ch1', n: 1 }]),
    markAllRead: vi.fn(),
  }
  const channelStore = {
    list: vi.fn(() => [CH_OPEN, CH_RELAY, CH_PENDING]),
    get: vi.fn((id: string) => [CH_OPEN, CH_RELAY, CH_PENDING].find(c => c.id === id) ?? null),
  }
  const sendLetter = vi.fn(async () => ({ ok: true }))
  const deps = {
    social: {
      penpal: { sendLetter, channelStore, letterStore },
      seekStore: { get: vi.fn((id: string) => id === 's1' ? { id: 's1', topic: '找修相机师傅' } : null) },
    },
    a2a: { registry: { get: vi.fn((id: string) => id === 'buddy' ? { id: 'buddy', name: '老王的CC' } : null) } },
    ...over,
  } as unknown as InternalApiDeps
  return { deps, letterStore, channelStore, sendLetter }
}
const q = (s = '') => new URLSearchParams(s)

describe('GET /v1/penpal/channels', () => {
  it('未接线 → 503 penpal_not_wired', async () => {
    const r = await penpalRoutes({ social: undefined } as unknown as InternalApiDeps)['GET /v1/penpal/channels']!(q(), undefined)
    expect(r.status).toBe(503)
    expect((r.body as any).error).toBe('penpal_not_wired')
  })
  it('只列 open 信道;直连查 registry 名、中转标第N度;带 unread/title/last_preview', async () => {
    const { deps } = makeDeps()
    const r = await penpalRoutes(deps)['GET /v1/penpal/channels']!(q(), undefined)
    expect(r.status).toBe(200)
    const chans = (r.body as any).channels
    expect(chans.map((c: any) => c.id)).toEqual(['ch1', 'ch2'])     // pending 不列
    expect(chans[0]).toMatchObject({ title: '找修相机师傅', peer_label: '老王的CC', unread: 1, last_preview: '你好呀' })
    expect(chans[1]).toMatchObject({ title: '', peer_label: '第2度笔友', unread: 0 })
  })
})

describe('GET /v1/penpal/letters', () => {
  it('owner 投影:密文字段绝不出现', async () => {
    const { deps } = makeDeps()
    const r = await penpalRoutes(deps)['GET /v1/penpal/letters']!(q('channel_id=ch1'), undefined)
    expect(r.status).toBe(200)
    const letters = (r.body as any).letters
    expect(letters[0]).toEqual({ id: 'l1', direction: 'in', plaintext: '你好呀', created_at: '2026-07-22T00:00:00.000Z', read_at: null })
    const raw = JSON.stringify(r.body)
    expect(raw).not.toContain('sealed_ciphertext'); expect(raw).not.toContain('nonce'); expect(raw).not.toContain('"tag"'); expect(raw).not.toContain('CT')
  })
  it('缺 channel_id → 400;未知 channel → 404', async () => {
    const { deps } = makeDeps()
    expect((await penpalRoutes(deps)['GET /v1/penpal/letters']!(q(), undefined)).status).toBe(400)
    expect((await penpalRoutes(deps)['GET /v1/penpal/letters']!(q('channel_id=nope'), undefined)).status).toBe(404)
  })
})

describe('POST /v1/penpal/letters', () => {
  it('透传 sendLetter;缺参 400', async () => {
    const { deps, sendLetter } = makeDeps()
    const r = await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { channel_id: 'ch1', text: '回信内容' })
    expect(r.status).toBe(200); expect((r.body as any).ok).toBe(true)
    expect(sendLetter).toHaveBeenCalledWith('ch1', '回信内容')
    expect((await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { text: 'x' })).status).toBe(400)
    expect((await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { channel_id: 'ch1' })).status).toBe(400)
  })
})

describe('POST /v1/penpal/letters/read', () => {
  it('markAllRead 被调,幂等 ok:true', async () => {
    const { deps, letterStore } = makeDeps()
    const r = await penpalRoutes(deps)['POST /v1/penpal/letters/read']!(q(), { channel_id: 'ch1' })
    expect(r.status).toBe(200); expect((r.body as any).ok).toBe(true)
    expect(letterStore.markAllRead).toHaveBeenCalledWith('ch1', expect.any(String))
  })
})
