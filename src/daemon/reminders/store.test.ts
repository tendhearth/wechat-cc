import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeRemindersStore } from './store'

describe('reminders store', () => {
  let db: Db
  beforeEach(() => { db = openTestDb() })
  afterEach(() => { db.close() })

  it('schedules a reminder and lists it as pending', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({
      chat_id: 'user123',
      due_at: '2026-06-18T15:00:00.000Z',
      text: 'follow up',
    })
    expect(id).toMatch(/^rmr_/)
    const all = await store.list('user123')
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('pending')
    expect(all[0]!.text).toBe('follow up')
    expect(all[0]!.attempts).toBe(0)
    expect(all[0]!.last_error).toBeNull()
  })

  it('listDue returns only pending rows due on or before now, oldest first', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T09:00:00.000Z', text: 'early' })
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00.000Z', text: 'mid' })
    await store.schedule({ chat_id: 'u', due_at: '2026-06-18T23:00:00.000Z', text: 'future' })

    const due = await store.listDue('2026-06-18T10:30:00.000Z')
    expect(due.map(r => r.text)).toEqual(['early', 'mid'])
  })

  it('different chatIds are isolated in list()', async () => {
    const store = makeRemindersStore(db)
    await store.schedule({ chat_id: 'a', due_at: '2026-06-18T10:00:00Z', text: 'A' })
    await store.schedule({ chat_id: 'b', due_at: '2026-06-18T10:00:00Z', text: 'B' })
    expect((await store.list('a')).map(r => r.text)).toEqual(['A'])
    expect((await store.list('b')).map(r => r.text)).toEqual(['B'])
  })

  it('markSent flips status and bumps attempts; sent rows drop out of listDue', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    await store.markSent(id)
    const all = await store.list('u')
    expect(all[0]!.status).toBe('sent')
    expect(all[0]!.attempts).toBe(1)
    expect(await store.listDue('2026-06-18T11:00:00Z')).toHaveLength(0)
  })

  it('recordAttempt bumps attempts + last_error but keeps it pending/due', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    await store.recordAttempt(id, 'missing_context_token')
    const all = await store.list('u')
    expect(all[0]!.status).toBe('pending')
    expect(all[0]!.attempts).toBe(1)
    expect(all[0]!.last_error).toBe('missing_context_token')
    expect(await store.listDue('2026-06-18T11:00:00Z')).toHaveLength(1)
  })

  it('markFailed flips status and removes from listDue', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 't' })
    await store.markFailed(id, 'gave up')
    const all = await store.list('u')
    expect(all[0]!.status).toBe('failed')
    expect(all[0]!.last_error).toBe('gave up')
    expect(await store.listDue('2026-06-18T11:00:00Z')).toHaveLength(0)
  })

  it('cancel only affects the owner and only pending rows', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'owner', due_at: '2026-06-18T10:00:00Z', text: 't' })

    // wrong owner → no-op
    expect(await store.cancel(id, 'someone-else')).toBe(false)
    expect((await store.list('owner'))[0]!.status).toBe('pending')

    // right owner → cancelled
    expect(await store.cancel(id, 'owner')).toBe(true)
    expect((await store.list('owner'))[0]!.status).toBe('cancelled')

    // already cancelled → no-op false
    expect(await store.cancel(id, 'owner')).toBe(false)
    // cancelled rows are not due
    expect(await store.listDue('2026-06-18T11:00:00Z')).toHaveLength(0)
  })

  it('survives a fresh store instance over the same db (restart simulation)', async () => {
    const s1 = makeRemindersStore(db)
    await s1.schedule({ chat_id: 'u', due_at: '2026-06-18T10:00:00Z', text: 'persisted' })
    // new store object, same underlying db handle = same file in production
    const s2 = makeRemindersStore(db)
    expect((await s2.listDue('2026-06-18T11:00:00Z')).map(r => r.text)).toEqual(['persisted'])
  })

  it('recordAttempt stamps last_attempt_at with the injected nowIso', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'u1', due_at: '2026-08-20T10:00:00.000Z', text: 'hi' })
    await store.recordAttempt(id, 'boom', '2026-08-20T10:01:00.000Z')
    const rec = (await store.list('u1')).find(r => r.id === id)!
    expect(rec.attempts).toBe(1)
    expect(rec.last_error).toBe('boom')
    expect(rec.last_attempt_at).toBe('2026-08-20T10:01:00.000Z')
  })

  it('a fresh reminder has last_attempt_at null', async () => {
    const store = makeRemindersStore(db)
    const id = await store.schedule({ chat_id: 'u1', due_at: '2026-08-20T10:00:00.000Z', text: 'hi' })
    const rec = (await store.list('u1')).find(r => r.id === id)!
    expect(rec.last_attempt_at).toBeNull()
  })
})
