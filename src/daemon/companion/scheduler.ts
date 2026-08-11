/**
 * Companion v2 scheduler — dead-simple periodic tick.
 *
 * Replaces the v1 croner-based per-trigger scheduler. No more per-trigger
 * logic; no more isolated eval sessions. We only provide what Claude can't:
 * a timer that wakes it up.
 *
 * On every tick (when enabled + not snoozed), `onTick` is called. The
 * supplied onTick reads the chat's `agenda.md` and only wakes Claude when a
 * self-authored intention is due (default = act); when nothing is due it
 * returns silently without an LLM call.
 */

export interface CompanionSchedulerDeps {
  /** Base interval between ticks (e.g. 20 * 60_000 for 20 min). */
  intervalMs: number
  /** Fraction of intervalMs used as ± jitter (e.g. 0.3 → ±30%). */
  jitterRatio: number
  /**
   * Combined gate: returns true if the tick should run right now. Wiring
   * implementation reads companion config once and answers both
   * "enabled?" and "not snoozed?" — avoids the prior two-call pattern
   * which loaded the config twice and could race against `开启 companion`
   * + `别烦我` arriving between the reads.
   */
  shouldRun: () => boolean
  /** Wake Claude up. Exceptions are swallowed + logged. */
  onTick: () => Promise<void>
  log: (tag: string, line: string) => void
  /** Optional name for log disambiguation (e.g. 'push', 'introspect'). */
  name?: string
  /**
   * Max time to await a single onTick before giving up and scheduling the
   * next one. A wedged tick (stuck agenda read / hung dispatch) must not stall
   * the recursive scheduler forever — the orphaned tick is left to settle (or
   * leak) on its own, but cadence is preserved. Default 11 min (just over the
   * 10-min turn watchdog, so a legitimately slow dispatch isn't cut short).
   */
  tickTimeoutMs?: number
  /**
   * busy-registry hold (spec 2026-08-11 §2, Task 5) — held for the
   * duration of a running tick. ingest's silence threshold is stricter
   * than the self-restart idle threshold, so a running tick is exactly
   * the work most likely to be misjudged as "idle" and killed. Optional,
   * defaults to no-op (same shape as Task 4's holdBusy? seam); never lets
   * a throwing registry block the tick itself.
   */
  holdBusy?: (label: string) => () => void
}

const DEFAULT_TICK_TIMEOUT_MS = 11 * 60_000

/**
 * Upper bound stop() waits for an in-flight tick to settle before giving up
 * and returning anyway (spec 2026-08-11 §6). Kept below LifecycleSet's 5s
 * per-handle stop budget (src/lib/lifecycle.ts) so a wedged tick can't by
 * itself blow that budget.
 */
export const STOP_WAIT_CAP_MS = 4_000

export function startCompanionScheduler(deps: CompanionSchedulerDeps): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // The in-flight tick's promise, tracked so stop() can wait for it (bounded).
  // Cleared once the tick settles, regardless of outcome.
  let current: Promise<void> | null = null

  function scheduleNext(): void {
    if (stopped) return
    const jitter = deps.intervalMs * deps.jitterRatio
    // 100 ms floor protects against pathological tiny intervals; real usage
    // sits in the minutes range so this is effectively a no-op in production.
    const wait = Math.max(100, deps.intervalMs + (Math.random() * 2 - 1) * jitter)
    timer = setTimeout(async () => {
      timer = null
      if (stopped) return
      try {
        if (deps.shouldRun()) {
          const p = runHeldTick()
          current = p
          await p
        }
      } catch (err) {
        deps.log('SCHED', `${deps.name ?? 'companion'} tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      scheduleNext()
    }, wait)
  }

  // Wraps runBoundedTick with a busy-registry hold spanning the whole call
  // (including the tickTimeoutMs guard window) and clears `current` once it
  // settles. holdBusy itself must never throw into the tick's own outcome.
  function runHeldTick(): Promise<void> {
    let release: (() => void) | undefined
    try {
      release = deps.holdBusy?.(`companion-${deps.name ?? 'tick'}`)
    } catch {
      release = undefined
    }
    const p = runBoundedTick().finally(() => {
      try { release?.() } catch { /* release 幂等且不抛,防御性 */ }
      if (current === p) current = null
    })
    return p
  }

  // Await onTick but never longer than tickTimeoutMs — a wedged tick must not
  // hold the recursive scheduler (which only re-arms AFTER onTick settles). The
  // orphaned promise is left to resolve/leak on its own; we just stop waiting.
  async function runBoundedTick(): Promise<void> {
    const timeoutMs = deps.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS
    let t: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<void>((resolve) => {
      t = setTimeout(() => {
        deps.log('SCHED', `${deps.name ?? 'companion'} tick exceeded ${timeoutMs}ms — proceeding without it`)
        resolve()
      }, timeoutMs)
    })
    try {
      await Promise.race([deps.onTick(), guard])
    } finally {
      if (t) clearTimeout(t)
    }
  }

  scheduleNext()
  deps.log('SCHED', `${deps.name ?? 'companion'} scheduler started — interval ${deps.intervalMs}ms ± ${Math.round(deps.jitterRatio * 100)}%`)

  return async () => {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    // Graceful shutdown for a tick means actually waiting for it, not just
    // yanking the timer — but bounded, so a wedged tick can't hang shutdown
    // forever (spec 2026-08-11 §6). The orphaned promise (if any) is left to
    // settle on its own past the cap, same as the tickTimeoutMs guard above.
    const pending = current
    if (pending) {
      let capTimer: ReturnType<typeof setTimeout> | undefined
      const cap = new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, STOP_WAIT_CAP_MS)
      })
      try {
        await Promise.race([pending, cap])
      } finally {
        // If `pending` wins the race, the cap timer is still armed — clear it
        // so it doesn't linger in the event loop for the full 4s past
        // shutdown (three schedulers stopping = up to 3 stray timers).
        if (capTimer) clearTimeout(capTimer)
      }
    }
  }
}
