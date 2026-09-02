import { describe, expect, it, vi } from 'vitest'
import { gateOutbound, GATE_TIMEOUT_MS } from './a2a-disclosure'

const policy = '可透露:兴趣爱好、大致意向、所在城市。不透露:住址、收入、健康、第三方好友。'

describe('gateOutbound', () => {
  it('fails CLOSED (checker_timeout) when the checker hangs past the timeout', async () => {
    vi.useFakeTimers()
    try {
      const cheapEval = () => new Promise<string>(() => {})   // 永不返回,模拟坏网/慢 provider
      const p = gateOutbound('随便什么', { policy, cheapEval })
      await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS + 10)
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.violations).toContain('checker_timeout')   // 不再无限等
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes clean, policy-compliant text unchanged', async () => {
    const cheapEval = async () => JSON.stringify({ violation: false, redacted: '我主人也爱摄影,周末常拍' })
    const r = await gateOutbound('我主人也爱摄影,周末常拍', { policy, cheapEval })
    expect(r.ok).toBe(true)
    expect(r.redacted).toContain('摄影')
  })
  it('blocks/redacts a forbidden disclosure (home address)', async () => {
    const cheapEval = async () => JSON.stringify({ violation: true, redacted: '我主人也爱摄影', reasons: ['泄露住址'] })
    const r = await gateOutbound('我主人住玄武区XX路12号,爱摄影', { policy, cheapEval })
    expect(r.ok).toBe(false)
    expect(r.redacted).not.toContain('XX路')
    expect(r.violations.length).toBeGreaterThan(0)
  })
  it('fails CLOSED when the checker returns unparseable output', async () => {
    const cheapEval = async () => 'not json at all'
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker throws', async () => {
    const cheapEval = async () => { throw new Error('model down') }
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker returns an empty object (missing violation field)', async () => {
    const cheapEval = async () => '{}'
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when violation is a string, not a boolean', async () => {
    const cheapEval = async () => JSON.stringify({ violation: 'true', redacted: 'x' })
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when violation is a number, not a boolean', async () => {
    const cheapEval = async () => JSON.stringify({ violation: 1 })
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker returns a bare JSON primitive (true)', async () => {
    const cheapEval = async () => 'true'
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker returns bare JSON null, without throwing', async () => {
    const cheapEval = async () => 'null'
    const r = await gateOutbound('anything', { policy, cheapEval })
    expect(r.ok).toBe(false)
  })
})

// 2026-09-01,真机实测:agy 的 cheapEval 单次 10.3–14.3s(gemini-3.7-flash-low,
// CLI 冷启动),并发跑话题+城市两闸门时墙钟 12.66s —— 而 GATE_TIMEOUT_MS 是
// 12s。于是派心愿**时灵时不灵**地报 checker_unavailable,看起来像随机故障。
//
// 一个写死的常数没法同时服务 in-process(约 1s)和 CLI 冷启动(10-20s)两档。
// 闸门的超时必须由**实际会跑的 provider** 说了算。
describe('gateOutbound —— 超时由调用方按 provider 的实际延迟给', () => {
  it('默认仍是 GATE_TIMEOUT_MS(不改既有行为)', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<string>(() => {})
      const p = gateOutbound('x', { policy: 'p', cheapEval: () => never })
      await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS + 1)
      expect(await p).toEqual({ ok: false, redacted: '', violations: ['checker_timeout'] })
    } finally { vi.useRealTimers() }
  })

  it('给了 timeoutMs 就用它 —— 慢 provider 不再被自己的闸门掐死', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (s: string) => void
      const slow = new Promise<string>(r => { resolve = r })
      const p = gateOutbound('上海', { policy: 'p', cheapEval: () => slow, timeoutMs: 30_000 })
      // 走到 12s(旧常数)时不该超时
      await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS + 1)
      resolve('{"violation": false, "redacted": "上海", "reasons": []}')
      await vi.advanceTimersByTimeAsync(0)
      expect(await p).toEqual({ ok: true, redacted: '上海', violations: [] })
    } finally { vi.useRealTimers() }
  })
})
