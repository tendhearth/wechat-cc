/**
 * Pure milestone detection — given a snapshot of chat-level facts, returns
 * the set of milestones to fire NOW. Idempotent: relies on store.fire's
 * dedup so re-running with the same context is a no-op for already-fired
 * milestones.
 *
 * Caller is responsible for assembling DetectorContext (e.g. counting jsonl
 * lines, checking _handoff.md existence, scanning events.jsonl for
 * pushRepliedHistory). Decoupled here for unit testability.
 */
import type { MilestonesStore } from './store'

export interface DetectorContext {
  chatId: string
  turnCount: number               // total turns across all sessions for this chat
  handoffMarkerExists: boolean    // _handoff.md present in any project memory
  portraitExists: boolean         // CC 第一次画出主人的小像(portrait.svg present)
  pushRepliedHistory: string[]    // event_ids of pushes that user replied to
  /**
   * Local calendar-day keys (`YYYY-MM-DD`) that had ≥1 inbound message —
   * from the activity store, bucketed by the owner's LOCAL day (system tz
   * or configured offset; see core/prompt-format.ts localDayKey).
   */
  daysWithMessage: string[]
  /**
   * The last 7 local-day keys (today + 6 prior) the caller expects for an
   * unbroken streak, computed with the SAME tz convention as daysWithMessage.
   * has7DayStreak just checks all 7 are present — keeping the tz/now decision
   * in one place (build-context) and the detector pure.
   */
  last7DayKeys: string[]
}

interface MilestoneSpec {
  id: string
  body: string
  fires: (ctx: DetectorContext) => boolean
}

const SPECS: MilestoneSpec[] = [
  {
    id: 'ms_100msg',
    body: '我们聊了第 100 条 — 不知不觉。',
    fires: ctx => ctx.turnCount >= 100,
  },
  {
    id: 'ms_1000msg',
    body: '我们聊了第 1000 条 — 一千条了,攒了好多我们俩的日子。',
    fires: ctx => ctx.turnCount >= 1000,
  },
  {
    id: 'ms_first_portrait',
    body: '我好像能想象出你的样子了 — 给你画了张小像。在记忆页,或手机上打开随身 CC 就能看到。',
    fires: ctx => ctx.portraitExists,
  },
  {
    id: 'ms_first_handoff',
    body: '第一次跨项目交接 — 我把上下文带过去了。',
    fires: ctx => ctx.handoffMarkerExists,
  },
  {
    id: 'ms_first_push_reply',
    body: '你第一次回复我主动找你。',
    fires: ctx => ctx.pushRepliedHistory.length > 0,
  },
  {
    id: 'ms_7day_streak',
    body: '我们已经连续 7 天每天都聊。',
    fires: ctx => has7DayStreak(ctx.daysWithMessage, ctx.last7DayKeys),
  },
]

/** Every one of the caller's last-7 local-day keys had a message. */
function has7DayStreak(days: string[], last7DayKeys: string[]): boolean {
  if (last7DayKeys.length < 7) return false
  const set = new Set(days)
  return last7DayKeys.every(k => set.has(k))
}

export async function detectMilestones(store: MilestonesStore, ctx: DetectorContext): Promise<string[]> {
  const fired: string[] = []
  for (const spec of SPECS) {
    if (!spec.fires(ctx)) continue
    if (await store.fire({ id: spec.id, body: spec.body })) {
      fired.push(spec.id)
    }
  }
  return fired
}
