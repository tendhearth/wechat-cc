import { describe, expect, it, vi } from 'vitest'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import type { PushPayload } from '../phone-push'
import { makeSpeechPolicy, type SpeechLedgerEntry } from './policy'
import { makePushGate } from './push-gate'

const OWNER = 'owner@im.wechat'
const T0 = Date.parse('2026-10-21T15:00:00.000Z')
const QUIET_END = Date.parse('2026-10-21T23:00:00.000Z')

function setup(o: { care?: 'off' | 'low'; quiet?: boolean; owner?: string | null; wechatDown?: boolean } = {}) {
  let t = T0
  const ledger: SpeechLedgerEntry[] = []
  // 微信断了、App 也「送不到」—— 推送照样问得过门:推送送不送得到是推送自己的事
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => !o.wechatDown, open: vi.fn(), sendOnce: async () => ({ ok: true }) }
  const speech = makeSpeechPolicy({
    care: () => o.care ?? 'low',
    quietEndsAt: (_c, now) => (o.quiet && now < QUIET_END ? QUIET_END : null),
    outbound, ledger: e => { ledger.push(e) }, log: () => {}, now: () => t,
  })
  const pushed: PushPayload[] = []
  const timers: Array<{ cb: () => void; ms: number }> = []
  const gate = makePushGate({
    speech, ownerChatId: () => (o.owner === undefined ? OWNER : o.owner),
    push: (p) => { pushed.push(p); return { sent: 1, online: 0 } },
    log: () => {}, now: () => t,
    setTimer: (cb, ms) => { const h = { cb, ms }; timers.push(h); return h },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1) },
  })
  return { gate, pushed, ledger, timers, advance: (ms: number) => { t += ms }, open: outbound.open }
}

const perm: PushPayload = { kind: 'permission', title: '需要你批准', body: 'Bash: ls', taskId: 't1', requestId: 'p1' }
const done: PushPayload = { kind: 'task_done', title: '做完了', body: '修登录', taskId: 't1' }

describe('App 原生推送也问 CC 开口那道门', () => {
  it('平常 ⇒ 跟以前一样照推,结果原样回;记一行账(channel=app),不开 proactive 那一轮', () => {
    const s = setup()
    expect(s.gate.push(perm)).toEqual({ sent: 1, online: 0 })
    expect(s.gate.push(done)).toEqual({ sent: 1, online: 0 })
    expect(s.pushed).toEqual([perm, done])
    expect(s.ledger.map(e => [e.kind, e.outcome, e.channel])).toEqual([['permission_ask', 'allowed', 'app'], ['matter_report', 'allowed', 'app']])
    expect(s.open).not.toHaveBeenCalled()
  })

  it('别烦我 ⇒ 批准(blocking)和做完了(report)都照推', () => {
    const s = setup({ care: 'off' })
    s.gate.push(perm); s.gate.push(done)
    expect(s.pushed.map(p => p.kind)).toEqual(['permission', 'task_done'])
  })

  it('免打扰 ⇒ 批准照推;做完了先压着,时段结束再推一次', () => {
    const s = setup({ quiet: true })
    expect(s.gate.push(perm)).toEqual({ sent: 1, online: 0 })
    expect(s.gate.push(done)).toEqual({ sent: 0, online: 0 })
    expect(s.pushed.map(p => p.kind)).toEqual(['permission'])
    expect(s.timers).toHaveLength(1)
    expect(s.timers[0]!.ms).toBe(QUIET_END - T0)
    s.advance(QUIET_END - T0)
    s.timers.shift()!.cb()
    expect(s.pushed.map(p => p.kind)).toEqual(['permission', 'task_done'])
    expect(s.timers).toHaveLength(0)
  })

  it('微信断了 ⇒ 推送照样问得过门(它本身就是 App 那条路)', () => {
    const s = setup({ wechatDown: true })
    s.gate.push(done)
    expect(s.pushed).toEqual([done])
  })

  it('companion 不经这里问(它只在 say 开的那一轮收尾时推,已经过了门)', () => {
    const s = setup({ quiet: true })
    const c: PushPayload = { kind: 'companion', title: 'CC', body: '在吗' }
    s.gate.push(c)
    expect(s.pushed).toEqual([c])
    expect(s.ledger).toEqual([])
  })

  it('停了 ⇒ 压着的丢掉、计时器清掉,再推回 null', () => {
    const s = setup({ quiet: true })
    s.gate.push(done)
    s.gate.stop()
    expect(s.timers).toHaveLength(0)
    expect(s.gate.push(perm)).toBeNull()
  })
})
