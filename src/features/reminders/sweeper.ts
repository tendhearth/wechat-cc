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
 *   - failure, past window AND tried MIN_ATTEMPTS_BEFORE_GIVE_UP times → markFailed
 *
 * runReminderSweep is exported and side-effect-injected (store + send + now)
 * so it's unit-testable without a timer or a live ilink.
 */
import type { Lifecycle } from '../../lib/lifecycle'
import { backoffMs, RETRY_WINDOW_MS } from '../../lib/delivery-backoff'
export { backoffMs, RETRY_WINDOW_MS }
import type { RemindersStore } from './store'
import { isProactiveWindowClosed } from '../../daemon/ilink/outbound-health'
import { toLocalISO } from '../../core/prompt-format'

/**
 * 过了重试窗口也要至少真试过这么多次才放弃。窗口从 due_at 算,电脑睡/断网
 * 超过 24h 后醒来第一轮 sweep 往往网络还没连上 —— 只看窗口会在第一下失败
 * 就把提醒判死(-2 那条分支防的同一种「主人设的提醒悄悄丢了」)。5 次按
 * 退避(1+2+4+8 分钟)约一刻钟,够网络恢复。
 */
export const MIN_ATTEMPTS_BEFORE_GIVE_UP = 5

/**
 * Per-sweep send-attempt budget (review issue 1b). Backoff only spaces out
 * *retries* — the unbounded first-attempt case (many reminders due in the
 * same sweep) was still a burst path straight into ilink.sendMessage, which
 * is exactly what WeChat risk control watches. Rows beyond the budget are
 * left untouched (not attempted, not backed off) and are picked up on the
 * next sweep — listDue's `due_at ASC` ordering means the oldest-due rows
 * always get first crack at the budget.
 */
export const MAX_SENDS_PER_SWEEP = 30

export interface SweepDeps {
  store: RemindersStore
  /** Deliver a message to a chat. Resolves {ok} — never throws for normal failures. */
  /**
   * 送一条提醒。`deferred` = CC 开口那道门(SpeechPolicy,第三批 3a)说两条路都送不到 —— 不是失败:
   * 不算尝试、不退避,也不进放弃窗口;下一拍再问,通了就送(迟到的照常带说明)。
   */
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string; deferred?: string }>
  /** Current time, injected for tests. */
  nowIso: string
  log: (tag: string, line: string) => void
  retryWindowMs?: number
  /** Override the per-sweep send-attempt budget. Defaults to MAX_SENDS_PER_SWEEP. */
  maxSendsPerSweep?: number
  /** 「CC 做过的事」补记(B9):主人的提醒送到了 ⇒ 记一行(只有提醒 id,不记原文)。 */
  activityLog?: { append(e: { kind: 'reminder'; status: string; ref?: string }): void }
  isOwner?: (chatId: string) => boolean
}

export interface SweepResult {
  delivered: number
  retried: number
  failed: number
  deferred: number
}

/**
 * Process one sweep: deliver every due reminder, applying the retry policy.
 * Pure w.r.t. wall-clock (now is injected); the only side effects are through
 * the injected store + send.
 */
/** 迟到多久才在提醒前加说明(正常一次 sweep 内送达不算迟)。 */
export const LATE_REMINDER_THRESHOLD_MS = 30 * 60_000

/**
 * 迟到的提醒前置一句 CC 口吻的说明,让「晚 2 小时突然弹出的记得吃药」不
 * 迷惑(2026-08-27:票据过期/网络抖动会让提醒迟到送达,原文照发读起来
 * 像凭空冒出来)。未超阈值 → 原文。无 emoji,符合 CC 身份。
 */
/** 晚了多久(提醒不再 24 小时就放弃,可能晚好几天 —— 主人一眼要看出还用不用管;整合者评审 #523)。 */
function lateBy(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

export function lateReminderText(text: string, dueAtIso: string, nowMs: number): string {
  const due = Date.parse(dueAtIso)
  if (!Number.isFinite(due) || nowMs - due < LATE_REMINDER_THRESHOLD_MS) return text
  const local = toLocalISO(due)            // 2026-08-27T15:00:00-07:00
  const md = local.slice(5, 10).replace('-', '月') + '日'   // 08月27日
  const hm = local.slice(11, 16)                             // 15:00
  return `这条提醒晚了 ${lateBy(nowMs - due)}(本该 ${md} ${hm} 提醒你)——刚才没连上你,现在补给你:\n${text}`
}

export async function runReminderSweep(deps: SweepDeps): Promise<SweepResult> {
  const retryWindow = deps.retryWindowMs ?? RETRY_WINDOW_MS
  const maxSends = deps.maxSendsPerSweep ?? MAX_SENDS_PER_SWEEP
  const nowMs = Date.parse(deps.nowIso)
  const due = await deps.store.listDue(deps.nowIso)
  const result: SweepResult = { delivered: 0, retried: 0, failed: 0, deferred: 0 }
  let sendAttempts = 0

  for (const rec of due) {
    // Backoff gate: a previously-failed reminder is only eligible again once
    // its exponential backoff has elapsed. Fresh reminders (attempts=0 /
    // last_attempt_at null) pass straight through.
    if (rec.attempts > 0 && rec.last_attempt_at) {
      const eligibleAt = Date.parse(rec.last_attempt_at) + backoffMs(rec.attempts)
      if (Number.isFinite(eligibleAt) && nowMs < eligibleAt) {
        result.deferred++
        continue
      }
    }

    // Per-sweep send budget: rows beyond the budget stay pending untouched
    // (no attempt recorded, no backoff applied) and surface again next sweep.
    if (sendAttempts >= maxSends) {
      result.deferred++
      continue
    }
    sendAttempts++

    let outcome: { ok: boolean; error?: string; deferred?: string }
    try {
      outcome = await deps.send(rec.chat_id, lateReminderText(rec.text, rec.due_at, nowMs))
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.deferred) {
      result.deferred++
      deps.log('REMINDERS', `deferred ${rec.id} → ${rec.chat_id}: ${outcome.deferred}(两条路都送不到,不计失败,通了就送)`)
      continue
    }

    if (outcome.ok) {
      await deps.store.markSent(rec.id)
      result.delivered++
      if (deps.isOwner?.(rec.chat_id)) { try { deps.activityLog?.append({ kind: 'reminder', status: 'sent', ref: rec.id }) } catch { /* 记不上不影响提醒 */ } }
      deps.log('REMINDERS', `delivered ${rec.id} → ${rec.chat_id}`)
      continue
    }

    const err = outcome.error ?? 'unknown_error'
    // 票据过期(errcode=-2)不是提醒的错,是"主人太久没说话、微信主动推送
    // 窗口没开"。窗口一旦被主人下条消息刷新即可送 —— 绝不因 24h 时钟放弃
    // (那会永久丢失一条主人设的提醒),而是保持 pending 退避重试(封顶
    // 60min)。迟到的提醒也是安全网,远好过丢失。(2026-08-27:实机日志抓到
    // 一条提醒 30 次重试后 gave up,含 prepare failed,主人从没收到。)
    if (isProactiveWindowClosed(err)) {
      await deps.store.recordAttempt(rec.id, err, deps.nowIso)
      result.deferred++
      deps.log('REMINDERS', `deferred ${rec.id} → ${rec.chat_id}(推送窗口未开,等主人回来即送): ${err}`)
      continue
    }
    const deadline = Date.parse(rec.due_at) + retryWindow
    // rec.attempts 是此前的失败数,这一次失败是第 attempts+1 次
    if (Number.isFinite(deadline) && nowMs > deadline && rec.attempts + 1 >= MIN_ATTEMPTS_BEFORE_GIVE_UP) {
      await deps.store.markFailed(rec.id, err)
      result.failed++
      deps.log('REMINDERS', `gave up on ${rec.id} → ${rec.chat_id} after retry window: ${err}`)
    } else {
      await deps.store.recordAttempt(rec.id, err, deps.nowIso)
      result.retried++
      deps.log('REMINDERS', `retry recorded ${rec.id} → ${rec.chat_id} (backoff applies): ${err}`)
    }
  }

  return result
}

/**
 * 提醒接到 CC 开口那道门上(第三批 3a,kind=reminder,归 requested:时间是主人自己定的 ⇒ 免打扰、别烦我都照发)。
 *  - 两条路都送不到 ⇒ `deferred`(留着,不算失败);
 *  - 放行 ⇒ 经 proactive-channel 送(微信能用走微信,降级落到 App),结果原样交回,-2 / 退避 / 放弃窗口照旧。
 */
export function sendReminderVia(speech: import('../../daemon/speech/policy').SpeechPolicy, log: (tag: string, line: string) => void): SweepDeps['send'] {
  return async (chatId, text) => {
    let sent: { ok: boolean; error?: string } = { ok: false, error: 'not_sent' }
    const o = await speech.say({ kind: 'reminder', chatId }, async (turn) => {
      const r = await turn.sendText(chatId, text)
      sent = r.error ? { ok: false, error: r.error } : { ok: true }
    })
    if ('defer' in o) return { ok: false, deferred: o.reason }
    if ('drop' in o) return { ok: false, error: `speech_dropped:${o.reason}` }
    if (sent.ok && o.channel === 'app') log('REMINDERS', `chat=${chatId} delivered to the app (wechat not usable)`)
    return sent
  }
}

const DEFAULT_INTERVAL_MS = 60 * 1000 // 60s

export interface ReminderSchedulerDeps {
  store: RemindersStore
  /**
   * 送一条提醒。`deferred` = CC 开口那道门(SpeechPolicy,第三批 3a)说两条路都送不到 —— 不是失败:
   * 不算尝试、不退避,也不进放弃窗口;下一拍再问,通了就送(迟到的照常带说明)。
   */
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string; deferred?: string }>
  log: (tag: string, line: string) => void
  /** Override sweep interval (ms). Defaults to 60s. */
  intervalMs?: number
  activityLog?: SweepDeps['activityLog']
  isOwner?: SweepDeps['isOwner']
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
          ...(deps.activityLog ? { activityLog: deps.activityLog } : {}),
          ...(deps.isOwner ? { isOwner: deps.isOwner } : {}),
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
