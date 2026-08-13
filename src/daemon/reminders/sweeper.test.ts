import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeRemindersStore } from './store'
import { runReminderSweep, RETRY_WINDOW_MS } from './sweeper'

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
    expect(res).toEqual({ delivered: 1, retried: 0, failed: 0 })
    expect((await store.list('u'))[0]!.status).toBe('sent')
  })

  it('does not deliver reminders that are not yet due', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T23:00:00Z', text: 'later' })
    const send = vi.fn().mockResolvedValue({ ok: true })

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:00:00Z', log: noopLog })

    expect(send).not.toHaveBeenCalled()
    expect(res.delivered).toBe(0)
    expect((await store.list('u'))[0]!.status).toBe('pending')
  })

  it('keeps a failing reminder pending while inside the retry window', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'missing_context_token' })

    // 1h after due — well inside the 24h window
    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T11:00:00Z', log: noopLog })

    expect(res).toEqual({ delivered: 0, retried: 1, failed: 0 })
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

    expect(res).toEqual({ delivered: 0, retried: 0, failed: 1 })
    expect((await store.list('u'))[0]!.status).toBe('failed')
  })

  it('treats a thrown send as a failure (no crash)', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    const send = vi.fn().mockRejectedValue(new Error('boom'))

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:30:00Z', log: noopLog })

    expect(res.retried).toBe(1)
    expect((await store.list('u'))[0]!.last_error).toBe('boom')
  })

  it('processes a mixed batch: deliver one, defer another', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'good', due_at: '2026-06-18T09:00:00Z', text: 'A' })
    await store.schedule({ chat_id: 'bad', due_at: '2026-06-18T09:30:00Z', text: 'B' })
    const send = vi.fn(async (chatId: string) =>
      chatId === 'good' ? { ok: true } : { ok: false, error: 'nope' })

    const res = await runReminderSweep({ store, send, nowIso: '2026-06-18T10:00:00Z', log: noopLog })

    expect(res).toEqual({ delivered: 1, retried: 1, failed: 0 })
    expect((await store.list('good'))[0]!.status).toBe('sent')
    expect((await store.list('bad'))[0]!.status).toBe('pending')
  })
})
