/**
 * Report sweeper — the delivery loop for the report outbox (matter_report_outbox,
 * v65). Structurally mirrors src/daemon/reminders/sweeper.ts (the "先读" pointer
 * in task-3-brief.md): every `intervalMs` it asks the outbox store for pending
 * rows whose next_at has passed and delivers each via `send(chatId, text)`.
 *
 * Where it resolves the target chat: NOT the task's own wechat binding (a task
 * can outlive/rebind independently) but the ORIGIN matter's — the chat that
 * gave birth to this task (matters.bindings(originMatterId)). That's the
 * "回到那次对话里说一声" contract.
 *
 * Failure routing (brief Step 6, three-way):
 *   - No wechat binding on the origin matter at all → permanent failure
 *     ("chat 不存在"): markDropped, log, never retried.
 *   - errcode=-2 (proactive push window closed, same detector as reminders'
 *     outbound-health.ts) → recordAttempt, stays pending, exponential backoff.
 *   - Any other send failure → same treatment (recordAttempt + backoff).
 * Unlike reminders, there is NO give-up time window here — the outbox's
 * "trace" already lives in the origin conversation, so a late report is still
 * correct; the rule is "the user's turn came back, so did the report", not
 * "give up after N hours" (brief: 绝不烧重试).
 *
 * Backoff is reused verbatim from reminders/sweeper.ts's exported backoffMs
 * (1min, 2min, 4min, … capped at 60min) — brief: "不要另发明退避".
 */
import type {Lifecycle} from '../../lib/lifecycle'
import type {MatterStore} from '../../core/matters/store'
import type {ReportOutboxStore} from './outbox'
import {isProactiveWindowClosed} from '../ilink/outbound-health'
import {backoffMs} from '../reminders/sweeper'

export interface ReportSweepDeps {
  store: ReportOutboxStore
  matters: MatterStore
  /** Deliver a message to a chat. Resolves {ok} — never throws for normal failures. */
  send: (chatId: string, text: string) => Promise<{ok: boolean; error?: string}>
  /** Current time, injected for tests. */
  nowMs: number
  log: (tag: string, line: string) => void
  /** Override the per-sweep send-attempt budget (same burst-guard rationale as reminders). */
  maxSendsPerSweep?: number
}

export interface ReportSweepResult {
  delivered: number
  retried: number
  dropped: number
  deferred: number
}

/** Per-sweep send-attempt budget — same WeChat-risk-control rationale as reminders/sweeper.ts. */
export const MAX_SENDS_PER_SWEEP = 30

export async function runReportSweep(deps: ReportSweepDeps): Promise<ReportSweepResult> {
  const maxSends = deps.maxSendsPerSweep ?? MAX_SENDS_PER_SWEEP
  const due = await deps.store.listDue(deps.nowMs)
  const result: ReportSweepResult = {delivered: 0, retried: 0, dropped: 0, deferred: 0}
  let sendAttempts = 0

  for (const rec of due) {
    // Origin chat lookup happens before the budget gate: it's a pure read,
    // not an outbound send, so it doesn't count against the burst guard.
    const chatId = deps.matters.bindings(rec.originMatterId).find(b => b.surface === 'wechat')?.surfaceKey
    if (!chatId) {
      await deps.store.markDropped(rec.id)
      result.dropped++
      deps.log('REPORTS', `dropped ${rec.id} (matter ${rec.matterId}): origin matter ${rec.originMatterId} has no wechat binding`)
      continue
    }

    if (sendAttempts >= maxSends) {
      result.deferred++
      continue
    }
    sendAttempts++

    let outcome: {ok: boolean; error?: string}
    try {
      outcome = await deps.send(chatId, rec.text)
    } catch (err) {
      outcome = {ok: false, error: err instanceof Error ? err.message : String(err)}
    }

    if (outcome.ok) {
      await deps.store.markSent(rec.id)
      result.delivered++
      deps.log('REPORTS', `delivered ${rec.id} (matter ${rec.matterId}) → ${chatId}`)
      continue
    }

    const err = outcome.error ?? 'unknown_error'
    const nextAttempts = rec.attempts + 1
    await deps.store.recordAttempt(rec.id, deps.nowMs + backoffMs(nextAttempts))
    result.retried++
    if (isProactiveWindowClosed(err)) {
      deps.log('REPORTS', `deferred ${rec.id} (matter ${rec.matterId}) → ${chatId}(推送窗口未开,等主人回来即送): ${err}`)
    } else {
      deps.log('REPORTS', `retry recorded ${rec.id} (matter ${rec.matterId}) → ${chatId}(backoff applies): ${err}`)
    }
  }

  return result
}

const DEFAULT_INTERVAL_MS = 60 * 1000 // 60s

export interface ReportSchedulerDeps {
  store: ReportOutboxStore
  matters: MatterStore
  send: (chatId: string, text: string) => Promise<{ok: boolean; error?: string}>
  log: (tag: string, line: string) => void
  /** Override sweep interval (ms). Defaults to 60s. */
  intervalMs?: number
}

/**
 * Start the periodic sweeper. Returns a Lifecycle whose stop() is idempotent.
 * Same "schedule then fire" cadence as reminders — no burst at boot.
 */
export function registerReportSweeper(deps: ReportSchedulerDeps): Lifecycle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(async () => {
      timer = null
      if (stopped) return
      try {
        await runReportSweep({
          store: deps.store,
          matters: deps.matters,
          send: deps.send,
          nowMs: Date.now(),
          log: deps.log,
        })
      } catch (err) {
        deps.log('REPORTS', `sweep failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      scheduleNext()
    }, intervalMs)
  }

  scheduleNext()
  deps.log('REPORTS', `report sweeper started — interval ${intervalMs}ms`)

  return {
    name: 'reports',
    stop: async () => {
      if (stopped) return
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
  }
}
