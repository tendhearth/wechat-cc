import { describe, expect, it } from 'vitest'
import { createProviderRegistry } from './provider-registry'
import { errorWithProviderCode } from '../lib/provider-error-code'
import type { AgentProvider } from './agent-provider'

// 2026-10-23 真机:回忆每次收工都去问 agy,两天 28 次全是「not currently available in your location」。
// 被服务方拒绝 ≠ 坏了:指数退避(1h → 2h → … 24h),被拒期间一次都不调,成功一次清零。
const H = 3_600_000
const region = () => errorWithProviderCode('agy result status=ERROR: Eligibility check failed … not currently available in your location', 'region_unavailable')

function withCheap(fn: () => Promise<string>): { p: AgentProvider; calls: () => number } {
  let n = 0
  const p = { async spawn() { throw new Error('unused') }, cheapEval: async () => { n++; return fn() } } as unknown as AgentProvider
  return { p, calls: () => n }
}

describe('cheapEval:被服务方拒绝 ⇒ 指数退避', () => {
  it('只有一家(单候选路径):被拒后 1 小时内不再调;到点再试还被拒 ⇒ 2 小时', async () => {
    let t = 0
    const r = createProviderRegistry({ now: () => t })
    const agy = withCheap(async () => { throw region() })
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    const ev = r.getCheapEval()!
    await expect(ev('x')).rejects.toThrow(/location/)
    expect(agy.calls()).toBe(1)
    t = 0.9 * H
    await expect(ev('x')).rejects.toThrow(/region_unavailable/)
    expect(agy.calls()).toBe(1) // 没调
    t = 1.1 * H
    await expect(ev('x')).rejects.toThrow(/location/)
    expect(agy.calls()).toBe(2)
    t = 1.1 * H + 1.9 * H
    await expect(ev('x')).rejects.toThrow(/region_unavailable/)
    expect(agy.calls()).toBe(2)
    t = 1.1 * H + 2.1 * H
    await ev('x').catch(() => {})
    expect(agy.calls()).toBe(3)
  })

  it('成功一次清零:出口换了以后照常用', async () => {
    let t = 0
    let refuse = true
    const r = createProviderRegistry({ now: () => t })
    const agy = withCheap(async () => { if (refuse) throw region(); return 'ok' })
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    const ev = r.getCheapEval()!
    await ev('x').catch(() => {})
    t = 1.1 * H; refuse = false
    await expect(ev('x')).resolves.toBe('ok')
    refuse = true
    await ev('x').catch(() => {})
    t = 1.1 * H + 1.1 * H // 清零后再被拒:重新从 1 小时算
    await ev('x').catch(() => {})
    expect(agy.calls()).toBe(4)
  })

  it('多家:被拒的那家跳过,换下一家;不进「大家都在冷却就先试第一个」的兜底', async () => {
    const t = 0
    const r = createProviderRegistry({ now: () => t })
    const agy = withCheap(async () => { throw region() })
    const claude = withCheap(async () => 'claude-ok')
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    r.register('claude', claude.p, { displayName: 'claude', canResume: () => false })
    const ev = r.getCheapEval()!
    await expect(ev('x')).resolves.toBe('claude-ok')
    await expect(ev('x')).resolves.toBe('claude-ok')
    expect(agy.calls()).toBe(1)
    expect(claude.calls()).toBe(2)
  })

  it('多家都被拒 ⇒ 照实抛被拒,一家都不调', async () => {
    const r = createProviderRegistry({ now: () => 0 })
    const agy = withCheap(async () => { throw region() })
    const gem = withCheap(async () => { throw region() })
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    r.register('gemini', gem.p, { displayName: 'gemini', canResume: () => false })
    const ev = r.getCheapEval()!
    await ev('x').catch(() => {})
    const before = agy.calls() + gem.calls()
    await expect(ev('x')).rejects.toThrow(/region_unavailable/)
    expect(agy.calls() + gem.calls()).toBe(before)
  })

  it('钉死的那家(/set cheap agy)也看被拒', async () => {
    let t = 0
    const r = createProviderRegistry({ now: () => t, cheapEvalProvider: 'agy' })
    const agy = withCheap(async () => { throw region() })
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    r.register('claude', withCheap(async () => 'c').p, { displayName: 'claude', canResume: () => false })
    const ev = r.getCheapEval()!
    await ev('x').catch(() => {})
    t = 0.5 * H
    await expect(ev('x')).rejects.toThrow(/region_unavailable/)
    expect(agy.calls()).toBe(1)
  })

  it('普通失败(不是被拒)照旧走 10 分钟冷却,不受影响', async () => {
    let t = 0
    const r = createProviderRegistry({ now: () => t })
    const agy = withCheap(async () => { throw new Error('boom') })
    r.register('agy', agy.p, { displayName: 'agy', canResume: () => false })
    const ev = r.getCheapEval()!
    await ev('x').catch(() => {})
    t = 60_000
    await ev('x').catch(() => {})
    expect(agy.calls()).toBe(2) // 单候选路径本来就不看冷却 —— 行为不变
  })
})
