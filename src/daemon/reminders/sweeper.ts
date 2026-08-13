/**
 * Reminder sweeper — the precise-time delivery loop for the reminders store.
 *
 * Every `intervalMs` (default 60s) it asks the store for pending reminders
 * whose due_at has passed and delivers each via `send(chat_id, text)`. This
 * is what makes reminders multi-user and minute-precise without depending on
 * the operator-only, day-granular companion tick.
 *
 * Delivery can fail transiently — most commonly because the target chat's
 * ilink context_token has expired (the same cause as errcode=-14). Policy:
 *   - success            → markSent
 *   - failure, still in retry window (due_at + RETRY_WINDOW_MS) → recordAttempt, stay pending
 *   - failure, past window                                       → markFailed
 *
 * runReminderSweep is exported and side-effect-injected (store + send + now)
 * so it's unit-testable without a timer or a live ilink.
 */
import type { Lifecycle } from '../../lib/lifecycle'
import type { RemindersStore } from './store'

/** How long after due_at we keep retrying a failing delivery before giving up. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface SweepDeps {
  store: RemindersStore
  /** Deliver a message to a chat. Resolves {ok} — never throws for normal failures. */
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  /** Current time, injected for tests. */
  nowIso: string
  log: (tag: string, line: string) => void
  retryWindowMs?: number
}

export interface SweepResult {
  delivered: number
  retried: number
  failed: number
}

/**
 * Process one sweep: deliver every due reminder, applying the retry policy.
 * Pure w.r.t. wall-clock (now is injected); the only side effects are through
 * the injected store + send.
 */
export async function runReminderSweep(deps: SweepDeps): Promise<SweepResult> {
  const retryWindow = deps.retryWindowMs ?? RETRY_WINDOW_MS
  const nowMs = Date.parse(deps.nowIso)
  const due = await deps.store.listDue(deps.nowIso)
  const result: SweepResult = { delivered: 0, retried: 0, failed: 0 }

  for (const rec of due) {
    let outcome: { ok: boolean; error?: string }
    try {
      outcome = await deps.send(rec.chat_id, rec.text)
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.ok) {
      await deps.store.markSent(rec.id)
      result.delivered++
      deps.log('REMINDERS', `delivered ${rec.id} → ${rec.chat_id}`)
      continue
    }

    const err = outcome.error ?? 'unknown_error'
    const deadline = Date.parse(rec.due_at) + retryWindow
    if (Number.isFinite(deadline) && nowMs > deadline) {
      await deps.store.markFailed(rec.id, err)
      result.failed++
      deps.log('REMINDERS', `gave up on ${rec.id} → ${rec.chat_id} after retry window: ${err}`)
    } else {
      await deps.store.recordAttempt(rec.id, err)
      result.retried++
      deps.log('REMINDERS', `deferred ${rec.id} → ${rec.chat_id} (will retry): ${err}`)
    }
  }

  return result
}

const DEFAULT_INTERVAL_MS = 60 * 1000 // 60s

export interface ReminderSchedulerDeps {
  store: RemindersStore
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  log: (tag: string, line: string) => void
  /** Override sweep interval (ms). Defaults to 60s. */
  intervalMs?: number
}

/**
 * Start the periodic sweeper. Returns a Lifecycle whose stop() is idempotent.
 * The first sweep runs after one interval (not immediately) — matching the
 * companion scheduler's "schedule then fire" cadence and avoiding a burst at
 * boot before the rest of the daemon is settled.
 */
export function registerReminders(deps: ReminderSchedulerDeps): Lifecycle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(async () => {
      timer = null
      if (stopped) return
      try {
        await runReminderSweep({
          store: deps.store,
          send: deps.send,
          nowIso: new Date().toISOString(),
          log: deps.log,
        })
      } catch (err) {
        deps.log('REMINDERS', `sweep failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      scheduleNext()
    }, intervalMs)
  }

  scheduleNext()
  deps.log('REMINDERS', `reminder sweeper started — interval ${intervalMs}ms`)

  return {
    name: 'reminders',
    stop: async () => {
      if (stopped) return
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
  }
}
