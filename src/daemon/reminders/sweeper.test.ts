import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeRemindersStore } from './store'
import { runReminderSweep, lateReminderText, LATE_REMINDER_THRESHOLD_MS, RETRY_WINDOW_MS, backoffMs, MAX_SENDS_PER_SWEEP } from './sweeper'

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
    const res = await runReminderSweep({ store, send, nowIso: past, log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 0, failed: 1, deferred: 0 })
    expect((await store.list('u'))[0]!.status).toBe('failed')
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
    expect(late).toContain('晚了点')
    expect(late.endsWith('记得吃药')).toBe(true)
  })
})