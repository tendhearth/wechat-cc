import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { remindersRoutes } from './routes-reminders'
import { MAX_PENDING_PER_CHAT } from '../reminders/store'
import type { InternalApiDeps } from './types'

describe('reminders routes', () => {
  let db: Db
  let routes: ReturnType<typeof remindersRoutes>
  beforeEach(() => {
    db = openTestDb()
    routes = remindersRoutes({ db } as InternalApiDeps)
  })
  afterEach(() => { db.close() })

  const sessionCaller = { tier: 'guest' as const, origin: 'session' as const, chatId: 'u1' }
  const fileCaller = { tier: 'admin' as const, origin: 'file' as const }

  it('schedule: session caller for own chat succeeds', async () => {
    const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, sessionCaller)
    expect(r.status).toBe(200)
    expect((r.body as any).ok).toBe(true)
  })
  it('schedule: session caller for ANOTHER chat is 403 without echoing the target', async () => {
    const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'victim', text: 'hi', delay_seconds: 60 }, sessionCaller)
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).not.toContain('victim')
  })
  it('cancel: session caller cannot cancel another chat\'s reminder', async () => {
    const s = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u2', text: 'hi', delay_seconds: 60 }, fileCaller)
    const reminderId = (s.body as any).reminder_id as string
    const r = await routes['POST /v1/reminders/cancel']!(new URLSearchParams(), { chat_id: 'u2', reminder_id: reminderId }, sessionCaller)
    expect(r.status).toBe(403)
    // and the reminder is still pending
    const l = await routes['GET /v1/reminders/list']!(new URLSearchParams({ chat_id: 'u2' }), undefined, fileCaller)
    expect((l.body as any).reminders[0].status).toBe('pending')
  })
  it('list: session caller cannot list another chat', async () => {
    const r = await routes['GET /v1/reminders/list']!(new URLSearchParams({ chat_id: 'u2' }), undefined, sessionCaller)
    expect(r.status).toBe(403)
  })
  it('file-origin caller may target any chat_id', async () => {
    const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'anyone', text: 'hi', delay_seconds: 60 }, fileCaller)
    expect((r.body as any).ok).toBe(true)
  })
  it('session caller with no chatId is denied (fail closed)', async () => {
    const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, { tier: 'guest', origin: 'session' })
    expect(r.status).toBe(403)
  })
  it('schedule with delay_seconds computes due_at ≈ now + delay', async () => {
    const before = Date.now()
    const r = await routes['POST /v1/reminders/schedule']!(new URLSearchParams(), { chat_id: 'u1', text: 'hi', delay_seconds: 60 }, sessionCaller)
    const due = Date.parse((r.body as any).due_at)
    expect(due).toBeGreaterThanOrEqual(before + 55_000)
    expect(due).toBeLessThanOrEqual(Date.now() + 65_000)
  })

  it('schedule: per-chat pending cap — the 20th succeeds, the 21st is rejected', async () => {
    for (let i = 0; i < MAX_PENDING_PER_CHAT; i++) {
      const r = await routes['POST /v1/reminders/schedule']!(
        new URLSearchParams(), { chat_id: 'u1', text: `n${i}`, delay_seconds: 60 }, sessionCaller)
      expect(r.status).toBe(200)
      expect((r.body as any).ok).toBe(true)
    }
    const r21 = await routes['POST /v1/reminders/schedule']!(
      new URLSearchParams(), { chat_id: 'u1', text: 'one too many', delay_seconds: 60 }, sessionCaller)
    expect(r21.status).toBe(200)
    expect((r21.body as any).ok).toBe(false)
    expect((r21.body as any).error).toBe('too_many_pending')

    const l = await routes['GET /v1/reminders/list']!(new URLSearchParams({ chat_id: 'u1' }), undefined, sessionCaller)
    expect((l.body as any).reminders).toHaveLength(MAX_PENDING_PER_CHAT)
  })

  it('schedule: non-pending rows do not count toward the cap', async () => {
    let lastId = ''
    for (let i = 0; i < MAX_PENDING_PER_CHAT; i++) {
      const r = await routes['POST /v1/reminders/schedule']!(
        new URLSearchParams(), { chat_id: 'u1', text: `n${i}`, delay_seconds: 60 }, sessionCaller)
      lastId = (r.body as any).reminder_id
    }
    // Cancel one, freeing a slot under the cap.
    const c = await routes['POST /v1/reminders/cancel']!(
      new URLSearchParams(), { chat_id: 'u1', reminder_id: lastId }, sessionCaller)
    expect((c.body as any).cancelled).toBe(true)

    const r = await routes['POST /v1/reminders/schedule']!(
      new URLSearchParams(), { chat_id: 'u1', text: 'fits now', delay_seconds: 60 }, sessionCaller)
    expect((r.body as any).ok).toBe(true)
  })
})
