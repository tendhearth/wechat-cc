/**
 * Assembles a DetectorContext from real on-disk data. Pure-ish (depends on
 * fs only, not net/SDK). Designed to be cheap enough to call after every
 * inbound message + on daemon startup.
 *
 * v0.4.1 scope:
 *   - turnCount: line count of chat's _default project session jsonl
 *   - handoffMarkerExists: existsSync any project's memory/_handoff.md
 *   - pushRepliedHistory: events.jsonl scan for cron_eval_pushed events
 *   - daysWithMessage: read from activity.jsonl via makeActivityStore
 *
 * All 5 milestones now fire-able: ms_100msg, ms_1000msg, ms_first_handoff,
 * ms_first_push_reply, ms_7day_streak.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectorContext } from './detector'
import { makeEventsStore } from '../events/store'
import { makeActivityStore } from '../activity/store'
import { makeSessionStore } from '../../core/session-store'
import type { Db } from '../../lib/db'
import { resolveProjectJsonlPath } from '../sessions/path-resolver'
import { localDayKey } from '../../core/prompt-format'

export interface BuildContextDeps {
  stateDir: string
  chatId: string
  db: Db
  /** Clock — defaults to Date.now. Tests pin it so streak day-keys are stable. */
  now?: () => number
  /**
   * Timezone offset (minutes ahead of UTC) for the streak's day bucketing.
   * null/undefined → system tz (auto, DST-correct). MUST match what the
   * activity WRITE path (side-effects makeRecordInbound) uses, or the written
   * days won't line up with last7DayKeys. Both read it from the same config.
   */
  dayTzOffsetMinutes?: number | null
}

export async function buildDetectorContext(deps: BuildContextDeps): Promise<DetectorContext> {
  const memoryRoot = join(deps.stateDir, 'memory')

  // turnCount: scan all sessions in sessions.json, sum jsonl line counts.
  // v0.4 simplification: use the _default alias only since a single-chat
  // owner typically maps to one project. Multi-project owners get a
  // smaller turnCount than reality — acceptable; milestones are reach-once
  // anyway, so they fire eventually as work accumulates.
  let turnCount = 0
  try {
    const sessions = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })
    // v0.6 Task 8: triple-keyed store. We want the _default alias regardless
    // of which provider/chat it lives under — walk all() and pick the
    // most-recent row.
    let rec: ReturnType<typeof sessions.get> = null
    for (const r of Object.values(sessions.all())) {
      if (r.alias !== '_default') continue
      if (!rec || Date.parse(r.last_used_at) > Date.parse(rec.last_used_at)) rec = r
    }
    if (rec) {
      const path = resolveProjectJsonlPath('_default', rec.session_id)
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf8')
        turnCount = content.split('\n').filter(l => l.length > 0).length
      }
    }
  } catch { /* turnCount stays 0 */ }

  // handoffMarkerExists: check the chat's memory dir for _handoff.md
  // (the marker is written into memory/<chat_id>/_handoff.md per spec).
  const handoffMarkerExists = existsSync(join(memoryRoot, deps.chatId, '_handoff.md'))

  // pushRepliedHistory: scan events.jsonl for cron_eval_pushed events.
  // Heuristic: presence of any pushed event is enough to fire
  // ms_first_push_reply (the milestone semantics ask "did we ever push?",
  // which is the closest proxy without per-message reply tracking).
  const events = makeEventsStore(deps.db, deps.chatId, {
    migrateFromFile: join(memoryRoot, deps.chatId, 'events.jsonl'),
  })
  const pushed = (await events.list()).filter(e => e.kind === 'cron_eval_pushed')
  const pushRepliedHistory = pushed.map(e => e.id)

  // daysWithMessage: real values from the activity store, bucketed by the
  // owner's LOCAL day (system tz or configured offset — MUST match the write
  // path). The streak milestone fires when the last 7 local days each have
  // ≥1 inbound message.
  const now = deps.now ?? Date.now
  const dayKey = (ms: number) => localDayKey(ms, deps.dayTzOffsetMinutes)
  const activity = makeActivityStore(deps.db, deps.chatId, {
    migrateFromFile: join(memoryRoot, deps.chatId, 'activity.jsonl'),
    dayOffsetMinutes: deps.dayTzOffsetMinutes,
    now,
  })
  const recent = await activity.recentDays(7)
  const daysWithMessage = recent.map(r => r.date)
  // today + 6 prior local days — computed with the SAME tz as the write path.
  const nowMs = now()
  const last7DayKeys = Array.from({ length: 7 }, (_, i) => dayKey(nowMs - i * 86400_000))

  // CC 画的你:第一幅小像落盘即触发一次报喜(后续刷新静默,见 portrait-artist)。
  const portraitExists = existsSync(join(memoryRoot, deps.chatId, 'portrait.svg'))

  return {
    chatId: deps.chatId,
    turnCount,
    handoffMarkerExists,
    portraitExists,
    pushRepliedHistory,
    daysWithMessage,
    last7DayKeys,
  }
}
