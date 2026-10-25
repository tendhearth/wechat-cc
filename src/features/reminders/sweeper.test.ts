import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeRemindersStore } from './store'
import { makeSpeechPolicy } from '../../daemon/speech/policy'
import type { ProactiveOutbound } from '../../daemon/companion/proactive-channel'
import { sendReminderVia, runReminderSweep, lateReminderText, LATE_REMINDER_THRESHOLD_MS, RETRY_WINDOW_MS, backoffMs, MAX_SENDS_PER_SWEEP, MIN_ATTEMPTS_BEFORE_GIVE_UP } from './sweeper'

const noop = () => {}
const noopLog = () => {}

describe('runReminderSweep', () => {
  let db: Db
  beforeEach(() => { db = openTestDb() })
  afterEach(() => { db.close() })

  it('delivers a due reminder and marks it sent', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 'hi' })
    const send = vi.fn().mockResolvedValue({ ok: true })

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:01:00Z', log: noopLog })

    expect(send).toHaveBeenCalledWith('u', 'hi')
    expect(res).toEqual({ delivered: 1, retried: 0, failed: 0, deferred: 0 })
    expect((await store.list('u'))[0]!.status).toBe('sent')
  })

  it('**门说推后(两条路都送不到)⇒ 留着,不算一次尝试,24 小时也不放弃;恢复后送一次(带迟到前缀)**(SpeechPolicy 第 2 步)', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: '交房租' })
    let reachable = false
    const sent: string[] = []
    const send = async (_c: string, t: string) => (reachable ? (sent.push(t), { ok: true }) : { ok: false, deferred: 'undeliverable' })
    for (const nowIso of ['2026-06-18T10:01:00Z', '2026-06-18T18:00:00Z', '2026-06-19T12:00:00Z']) {
      expect(await runReminderSweep({ store, send, nowIso, log: noopLog })).toEqual({ delivered: 0, retried: 0, failed: 0, deferred: 1 })
    }
    expect((await store.list('u'))[0]).toMatchObject({ status: 'pending', attempts: 0 })
    reachable = true
    expect(await runReminderSweep({ store, send, nowIso: '2026-06-19T12:01:00Z', log: noopLog })).toEqual({ delivered: 1, retried: 0, failed: 0, deferred: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('交房租')
    expect(sent[0]).not.toBe('交房租')   // 迟到了 ⇒ 带说明
  })

  it('does not deliver reminders that are not yet due', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T23:00:00Z', text: 'later' })
    const send = vi.fn().mockResolvedValue({ ok: true })

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:00:00Z', log: noopLog })

    expect(send).not.toHaveBeenCalled()
    expect(res).toEqual({ delivered: 0, retried: 0, failed: 0, deferred: 0 })
    expect((await store.list('u'))[0]!.status).toBe('pending')
  })

  it('keeps a failing reminder pending while inside the retry window', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'missing_context_token' })

    // 1h after due — well inside the 24h window
    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T11:00:00Z', log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 1, failed: 0, deferred: 0 })
    const row = (await store.list('u'))[0]!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toBe('missing_context_token')
    // still due → will be retried on the next sweep
    expect(await store.listDue('2026-06-18T11:00:00Z')).toHaveLength(1)
  })

  it('gives up (marks failed) once past the retry window', async () => {
    const store = makeRemindersStore(db)
    const due = '2026-06-18T10:00:00.000Z'
    await store.schedule({ chat_id: 'u', due_at: due, text: 't' })
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'still failing' })

    const past = new Date(Date.parse(due) + RETRY_WINDOW_MS + 1000).toISOString()
    // 已经试过几轮(每次都过了退避)才放弃 —— 不是醒来第一下就判死
    const id = (await store.list('u'))[0]!.id
    for (let i = 0; i < MIN_ATTEMPTS_BEFORE_GIVE_UP - 1; i++) await store.recordAttempt(id, 'still failing', '2026-06-18T00:00:00.000Z')
    const res = await runReminderSweep({ store, send, nowIso: past, log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 0, failed: 1, deferred: 0 })
    expect((await store.list('u'))[0]!.status).toBe('failed')
  })

  it('does not give up on the first failure after a long outage — past the window but barely tried', async () => {
    // 电脑睡了两天,醒来第一轮 sweep 时网络还没连上:这一下失败不该把提醒判死
    const store = makeRemindersStore(db)
    const due = '2026-06-18T10:00:00.000Z'
    await store.schedule({ chat_id: 'u', due_at: due, text: '记得吃药' })
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const past = new Date(Date.parse(due) + 2 * RETRY_WINDOW_MS).toISOString()

    const res = await runReminderSweep({ store, send, nowIso: past, log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 1, failed: 0, deferred: 0 })
    const row = (await store.list('u'))[0]!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
  })

  it('never gives up a reminder blocked only by an expired push window (errcode=-2) — defers, not fails', async () => {
    const store = makeRemindersStore(db)
    const due = '2026-06-18T10:00:00.000Z'
    await store.schedule({ chat_id: 'u', due_at: due, text: '记得吃药' })
    // 票据过期:errcode=-2 —— 主人太久没说话,窗口没开
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'ilink/sendmessage errcode=-2: prepare failed' })
    // 远超 24h 重试窗口
    const past = new Date(Date.parse(due) + RETRY_WINDOW_MS + 5 * 3600_000).toISOString()
    const res = await runReminderSweep({ store, send, nowIso: past, log: noopLog })
    expect(res.failed).toBe(0)             // 不放弃
    expect(res.deferred).toBe(1)           // 保持 pending 等主人回来
    expect((await store.list('u'))[0]!.status).toBe('pending')   // 提醒还活着
  })

  it('treats a thrown send as a failure (no crash)', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    const send = vi.fn().mockRejectedValue(new Error('boom'))

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:30:00Z', log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 1, failed: 0, deferred: 0 })
    expect((await store.list('u'))[0]!.last_error).toBe('boom')
  })

  it('processes a mixed batch: deliver one, defer another', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'good', due_at: '2026-06-18T09:00:00Z', text: 'A' })
    await store.schedule({ chat_id: 'bad', due_at: '2026-06-18T09:30:00Z', text: 'B' })
    const send = vi.fn(async (chatId: string) =>
      chatId === 'good' ? { ok: true } : { ok: false, error: 'nope' })

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:00:00Z', log: noopLog })

    expect(res).toEqual({ delivered: 1, retried: 1, failed: 0, deferred: 0 })
    expect((await store.list('good'))[0]!.status).toBe('sent')
    expect((await store.list('bad'))[0]!.status).toBe('pending')
  })

  it('backoffMs doubles from 1min and caps at 60min', () => {
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(240_000)
    expect(backoffMs(7)).toBe(3_600_000)   // 64min uncapped → capped
    expect(backoffMs(20)).toBe(3_600_000)
  })

  it('skips a failed reminder still inside its backoff window (no send attempt)', async () => {
    // rec failed once at 10:00 (attempts=1, last_attempt_at=10:00); backoff 1min.
    // Sweep at 10:00:30 → send must NOT be called; counted as deferred.
    const store = makeRemindersStore(db)
    const reminderId = await store.schedule({ chat_id: 'u', due_at: '2026-08-20T09:59:00.000Z', text: 'msg' })
    // Simulate a first failure attempt
    await store.recordAttempt(reminderId, 'transient_error', '2026-08-20T10:00:00.000Z')

    const send = vi.fn()
    const result = await runReminderSweep({ store, send, nowIso: '2026-08-20T10:00:30.000Z', log: noop })
    expect(send).not.toHaveBeenCalled()
    expect(result.deferred).toBe(1)
  })

  it('retries a failed reminder once its backoff has elapsed', async () => {
    const store = makeRemindersStore(db)
    const reminderId = await store.schedule({ chat_id: 'u', due_at: '2026-08-20T09:59:00.000Z', text: 'msg' })
    // Simulate a first failure attempt
    await store.recordAttempt(reminderId, 'transient_error', '2026-08-20T10:00:00.000Z')

    const send = vi.fn().mockResolvedValue({ ok: true })
    const result = await runReminderSweep({ store, send, nowIso: '2026-08-20T10:01:01.000Z', log: noop })
    expect(send).toHaveBeenCalledTimes(1)
    expect(result.delivered).toBe(1)
  })

  it('caps send attempts at MAX_SENDS_PER_SWEEP; the rest stay pending and deferred', async () => {
    const store = makeRemindersStore(db)
    const total = MAX_SENDS_PER_SWEEP + 1
    for (let i = 0; i < total; i++) {
      // Stagger due_at so listDue's ORDER BY due_at ASC gives a deterministic
      // oldest-first order — the last one scheduled is the one left over.
      await store.schedule({
        chat_id: 'u',
        due_at: new Date(Date.parse('2026-08-20T09:00:00.000Z') + i * 1000).toISOString(),
        text: `msg${i}`,
      })
    }
    const send = vi.fn().mockResolvedValue({ ok: true })

    const res = await runReminderSweep({ store, send, nowIso: '2026-08-20T10:00:00.000Z', log: noopLog })

    expect(send).toHaveBeenCalledTimes(MAX_SENDS_PER_SWEEP)
    expect(res.delivered).toBe(MAX_SENDS_PER_SWEEP)
    expect(res.deferred).toBe(1)

    const stillPending = await store.listDue('2026-08-20T10:00:00.000Z')
    expect(stillPending).toHaveLength(1)
    expect(stillPending[0]!.text).toBe(`msg${total - 1}`)

    // Next sweep delivers the leftover row (untouched, not backed off).
    const send2 = vi.fn().mockResolvedValue({ ok: true })
    const res2 = await runReminderSweep({ store, send: send2, nowIso: '2026-08-20T10:01:00.000Z', log: noopLog })
    expect(send2).toHaveBeenCalledTimes(1)
    expect(res2.delivered).toBe(1)
    expect(await store.listDue('2026-08-20T10:01:00.000Z')).toHaveLength(0)
  })

  it('maxSendsPerSweep is overridable via SweepDeps', async () => {
    const store = makeRemindersStore(db)
    for (let i = 0; i < 5; i++) {
      await store.schedule({
        chat_id: 'u',
        due_at: new Date(Date.parse('2026-08-20T09:00:00.000Z') + i * 1000).toISOString(),
        text: `msg${i}`,
      })
    }
    const send = vi.fn().mockResolvedValue({ ok: true })

    const res = await runReminderSweep({
      store, send, nowIso: '2026-08-20T10:00:00.000Z', log: noopLog, maxSendsPerSweep: 2,
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(res.delivered).toBe(2)
    expect(res.deferred).toBe(3)
  })

  it('lateReminderText: on-time delivery is verbatim; late delivery is prefixed with the due time', () => {
    const due = '2026-08-27T22:00:00.000Z'
    // on time (within threshold) → unchanged
    expect(lateReminderText('记得吃药', due, Date.parse(due) + 60_000)).toBe('记得吃药')
    // late (past threshold) → prefixed, original text preserved at the end
    const late = lateReminderText('记得吃药', due, Date.parse(due) + LATE_REMINDER_THRESHOLD_MS + 60_000)
    expect(late).not.toBe('记得吃药')
    expect(late).toContain('晚了 31 分钟')
    expect(late.endsWith('记得吃药')).toBe(true)
  })

  it('lateReminderText 写明晚了多久(提醒不再 24 小时就放弃,可能晚好几天;整合者评审 #523)', () => {
    const due = '2026-08-27T22:00:00.000Z', d = Date.parse(due)
    expect(lateReminderText('开会', due, d + 45 * 60_000)).toContain('晚了 45 分钟')
    expect(lateReminderText('开会', due, d + 2 * 3600_000 + 10 * 60_000)).toContain('晚了 2 小时')
    expect(lateReminderText('开会', due, d + 3 * 86400_000 + 3600_000)).toContain('晚了 3 天')
    expect(lateReminderText('开会', due, d + 3 * 86400_000 + 3600_000)).toMatch(/本该 \d{2}月\d{2}日 \d{2}:\d{2}/)
  })
})
describe('「CC 做过的事」(B9)', () => {
  it('a delivered reminder is appended with its id — only for the owner chat, never the text', async () => {
    const db = openTestDb()
    const store = makeRemindersStore(db)
    const mine = await store.schedule({ chat_id: 'owner', due_at: '2026-06-18T10:00:00Z', text: '吃药' })
    await store.schedule({ chat_id: 'guest', due_at: '2026-06-18T10:00:00Z', text: '别人的' })
    const rows: unknown[] = []
    await runReminderSweep({ store, send: vi.fn().mockResolvedValue({ ok: true }), nowIso: '2026-06-18T10:01:00Z', log: () => {}, activityLog: { append: (e) => { rows.push(e) } }, isOwner: (c) => c === 'owner' })
    expect(rows).toEqual([{ kind: 'reminder', status: 'sent', ref: mine }])
  })
})

describe('sendReminderVia —— 提醒接到 SpeechPolicy 上(requested:免打扰 / 别烦我都照发)', () => {
  const speechWith = (o: { deliverable?: boolean; care?: 'off' | 'low'; quiet?: boolean; wechatError?: string; channel?: 'wechat' | 'app' }) => {
    const outbound: ProactiveOutbound = {
      appDeliverable: () => false, canDeliver: () => o.deliverable ?? true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async () => ({ msgId: 'm', ...(o.wechatError ? { error: o.wechatError } : {}) }), channel: () => o.channel ?? 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }),
    }
    return makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: () => (o.quiet ? Date.now() + 3600_000 : null), outbound, log: () => {} })
  }
  it('免打扰、别烦我都照发(时间是主人自己定的)', async () => {
    expect(await sendReminderVia(speechWith({ quiet: true, care: 'off' }), noopLog)('u', 't')).toEqual({ ok: true })
  })
  it('送不到 ⇒ deferred;发了失败 ⇒ error 原样交回(-2 那条分路靠它)', async () => {
    expect(await sendReminderVia(speechWith({ deliverable: false }), noopLog)('u', 't')).toEqual({ ok: false, deferred: 'undeliverable' })
    expect(await sendReminderVia(speechWith({ wechatError: 'errcode=-2' }), noopLog)('u', 't')).toEqual({ ok: false, error: 'errcode=-2' })
  })
  it('落在 App 上 ⇒ 记一行日志', async () => {
    const logs: string[] = []
    await sendReminderVia(speechWith({ channel: 'app' }), (_t, l) => logs.push(l))('u', 't')
    expect(logs.some(l => l.includes('delivered to the app'))).toBe(true)
  })
})
