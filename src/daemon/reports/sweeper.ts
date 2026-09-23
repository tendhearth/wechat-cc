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
 * Failure routing (brief Step 6, three-way; sharpened by evaluation rounds 1-3):
 *   - No wechat binding on the origin matter at all → permanent failure
 *     ("chat 不存在"): markDropped, log, never retried.
 *   - errcode=-2 (proactive push window closed, same detector as reminders'
 *     outbound-health.ts) → recordAttempt, stays pending, exponential backoff,
 *     counted as `deferred` (matching reminders' counting convention — this
 *     isn't a delivery problem, it's "the window isn't open yet"). NEVER
 *     given up on, at any attempts count or elapsed time: "不计入放弃窗口"
 *     is brief's own words for exactly this case — the window reopens the
 *     moment the owner sends anything, however long that takes, and giving
 *     up would silently lose the report.
 *   - Any other send failure (account disconnected, risk-controlled, network
 *     down) → recordAttempt + backoff too, counted as `retried`, until a
 *     TIME-based give-up window elapses since the row's FIRST real failure
 *     (`first_fail_at`, v66 — NOT `created_at`, see below), same shape and
 *     same value as reminders' RETRY_WINDOW_MS (24h) — past it, markDropped,
 *     log, AND leave a system event on the matter's own timeline (evaluation
 *     round 3 issue ③ — see further down).
 *
 * Evaluation round 2 finding: an attempts-COUNT cap (the round-1 fix) is
 * wrong here because `attempts` is a single field shared by BOTH failure
 * kinds. A matter can rack up dozens of -2 attempts over a day the owner
 * never messages (each one legitimately NOT given up on), and then the
 * very next attempt happens to be a transient non-(-2) blip — with a count
 * cap, that ordinary blip reads as "already exhausted" and gets dropped on
 * the spot, even though it's a fresh failure that just arrived. Time doesn't
 * have this problem: -2 attempts never advance the row past a time window
 * that only non-(-2) failures ever check, because -2 never checks it at
 * all. `attempts` now does exactly one job — picking the backoff tier via
 * `backoffMs` — never "how many strikes before we give up".
 *
 * Evaluation round 3 finding: round 2's time window was still wrong — it was
 * anchored at `created_at` (when the row was first queued). A day the owner
 * never messages is a day of -2 deferrals; `created_at` keeps getting older
 * relative to `now` the whole time, so by the time the FIRST real (non-(-2))
 * failure finally happens, `created_at` may already be past the 24h window
 * — that one ordinary failure gets dropped on the spot, exactly the bug
 * round 2 set out to fix, just with a different trigger. `first_fail_at`
 * (v66) only gets written the first time a non-(-2) failure actually
 * happens (COALESCE — first write wins, outbox.ts), so -2 deferrals never
 * start OR advance this clock; the window only ever measures "how long has
 * it ACTUALLY been failing to send", which is what "give up after N hours"
 * is supposed to mean.
 *
 * Volume control on the way IN, not just the way out (evaluation round 1 ②):
 * `store.insert` (outbox.ts) merges repeat enqueues for the same matter into
 * one pending row instead of accumulating unboundedly — see its doc comment.
 * That's what keeps a chatty flapping round, or a day the owner never
 * replies, from ever producing more than one pending row per matter; this
 * sweeper doesn't need (and doesn't have) a separate per-chat cap.
 *
 * Backoff is reused verbatim from reminders/sweeper.ts's exported backoffMs
 * (1min, 2min, 4min, … capped at 60min) — brief: "不要另发明退避".
 *
 * Give-up visibility (evaluation round 3 issue ③): when a report is finally
 * given up on (the retry-window branch above; NOT the no-wechat-binding
 * branch — that one stays out of scope per the controller's ruling), the
 * owner would otherwise never learn it happened — no message in the origin
 * chat (that's exactly what failed), nothing anywhere else. `noteAbandoned`,
 * when wired, writes a system event onto the MATTER'S OWN timeline (visible
 * in its desktop/phone detail view) saying delivery failed but the task
 * itself is fine. It's optional (like `log`'s sibling deps elsewhere in this
 * codebase) so existing tests that don't care about it need no changes.
 *
 * Quiet gate (task-4-brief.md, "粗闸降噪"): the call point for
 * `shouldDisturb` (core/matters/report.ts) is HERE, in the send loop — not
 * at enqueue time. Enqueue (rendering a report) is "did this round produce
 * something to say", which must happen — and leave its trace — every round,
 * origin-side, regardless of whether the owner is watching right now.
 * Disturb-or-not is "is now a good moment to buzz the owner's WeChat", which
 * only makes sense to ask right before an actual send. Same origin wechat
 * binding already resolved for `chatId` supplies `lastSeenAt` too, so this
 * is a second pure read, no extra query.
 *
 * A gated row is NOT a failure: it must never call `recordAttempt` (no
 * `first_fail_at`, no backoff) or `markDropped`. It's counted separately
 * (`result.held`) and simply left untouched in `pending` at its existing
 * `next_at` — the next sweep re-evaluates it fresh. Backing off or dropping
 * a held row would turn "the owner is looking at this right now" into a
 * lost or delayed delivery, exactly the failure mode the retry-window
 * plumbing above was hardened against in evaluation rounds 1-3.
 */
import type {Lifecycle} from '../../lib/lifecycle'
import type {MatterStore} from '../../core/matters/store'
import type {ReportOutboxStore} from './outbox'
import {isProactiveWindowClosed} from '../ilink/outbound-health'
import {backoffMs, RETRY_WINDOW_MS} from '../reminders/sweeper'
import {shouldDisturb} from '../../core/matters/report'

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
  /** Override the non-(-2) give-up window (ms). Defaults to reminders' RETRY_WINDOW_MS (24h). */
  retryWindowMs?: number
  /**
   * Write a system event onto the given matter's own event timeline (e.g.
   * `workbenchStore.addEvent(matterId, 'system', text)`). Called when a
   * report is given up on for good (retry-window exhausted), so the owner
   * has SOMEWHERE to see it happened. Optional — a caller that doesn't wire
   * it just gets the existing log-only behavior.
   */
  noteAbandoned?: (matterId: string, text: string) => void
}

export interface ReportSweepResult {
  delivered: number
  retried: number
  dropped: number
  deferred: number
  /** Held back by the quiet gate (shouldDisturb) this sweep — not a failure, stays pending. */
  held: number
}

/** Per-sweep send-attempt budget — same WeChat-risk-control rationale as reminders/sweeper.ts. */
export const MAX_SENDS_PER_SWEEP = 30

export async function runReportSweep(deps: ReportSweepDeps): Promise<ReportSweepResult> {
  const maxSends = deps.maxSendsPerSweep ?? MAX_SENDS_PER_SWEEP
  const retryWindow = deps.retryWindowMs ?? RETRY_WINDOW_MS
  const due = await deps.store.listDue(deps.nowMs)
  const result: ReportSweepResult = {delivered: 0, retried: 0, dropped: 0, deferred: 0, held: 0}
  let sendAttempts = 0

  for (const rec of due) {
    // Origin chat lookup happens before the budget gate: it's a pure read,
    // not an outbound send, so it doesn't count against the burst guard.
    const originBinding = deps.matters.bindings(rec.originMatterId).find(b => b.surface === 'wechat')
    const chatId = originBinding?.surfaceKey
    if (!chatId) {
      await deps.store.markDropped(rec.id)
      result.dropped++
      deps.log('REPORTS', `dropped ${rec.id} (matter ${rec.matterId}): origin matter ${rec.originMatterId} has no wechat binding`)
      continue
    }

    // Quiet gate, also a pure read (same binding), also ahead of the budget
    // gate. A held row is NOT a failure — no recordAttempt/markDropped, no
    // backoff, no first_fail_at — it just stays pending for the next sweep.
    // See the quiet-gate doc block above the imports for why the call point
    // is here and not at enqueue time.
    if (!shouldDisturb({lastSeenAt: originBinding.lastSeenAt, now: deps.nowMs})) {
      result.held++
      deps.log('REPORTS', `held ${rec.id} (matter ${rec.matterId}) → ${chatId}: 主人正看着这件事(粗判据),下一拍再看,不计失败`)
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

    if (isProactiveWindowClosed(err)) {
      // 不计入放弃窗口:errcode=-2 完全不参与放弃判定,不传 firstFailureAt
      // 给 recordAttempt——first_fail_at 不会被这一类失败写入或推进
      // (评审修复轮 3 ①)。attempts 在这里只用来选退避档位。
      await deps.store.recordAttempt(rec.id, deps.nowMs + backoffMs(nextAttempts))
      result.deferred++
      deps.log('REPORTS', `deferred ${rec.id} (matter ${rec.matterId}) → ${chatId}(推送窗口未开,等主人回来即送): ${err}`)
      continue
    }

    // 非 -2 失败的放弃按时间窗口,锚点是 first_fail_at(这一行第一次真的失败的
    // 时刻),不是 created_at——主人不在的这段时间全是 -2 deferral,created_at
    // 早就"过期"了,锚在那儿会把第一次真失败就误判成"早该放弃"(评审修复轮 3
    // ①,这正是修复轮 2 的原场景没被真正解决的原因)。first_fail_at 还没写过
    // (rec.firstFailAt===null)就说明这是第一次真失败,不可能已经过了窗口。
    const deadline = rec.firstFailAt !== null ? rec.firstFailAt + retryWindow : null
    if (deadline !== null && deps.nowMs > deadline) {
      await deps.store.markDropped(rec.id)
      result.dropped++
      deps.log('REPORTS', `dropped ${rec.id} (matter ${rec.matterId}) → ${chatId}: giving up after retry window: ${err}`)
      // 放弃对主人完全不可见的话,这条回报就是真的凭空消失了(评审修复轮 3
      // ③)——那件事自己的事件流上留一笔,桌面/手机详情页看得到。微信这条路
      // 不会再试:发不出去正是它被放弃的原因。best-effort,失败不影响放弃本身。
      try { deps.noteAbandoned?.(rec.matterId, '这条回报没能送到微信，任务本身没问题——可以在这里看到完整经过。') } catch { /* best effort */ }
      continue
    }

    await deps.store.recordAttempt(rec.id, deps.nowMs + backoffMs(nextAttempts), deps.nowMs)
    result.retried++
    deps.log('REPORTS', `retry recorded ${rec.id} (matter ${rec.matterId}) → ${chatId}(backoff applies): ${err}`)
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
  /** See runReportSweep's ReportSweepDeps.noteAbandoned — same contract, threaded through. */
  noteAbandoned?: (matterId: string, text: string) => void
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
          noteAbandoned: deps.noteAbandoned,
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
