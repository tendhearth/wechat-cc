import { describe, it, expect, vi } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { ipLimited, IP_LIMIT_RETRY_AFTER_S } from '../src/ip-limit'

const req = (ip?: string) => new Request('https://relay.test/v2/phone?id=x', { headers: ip ? { 'cf-connecting-ip': ip } : {} })
const fakeEnv = (limit: RateLimit['limit'], extra: Partial<Env> = {}) => ({ IP_LIMIT: { limit }, ...extra }) as unknown as Env

describe('ipLimited(按 IP 限连接尝试,spec §6)', () => {
  it('没绑 IP_LIMIT ⇒ 不限', async () => {
    expect(await ipLimited(req('203.0.113.1'), {} as Env)).toBeNull()
  })
  it('没有 CF-Connecting-IP ⇒ 不限,也不调绑定', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    expect(await ipLimited(req(), fakeEnv(limit))).toBeNull()
    expect(limit).not.toHaveBeenCalled()
  })
  it('按 CF-Connecting-IP 计数;放行 ⇒ null', async () => {
    const limit = vi.fn(async () => ({ success: true }))
    expect(await ipLimited(req('203.0.113.2'), fakeEnv(limit))).toBeNull()
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.2' })
  })
  it('超限 ⇒ 429 + Retry-After + 小 JSON,只记不带标识的计数', async () => {
    const points: unknown[] = []
    const METRICS = { writeDataPoint: (p: unknown) => points.push(p) } as unknown as AnalyticsEngineDataset
    const r = await ipLimited(req('203.0.113.3'), fakeEnv(async () => ({ success: false }), { METRICS }))
    expect(r?.status).toBe(429)
    expect(r?.headers.get('retry-after')).toBe(String(IP_LIMIT_RETRY_AFTER_S))
    expect(await r?.json()).toEqual({ error: 'rate_limited' })
    expect(points).toEqual([{ blobs: ['ip_rate_limited'], doubles: [1] }])
    expect(JSON.stringify(points)).not.toContain('203.0.113.3')
  })
  it('绑定出错 ⇒ 放行(限速挂了不拖垮中继)', async () => {
    expect(await ipLimited(req('203.0.113.4'), fakeEnv(async () => { throw new Error('boom') }))).toBeNull()
  })
})

describe('入口 Worker 上的 IP 限速(测试绑定:3 次 / 10 秒)', () => {
  it('测试环境确实绑了 IP_LIMIT', () => {
    expect(env.IP_LIMIT).toBeDefined()
  })
  it('同一 IP 打 /v2/ 超限 ⇒ 429;别的 IP 不受连累', async () => {
    const hit = (ip: string) => SELF.fetch('https://relay.test/v2/phone', { headers: { 'cf-connecting-ip': ip } })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await hit('198.51.100.7')).status)
    // 前几次照常走到路由(不是升级 ⇒ 426),之后 429。计数是机房本地、最终一致的,不卡死确切次数。
    expect(statuses[0]).toBe(426)
    expect(statuses.at(-1)).toBe(429)
    const r = await hit('198.51.100.7')
    expect(r.headers.get('retry-after')).toBe(String(IP_LIMIT_RETRY_AFTER_S))
    expect(await r.json()).toEqual({ error: 'rate_limited' })
    expect((await hit('198.51.100.8')).status).toBe(426)
  })
  it('只管 /v2/:/healthz、/pset/ 同一 IP 打多少次都不限', async () => {
    const h = { 'cf-connecting-ip': '198.51.100.9' }
    for (let i = 0; i < 6; i++) {
      expect((await SELF.fetch('https://relay.test/healthz', { headers: h })).status).toBe(200)
      expect((await SELF.fetch('https://relay.test/pset/', { headers: h })).status).toBe(200)
    }
  })
})
