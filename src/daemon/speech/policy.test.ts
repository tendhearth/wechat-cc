import { describe, expect, it, vi } from 'vitest'
import type { ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import { makeSpeechPolicy, type SpeechLedgerEntry } from './policy'

const OWNER = 'owner@im.wechat'
function fakeOutbound(deliverable = true) {
  const sent: string[] = []
  let finished = 0
  const turn: ProactiveTurn = {
    sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } },
    channel: () => (sent.length ? 'wechat' : null), textOnly: () => false,
    sendAttachment: async () => false, finish: () => { finished++ },
  }
  const out: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => deliverable, open: vi.fn(() => turn), sendOnce: async () => ({ ok: true }) }
  return { out, sent, finished: () => finished }
}
function setup(o: { care?: 'off' | 'low'; quietEnds?: number | null; deliverable?: boolean } = {}) {
  const ob = fakeOutbound(o.deliverable ?? true)
  const ledger: SpeechLedgerEntry[] = []
  const policy = makeSpeechPolicy({
    care: () => o.care ?? 'low',
    quietEndsAt: () => o.quietEnds ?? null,
    outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {},
    now: () => Date.parse('2026-10-21T10:00:00.000Z'),
  })
  return { policy, ledger, ...ob }
}

describe('policy.say —— CC 开口只有这一道门', () => {
  it('allow ⇒ 开一轮交给生产者,发完收尾;记一行账(只有种类和原因,没有正文)', async () => {
    const s = setup()
    const r = await s.policy.say({ kind: 'companion', chatId: OWNER }, async t => { await t.sendText(OWNER, '在忙吗') })
    expect(r).toEqual({ allow: true, channel: 'wechat' })
    expect(s.sent).toEqual(['在忙吗'])
    expect(s.finished()).toBe(1)
    expect(s.ledger).toEqual([{ kind: 'companion', origin: 'initiative', chatId: OWNER, outcome: 'allowed', reason: null, channel: 'wechat', ts: '2026-10-21T10:00:00.000Z' }])
    expect(JSON.stringify(s.ledger)).not.toContain('在忙吗')
  })
  it('**被拒 / 被推后 ⇒ 生产者根本不跑**(贵的事——调模型——放在判定之后),也不开通道', async () => {
    const s = setup({ care: 'off' })
    const produce = vi.fn(async () => {})
    expect(await s.policy.say({ kind: 'guest_visit', chatId: OWNER }, produce)).toEqual({ drop: true, reason: 'care_off' })
    expect(produce).not.toHaveBeenCalled()
    expect(s.out.open).not.toHaveBeenCalled()
    expect(s.ledger[0]).toMatchObject({ outcome: 'dropped', reason: 'care_off', channel: null })
    const q = setup({ quietEnds: Date.parse('2026-10-21T23:00:00.000Z') })
    expect(await q.policy.say({ kind: 'matter_report', chatId: OWNER }, produce)).toEqual({ defer: true, until: '2026-10-21T23:00:00.000Z', reason: 'quiet_hours' })
    expect(produce).not.toHaveBeenCalled()
    expect(q.ledger[0]).toMatchObject({ outcome: 'deferred', reason: 'quiet_hours' })
  })
  it('两条路都送不到 ⇒ defer,不开通道、不跑生产者(no-retry-storm)', async () => {
    const s = setup({ deliverable: false })
    const produce = vi.fn(async () => {})
    expect(await s.policy.say({ kind: 'permission_ask', chatId: OWNER }, produce)).toEqual({ defer: true, reason: 'undeliverable' })
    expect(produce).not.toHaveBeenCalled()
  })
  it('perKind / scheduled 原样交给判定', async () => {
    const s = setup({ quietEnds: Date.parse('2026-10-21T23:00:00.000Z') })
    expect(await s.policy.say({ kind: 'brief', chatId: OWNER, scheduled: true }, async () => {})).toEqual({ drop: true, reason: 'skipped:quiet' })
    const t = setup()
    expect(await t.policy.say({ kind: 'sticker', chatId: OWNER, perKind: { ok: false, reason: 'sticker_cooldown' } }, async () => {})).toEqual({ drop: true, reason: 'sticker_cooldown' })
  })
  it('生产者抛错 ⇒ 照样收尾、抛给调用方;账上记 failed', async () => {
    const s = setup()
    await expect(s.policy.say({ kind: 'letter', chatId: OWNER }, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(s.finished()).toBe(1)
    expect(s.ledger[0]).toMatchObject({ outcome: 'failed', reason: 'boom' })
  })
  it('记账抛错不影响开口', async () => {
    const ob = fakeOutbound()
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, ledger: () => { throw new Error('disk') }, log: () => {} })
    expect(await policy.say({ kind: 'companion', chatId: OWNER }, async t => { await t.sendText(OWNER, 'x') })).toMatchObject({ allow: true })
  })
})
