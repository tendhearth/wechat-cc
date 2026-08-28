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
