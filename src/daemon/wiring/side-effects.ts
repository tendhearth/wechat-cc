/**
 * Side-effect closure factories — store-construction helpers + isolated SDK eval.
 *
 * Each factory closes over `stateDir` + `db` and returns a per-chat closure.
 * Used by both pipeline mw deps (mwActivity, mwMilestone, mwWelcome) and
 * startup-sweeps (boot milestone sweep, introspect catch-up).
 */
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
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
import { readJsonFile } from '../../lib/read-json-file'

export interface SideEffectDeps {
  stateDir: string
  db: Db
  /** pending-notify 补发通道(makeRecordInbound → flushPendingNotify)。 */
  sendMessage?: (chatId: string, text: string) => Promise<{ msgId?: string; error?: string }>
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
    // 补发错过的启动恢复通知:用户刚说话 = ilink 票据刚刷新,现在能发了。
    // 见 notify-startup.ts 的 pending-notify 说明。只补给刚说话的这个 chat。
    void flushPendingNotify(deps, chatId)
  }
}

async function flushPendingNotify(deps: SideEffectDeps, chatId: string): Promise<void> {
  const pendingPath = join(deps.stateDir, 'pending-notify.json')
  if (!existsSync(pendingPath)) return
  try {
    const pending = readJsonFile(pendingPath) as { text?: string; recipients?: string[]; ts?: number }
    if (!pending.text || !Array.isArray(pending.recipients) || !pending.recipients.includes(chatId)) return
    // 24h 以上的旧通知不补 — 迟到太久的「我回来了」只会困惑。
    if (typeof pending.ts === 'number' && Date.now() - pending.ts > 24 * 3600_000) { rmSync(pendingPath, { force: true }); return }
    rmSync(pendingPath, { force: true })   // 先删再发:失败也不无限重投
    const r = await deps.sendMessage?.(chatId, pending.text)
    deps.log?.('NOTIFY', `pending notify flushed to ${chatId}: ${r && !(r as { error?: string }).error ? 'ok' : 'failed'}`)
  } catch { /* best effort */ }
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
