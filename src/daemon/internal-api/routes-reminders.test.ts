import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { remindersRoutes } from './routes-reminders'
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
})
