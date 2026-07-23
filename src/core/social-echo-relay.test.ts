import { describe, it, expect, vi } from 'vitest'
import { makeEchoHandler } from './social-echo-relay'

const msg = (over: Record<string, unknown> = {}) => ({ agent_id: 'cc-q', intent_id: 'i1', echo: { blurb: '二度有回音', degree: 2 }, ...over }) as any

function make(over: Record<string, any> = {}) {
  const deps = {
    intake: vi.fn(() => 'unknown' as const),
    originOf: vi.fn(() => 'cc-s' as string | null),
    recordRelay: vi.fn(() => 'tok9'),
    postEcho: vi.fn(async () => true),
    ...over,
  }
  return { onEcho: makeEchoHandler(deps), deps }
}

describe('makeEchoHandler', () => {
  it('自己的 seek:intake recorded → 不走中继', async () => {
    const { onEcho, deps } = make({ intake: vi.fn(() => 'recorded' as const) })
    expect(await onEcho('ccb', msg())).toEqual({ ok: true })
    expect(deps.recordRelay).not.toHaveBeenCalled()
  })
  it('转发过的 intent:铸 relay(upstream=origin, downstream=sender)并转投 origin,degree 透传 + relay_token', async () => {
    const { onEcho, deps } = make()
    expect(await onEcho('cc-q', msg())).toEqual({ ok: true })
    expect(deps.recordRelay).toHaveBeenCalledWith('i1', 'cc-s', 'cc-q')
    expect(deps.postEcho).toHaveBeenCalledWith('cc-s', { intent_id: 'i1', echo: { blurb: '二度有回音', degree: 2, relay_token: 'tok9' } })
  })
  it('已带 relay_token 的回音不再二次中继(防三跳/环):intake unknown + 有 token → drop', async () => {
    const { onEcho, deps } = make()
    expect(await onEcho('cc-q', msg({ echo: { blurb: 'x', degree: 2, relay_token: 'up' } }))).toEqual({ ok: false })
    expect(deps.postEcho).not.toHaveBeenCalled()
  })
  it('origin 未知(null/老行)或 origin===sender(回流)→ drop', async () => {
    for (const originOf of [vi.fn(() => null), vi.fn(() => 'cc-q')]) {
      const { onEcho, deps } = make({ originOf })
      expect(await onEcho('cc-q', msg())).toEqual({ ok: false })
      expect(deps.postEcho).not.toHaveBeenCalled()
    }
  })
  it('stale intake(迟到)→ ok:true 静默吞(不给对端探测面)', async () => {
    const { onEcho } = make({ intake: vi.fn(() => 'stale' as const) })
    expect(await onEcho('ccb', msg())).toEqual({ ok: true })
  })
})
