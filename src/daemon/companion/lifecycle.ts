import type { Lifecycle } from '../../lib/lifecycle'
import { startCompanionScheduler } from './scheduler'

export interface CompanionPushDeps {
  /**
   * Single combined gate — returns true if the tick should fire. Wiring
   * loads companion config once and answers both "enabled?" and
   * "not snoozed?". Replaces the prior split isEnabled+isSnoozed pair
   * which loaded config twice per tick and could race against state
   * changes between the two reads.
   */
  shouldRun(): boolean
  log: (tag: string, line: string) => void
  onTick(): Promise<void>
  /**
   * Override base interval (ms). Defaults to PUSH_INTERVAL_MS (20 min).
   * Eval harness passes a SAFE_INFINITY-style value to prevent auto-fire
   * so the engine can drive ticks deterministically.
   */
  intervalMs?: number
}

const PUSH_INTERVAL_MS = 20 * 60 * 1000
const INTROSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000
const INGEST_INTERVAL_MS = 25 * 60 * 1000
// Trailing debounce for the new-message nudge. Set to the ingestTick idle-guard
// window (INGEST_QUIET_MS, 3 min) so the nudge fires only AFTER the conversation
// settles — otherwise it would fire mid-chat and the idle guard would skip it.
const NUDGE_DELAY_MS = 3 * 60 * 1000
const JITTER = 0.3

/** An ingest lifecycle also exposes a debounced nudge for the inbound path. */
export interface IngestLifecycle extends Lifecycle {
  /** Schedule an ingest cycle shortly after inbound activity settles (trailing debounce). */
  nudge(): void
}

export function registerCompanionPush(deps: CompanionPushDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'push',
    intervalMs: deps.intervalMs ?? PUSH_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-push',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}

export interface CompanionIngestDeps extends CompanionPushDeps {
  /** Override the nudge debounce (ms). Tests pass a small value. */
  nudgeDelayMs?: number
}

/**
 * WRITE-side knowledge ingestion loop (25 min cadence + debounced new-message
 * nudge). Same scheduler shape as push; additionally exposes `nudge()` which
 * the inbound path calls per message. Rapid nudges collapse (trailing debounce)
 * to a single extra cycle once activity settles — the `shouldRun` gate is
 * re-checked at fire time so a disabled loop never fires.
 */
export function registerIngest(deps: CompanionIngestDeps): IngestLifecycle {
  const stop = startCompanionScheduler({
    name: 'ingest',
    intervalMs: deps.intervalMs ?? INGEST_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null
  const delay = deps.nudgeDelayMs ?? NUDGE_DELAY_MS

  function nudge(): void {
    if (stopped) return
    if (nudgeTimer) clearTimeout(nudgeTimer)   // trailing: each nudge resets the timer
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null
      if (stopped || !deps.shouldRun()) return
      void Promise.resolve(deps.onTick()).catch(err => deps.log('INGEST', `nudge tick failed: ${err instanceof Error ? err.message : String(err)}`))
    }, delay)
    nudgeTimer.unref?.()   // don't keep the process alive for a pending nudge
  }

  return {
    name: 'companion-ingest',
    stop: async () => {
      if (stopped) return
      stopped = true
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null }
      await stop()
    },
    nudge,
  }
}

export interface CompanionIntrospectDeps extends CompanionPushDeps {}

export function registerCompanionIntrospect(deps: CompanionIntrospectDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'introspect',
    intervalMs: deps.intervalMs ?? INTROSPECT_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-introspect',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}
