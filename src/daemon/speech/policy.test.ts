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
    sendAttachment: async () => false, sendSticker: async () => false, finish: () => { finished++ },
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
  it('调用方带了这一拍的时刻 ⇒ 按它判免打扰、记账(伙伴一拍用的是自己的 nowIso,不是墙上的钟)', async () => {
    const seen: number[] = []
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, nowMs) => { seen.push(nowMs); return null }, outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => 0 })
    await policy.say({ kind: 'companion', chatId: OWNER, nowMs: Date.parse('2026-05-13T10:00:00.000Z') }, async () => {})
    expect(seen).toEqual([Date.parse('2026-05-13T10:00:00.000Z')])
    expect(ledger[0]!.ts).toBe('2026-05-13T10:00:00.000Z')
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
  it('**同一条话、同一个理由连着被推后 ⇒ 账一小时只记一次**;放行 / 被拒以后重新算(9d 评审 #521:一夜免打扰 × 每拍会把账淹掉)', async () => {
    let now = Date.parse('2026-10-21T15:00:00.000Z')
    let quiet = true
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => (quiet ? now + 8 * 3600_000 : null), outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => now })
    for (let i = 0; i < 20; i++) { await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {}); now += 60_000 }   // 20 分钟,每分钟一拍
    expect(ledger.map(e => e.outcome)).toEqual(['deferred'])
    await policy.say({ kind: 'memory_notice', chatId: OWNER }, async () => {})                                                  // 别的种类单独记
    expect(ledger).toHaveLength(2)
    now += 60 * 60_000
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 过了一小时再记一次
    expect(ledger.filter(e => e.kind === 'matter_report').map(e => e.outcome)).toEqual(['deferred', 'deferred'])
    quiet = false
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 放行照记
    quiet = true
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 放行之后又被推后 ⇒ 重新算,马上记
    expect(ledger.filter(e => e.kind === 'matter_report').map(e => e.outcome)).toEqual(['deferred', 'deferred', 'allowed', 'deferred'])
  })
  it('记账抛错不影响开口', async () => {
    const ob = fakeOutbound()
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, ledger: () => { throw new Error('disk') }, log: () => {} })
    expect(await policy.say({ kind: 'companion', chatId: OWNER }, async t => { await t.sendText(OWNER, 'x') })).toMatchObject({ allow: true })
  })
})

describe('tell / flushPending —— 推后的 report 落盘待说,补说走 say 开的那一轮(降级时落到 App)', () => {
  it('**微信降级 + 补说 ⇒ 落到 App**(9d 评审:不能只发微信)', async () => {
    const { makeProactiveOutbound } = await import('../companion/proactive-channel')
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const recorded: string[] = []
    let degraded = false, quiet = true
    const outbound = makeProactiveOutbound({
      wechatDegraded: () => degraded, wechatClosedSince: () => null,
      sendWechat: async () => ({ msgId: 'w' }),
      app: () => ({ deliverable: () => true, record: async (_c, t) => { recorded.push(t); return true }, push: () => {} }),
      log: () => {},
    })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, n) => (quiet ? n + 3600_000 : null), outbound, log: () => {}, pending: makePendingNotices({ stateDir: mkdtempSync(join(tmpdir(), 'pend-')), log: () => {} }) })
    expect(await policy.tell('job_notice', OWNER, '定时 j1 连续失败,先停了')).toBe(false)   // 免打扰 ⇒ 推后、入队
    quiet = false; degraded = true
    await policy.flushPending()
    expect(recorded).toEqual(['定时 j1 连续失败,先停了'])
    await policy.flushPending()
    expect(recorded).toHaveLength(1)
  })
  it('initiative 推后不入队;report 推后入队;放行 ⇒ true', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ stateDir: mkdtempSync(join(tmpdir(), 'pend-')), log: () => {} })
    const ob = fakeOutbound()
    let quiet = true
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, n) => (quiet ? n + 3600_000 : null), outbound: ob.out, log: () => {}, pending })
    await policy.tell('sticker', OWNER, '新表情')
    await policy.tell('boot_notice', OWNER, '开机有几样没起来')
    expect(pending.groups()).toEqual([expect.objectContaining({ chatId: OWNER, items: [expect.objectContaining({ kind: 'boot_notice' })] })])
    quiet = false
    expect(await policy.tell('upgrade_notice', OWNER, '升好了')).toBe(true)
  })
})

describe('待说队列不丢话(9d 评审 #531)', () => {
  const mk = async (o: { sendErr: () => string | undefined; onSend?: () => void | Promise<void> }) => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const sent: string[] = []
    let now = Date.parse('2026-10-21T10:00:00.000Z')
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async (_c: string, t: string) => { await o.onSend?.(); const e = o.sendErr(); if (e) return { msgId: '', error: e }; sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
    const pending = makePendingNotices({ stateDir: mkdtempSync(join(tmpdir(), 'pend-')), log: () => {} })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, log: () => {}, pending, now: () => now })
    return { policy, pending, sent, advance: (ms: number) => { now += ms } }
  }
  it('① 门放行、发失败(回 error)⇒ 入队;下一拍说出来;外层照旧拿到 false', async () => {
    let err: string | undefined = 'network down'
    const t = await mk({ sendErr: () => err })
    expect(await t.policy.tell('job_notice', OWNER, '定时 j1 停了')).toBe(false)
    expect(t.pending.groups()[0]!.items.map(i => i.text)).toEqual(['定时 j1 停了'])
    err = undefined
    t.advance(10 * 60_000)
    await t.policy.flushPending()
    expect(t.sent).toEqual(['定时 j1 停了'])
  })
  it('① initiative 发失败 ⇒ 不入队', async () => {
    const t = await mk({ sendErr: () => 'down' })
    await t.policy.tell('sticker', OWNER, '新表情')
    expect(t.pending.groups()).toEqual([])
  })
  it('② flush 发送途中又进来一条 ⇒ 那条留在队列里,下一拍说', async () => {
    let addDuringSend: (() => void) | null = null
    const t = await mk({ sendErr: () => undefined, onSend: () => { addDuringSend?.(); addDuringSend = null } })
    t.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: '第一条', at: 'x' })
    addDuringSend = () => t.pending.add({ id: 'b', kind: 'boot_notice', chatId: OWNER, text: '路上进来的', at: 'y' })
    await t.policy.flushPending()
    expect(t.sent).toEqual(['第一条'])
    expect(t.pending.groups()[0]!.items.map(i => i.text)).toEqual(['路上进来的'])
    await t.policy.flushPending()
    expect(t.sent).toEqual(['第一条', '路上进来的'])
  })
  it('补说一直失败 ⇒ 按对话指数退避(5 → 10 → 20 分钟 …),不每拍都撞', async () => {
    let tries = 0
    const t = await mk({ sendErr: () => { tries++; return 'still down' } })
    t.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: 'x', at: 'x' })
    await t.policy.flushPending(); expect(tries).toBe(1)
    t.advance(4 * 60_000); await t.policy.flushPending(); expect(tries).toBe(1)   // 退避中
    t.advance(2 * 60_000); await t.policy.flushPending(); expect(tries).toBe(2)   // 过了 5 分钟
    t.advance(6 * 60_000); await t.policy.flushPending(); expect(tries).toBe(2)   // 第二次退避 10 分钟
    t.advance(5 * 60_000); await t.policy.flushPending(); expect(tries).toBe(3)
  })
})

describe('带会过期码的卡不进待说队列(9d 评审 #533)', () => {
  it('permission_ask / self_change_ask 没送到 ⇒ 不入队;social_ask(介绍一直有效)照样入队', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ stateDir: mkdtempSync(join(tmpdir(), 'pend-')), log: () => {} })
    const ob = fakeOutbound(false)   // 两条路都送不到 ⇒ 门推后
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, log: () => {}, pending })
    await policy.tell('permission_ask', OWNER, '要不要放行?回 y 07')
    await policy.tell('self_change_ask', OWNER, '合进 dev?回 y 08')
    await policy.tell('social_ask', OWNER, '老王的朋友想认识你')
    expect(pending.groups()[0]!.items.map(i => i.kind)).toEqual(['social_ask'])
  })
})
