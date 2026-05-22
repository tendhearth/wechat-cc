import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../../src/lib/db'
import { makeObservationsStore } from '../../../src/daemon/observations/store'
import type { Trajectory } from './trajectory'
import { startEvalDaemon, type EvalDaemon } from './daemon-shim'
import { parseIso } from './clock'
import { captureSnapshot, type StateSnapshot } from './snapshot'
import { captureProbe } from './probes'
import { runAssertions } from './assertions'

export interface EventResult {
  index: number
  event: Trajectory['events'][number]
  actual?: ProbeActual
  snapshot?: StateSnapshot
  assertions?: AssertionResult[]
  judgeScores?: JudgeScore[]
}

export interface ProbeActual {
  kind: 'reply' | 'tick_outcome' | 'state'
  text?: string
  decision?: 'send' | 'silent'
  error?: string
}

export interface AssertionResult {
  label: string
  passed: boolean
  detail?: string
}

export interface JudgeScore {
  dimension: 'recall' | 'inference' | 'calibration' | 'initiative' | 'restraint'
  score: 1 | 2 | 3 | 4 | 5
  rationale: string
}

export interface ReplayContext {
  trajectory: Trajectory
  daemon: EvalDaemon
  lastUserMessageReply: { text?: string; error?: string } | null
  lastTickOutcome: { decision: 'send' | 'silent'; text?: string } | null
}

export async function replay(trajectory: Trajectory): Promise<EventResult[]> {
  const daemon = await startEvalDaemon({
    knownUsers: { [trajectory.contact.chat_id]: trajectory.contact.user_name },
    companion: {
      enabled: trajectory.companion_config.enabled,
      default_chat_id: trajectory.companion_config.default_chat_id,
    },
  })

  try {
    seedMemoryFiles(daemon.stateDir, trajectory)
    seedObservations(daemon.stateDir, trajectory)

    const ctx: ReplayContext = {
      trajectory, daemon,
      lastUserMessageReply: null,
      lastTickOutcome: null,
    }
    const results: EventResult[] = []

    for (let i = 0; i < trajectory.events.length; i++) {
      const event = trajectory.events[i]!
      const result: EventResult = { index: i, event }

      try {
        if (event.kind === 'user_message') {
          daemon.sendText(trajectory.contact.chat_id, event.text, {
            createTimeMs: parseIso(event.at).getTime(),
          })
          const outboxBefore = daemon.outboundFor(trajectory.contact.chat_id).length
          try {
            await daemon.waitForReplyTo(trajectory.contact.chat_id, 120_000)
            const outbox = daemon.outboundFor(trajectory.contact.chat_id)
            const newOnes = outbox.slice(outboxBefore)
            const lastNew = newOnes[newOnes.length - 1]
            ctx.lastUserMessageReply = { text: lastNew?.text ?? '' }
          } catch (err) {
            ctx.lastUserMessageReply = { error: err instanceof Error ? err.message : String(err) }
          }
        } else if (event.kind === 'tick') {
          const outboxBefore = daemon.outboundFor(trajectory.contact.chat_id).length
          await daemon.daemonHandle.fireTick(event.tick_kind, parseIso(event.at))
          const outbox = daemon.outboundFor(trajectory.contact.chat_id)
          const newOnes = outbox.slice(outboxBefore)
          ctx.lastTickOutcome = newOnes.length > 0
            ? { decision: 'send', ...(newOnes[newOnes.length - 1]?.text !== undefined ? { text: newOnes[newOnes.length - 1]!.text! } : {}) }
            : { decision: 'silent' }
        } else if (event.kind === 'probe') {
          result.actual = await captureProbe(event, ctx)
        }
      } catch (err) {
        result.actual = { kind: 'state', error: err instanceof Error ? err.message : String(err) }
      }

      const db = openDb({ path: join(daemon.stateDir, 'wechat-cc.db') })
      try {
        const snap = await captureSnapshot({
          stateDir: daemon.stateDir, db, chatId: trajectory.contact.chat_id, ilink: daemon.ilink,
        })
        result.snapshot = snap
        if (event.kind === 'probe' && result.actual !== undefined) {
          result.assertions = runAssertions({
            expected: event.expected,
            actual: result.actual,
            snapshot: snap,
          })
        }
      } finally { db.close() }

      results.push(result)
    }

    return results
  } finally {
    await daemon.stop()
  }
}

function seedMemoryFiles(stateDir: string, trajectory: Trajectory): void {
  const dir = join(stateDir, 'memory', trajectory.contact.chat_id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.md'), trajectory.contact.profile_md)
  writeFileSync(join(dir, 'preferences.md'), trajectory.contact.preferences_md)
  for (const [rel, content] of Object.entries(trajectory.contact.initial_memory_files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

function seedObservations(stateDir: string, trajectory: Trajectory): void {
  if (trajectory.contact.initial_observations.length === 0) return
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  try {
    const store = makeObservationsStore(db, trajectory.contact.chat_id)
    for (const obs of trajectory.contact.initial_observations) {
      void store.appendRaw({
        id: obs.id,
        ts: obs.ts,
        body: obs.body,
        archived: obs.archived ?? false,
        ...(obs.tone !== undefined ? { tone: obs.tone } : {}),
      })
    }
  } finally { db.close() }
}

