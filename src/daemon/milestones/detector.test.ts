import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMilestonesStore } from './store'
import { detectMilestones, type DetectorContext } from './detector'
import { openTestDb, type Db } from '../../lib/db'

function ctx(stateRoot: string, chatId: string, overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    chatId,
    turnCount: 0,
    handoffMarkerExists: false,
    portraitExists: false,
    pushRepliedHistory: [],
    daysWithMessage: [],
    last7DayKeys: [],
    ...overrides,
  }
}

describe('milestone detector', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msd-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fires ms_100msg when turn count crosses 100', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 100 }))
    expect(fired).toContain('ms_100msg')
    expect(await store.list()).toHaveLength(1)
  })

  it('does not fire ms_100msg when turn count is 99', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 99 }))
    expect(fired).not.toContain('ms_100msg')
  })

  it('fires ms_1000msg when turn count crosses 1000', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 1000 }))
    expect(fired).toContain('ms_1000msg')
  })

  it('fires ms_first_portrait once when the first portrait exists', async () => {
    const store = makeMilestonesStore(db, 'chat_p')
    const fired = await detectMilestones(store, ctx(dir, 'chat_p', { portraitExists: true }))
    expect(fired).toContain('ms_first_portrait')
    const again = await detectMilestones(store, ctx(dir, 'chat_p', { portraitExists: true }))
    expect(again).not.toContain('ms_first_portrait')   // reach-once
  })

  it('fires ms_first_handoff when handoff marker exists', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { handoffMarkerExists: true }))
    expect(fired).toContain('ms_first_handoff')
  })

  it('fires ms_first_push_reply on first non-empty pushRepliedHistory entry', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { pushRepliedHistory: ['evt_1'] }))
    expect(fired).toContain('ms_first_push_reply')
  })

  it('fires ms_7day_streak when every last7DayKey has a message', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    // Arbitrary fixed keys — the detector just intersects daysWithMessage with
    // last7DayKeys, so the tz/now decision (build-context's job) is out of scope.
    const last7 = ['2026-08-27', '2026-08-26', '2026-08-25', '2026-08-24', '2026-08-23', '2026-08-22', '2026-08-21']
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { daysWithMessage: [...last7], last7DayKeys: last7 }))
    expect(fired).toContain('ms_7day_streak')
  })

  it('does NOT fire ms_7day_streak when one of the last 7 days is missing', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const last7 = ['2026-08-27', '2026-08-26', '2026-08-25', '2026-08-24', '2026-08-23', '2026-08-22', '2026-08-21']
    const gapped = last7.filter(k => k !== '2026-08-24')   // 断了一天
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { daysWithMessage: gapped, last7DayKeys: last7 }))
    expect(fired).not.toContain('ms_7day_streak')
  })

  it('subsequent calls do not re-fire same milestone', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 100 }))
    const fired2 = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 200 }))
    expect(fired2).not.toContain('ms_100msg')
    expect(await store.list()).toHaveLength(1)
  })
})
