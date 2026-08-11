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
  /**
   * busy-registry hold (spec 2026-08-11 §2, Task 5/6) — forwarded straight
   * to startCompanionScheduler, which holds a token for the duration of
   * every running tick. Absent ⇒ no-op, exactly as before this feature
   * existed. Wired from bootstrap's `boot.holdBusy` in
   * src/daemon/wiring/lifecycle-deps.ts — this is the seam Task 5 left
   * unforwarded and Task 6 closes: ingest's silence threshold is stricter
   * than the self-restart idle threshold, so a running ingest tick is
   * exactly the work most likely to be misjudged as "idle" without it.
   */
  holdBusy?: (label: string) => () => void
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
  const scheduler = startCompanionScheduler({
    name: 'push',
    intervalMs: deps.intervalMs ?? PUSH_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
    holdBusy: deps.holdBusy,
  })
  let stopped = false
  return {
    name: 'companion-push',
    stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } },
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
  const scheduler = startCompanionScheduler({
    name: 'ingest',
    intervalMs: deps.intervalMs ?? INGEST_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
    holdBusy: deps.holdBusy,
  })
  let stopped = false
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null
  const delay = deps.nudgeDelayMs ?? NUDGE_DELAY_MS

  function nudge(): void {
    if (stopped) return
    if (nudgeTimer) clearTimeout(nudgeTimer)   // trailing: each nudge resets the timer
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null
      if (stopped) return
      // Code review fix (C1, 2026-08-11): this used to call `deps.onTick()`
      // directly — bypassing the scheduler entirely, so a nudge-triggered
      // ingest run held NO busy token, had NO tickTimeoutMs guard, and was
      // invisible to stop()'s wait-for-in-flight. The nudge fires
      // NUDGE_DELAY_MS (3 min) into silence — i.e. right as `quietFor`
      // crosses the self-restart idle threshold (120s) — so a HEAD change
      // could kill a mid-flight ingest run every single time it fired.
      // scheduler.runNow() routes through the SAME held+guarded+tracked
      // path a cadence tick uses (it also re-checks shouldRun() itself, so
      // the check that used to live here is redundant and removed).
      void scheduler.runNow().catch(err => deps.log('INGEST', `nudge tick failed: ${err instanceof Error ? err.message : String(err)}`))
    }, delay)
    nudgeTimer.unref?.()   // don't keep the process alive for a pending nudge
  }

  return {
    name: 'companion-ingest',
    stop: async () => {
      if (stopped) return
      stopped = true
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null }
      // scheduler.stop() now also waits (bounded) for a nudge-triggered run
      // in flight — it's tracked through the same `current` the scheduler
      // uses for cadence ticks, since runNow() goes through runHeldTick().
      await scheduler.stop()
    },
    nudge,
  }
}

export interface CompanionIntrospectDeps extends CompanionPushDeps {}

export function registerCompanionIntrospect(deps: CompanionIntrospectDeps): Lifecycle {
  const scheduler = startCompanionScheduler({
    name: 'introspect',
    intervalMs: deps.intervalMs ?? INTROSPECT_INTERVAL_MS,
    jitterRatio: JITTER,
    shouldRun: deps.shouldRun,
    log: deps.log,
    onTick: deps.onTick,
    holdBusy: deps.holdBusy,
  })
  let stopped = false
  return {
    name: 'companion-introspect',
    stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } },
  }
}
