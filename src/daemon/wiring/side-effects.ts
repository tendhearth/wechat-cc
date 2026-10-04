/**
 * Side-effect closure factories — store-construction helpers + isolated SDK eval.
 *
 * Each factory closes over `stateDir` + `db` and returns a per-chat closure.
 * Used by both pipeline mw deps (mwActivity, mwMilestone, mwWelcome) and
 * startup-sweeps (boot milestone sweep, introspect catch-up).
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import type { AgentConfig } from '../../lib/agent-config'
import type { Mode } from '../../core/conversation'
import { buildDetectorContext } from '../milestones/build-context'
import { detectMilestones } from '../milestones/detector'
import { makeMilestonesStore } from '../milestones/store'
import { makeEventsStore } from '../events/store'
import { makeActivityStore } from '../activity/store'
import { makeObservationsStore } from '../observations/store'
import { botName } from '../bot-name'

export interface SideEffectDeps {
  stateDir: string
  db: Db
  log?: (tag: string, line: string) => void
  /**
   * 「连续 N 天」按天分桶的时区偏移(相对 UTC 分钟,东为正)。null/缺省 →
   * 跟随系统时区。写(recordInbound)与读(buildDetectorContext)两条路必须
   * 用同一个值 —— 都从同一份 config 读。见 core/prompt-format.ts localDayKey。
   */
  dayTzOffsetMinutes?: number | null
}

export function makeFireMilestonesFor(deps: SideEffectDeps): (chatId: string) => Promise<void> {
  return async (chatId: string) => {
    const ctx = await buildDetectorContext({ stateDir: deps.stateDir, chatId, db: deps.db, dayTzOffsetMinutes: deps.dayTzOffsetMinutes })
    const memRoot = join(deps.stateDir, 'memory')
    const milestones = makeMilestonesStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'milestones.jsonl') })
    const events = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'events.jsonl') })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired`, milestone_id: id })
    }
  }
}

export function makeRecordInbound(deps: SideEffectDeps): (chatId: string, when: Date) => Promise<void> {
  return async (chatId: string, when: Date) => {
    const memRoot = join(deps.stateDir, 'memory')
    const store = makeActivityStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'activity.jsonl'), dayOffsetMinutes: deps.dayTzOffsetMinutes })
    await store.recordInbound(when)
    // 以前这里会「补发」开机时没发出去的重启通知。2026-10-04 起重启通知从不补发
    // (见 notify-startup.ts):迟到的「我刚重启了」读起来像「我一说话它就重启」。
  }
}

export function makeMaybeWriteWelcomeObservation(opts: {
  stateDir: string
  db: Db
  agentConfig: AgentConfig
  getMode: (chatId: string) => Mode
}): (chatId: string) => Promise<void> {
  return async (chatId: string) => {
    const memRoot = join(opts.stateDir, 'memory')
    const obs = makeObservationsStore(opts.db, chatId, { migrateFromFile: join(memRoot, chatId, 'observations.jsonl') })
    const existing = await obs.listActive()
    const archived = await obs.listArchived()
    if (existing.length === 0 && archived.length === 0) {
      await obs.append({
        body: `嗨，我是 ${botName(opts.getMode(chatId), opts.agentConfig)}。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。`,
        tone: 'playful',
      })
    }
  }
}

// PR F: makeIsolatedSdkEval deleted. Introspect tick now resolves a
// cheap eval via ProviderRegistry.getCheapEval() so it works with
// whichever providers the user has registered (claude / codex / future).
