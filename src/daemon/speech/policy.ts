/**
 * policy.say —— CC 主动开口只有这一道门(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)。
 *
 * 先判(core/speech/decide,纯函数),allow 才从 proactive-channel 开一轮交给生产者;发完收尾。被拒 / 被推后时
 * 生产者根本不跑 —— 调模型这种贵的事放在判定之后,被免打扰挡住的那一拍一个 token 都不花。
 * 「能不能说」在这里,「往哪儿送」(微信 / 降级走 App)仍是 proactive-channel 的事。
 *
 * 每次判定记一行账(种类、类别、结果、原因、通道、时间;**不记正文**),回答「CC 为什么说了 / 没说」。
 * 例外:同一种话、同一条对话、同一个理由**连着被推后**,账和日志一小时只记一次(9d 评审 #521:一夜免打扰 ×
 * 每拍再问一次,会把账淹掉)。放行 / 被拒 / 失败以后重新算。
 * 第 1 步只加不接:还没有调用方,行为不变。
 */
import { decideSpeech, type CareSetting, type SpeechDecision } from '../../core/speech/decide'
import { originOf, type SpeechKind, type SpeechOrigin } from '../../core/speech/kinds'
import type { ProactiveChannel, ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import { mergePending } from './pending-notices'

export interface SpeechRequest {
  kind: SpeechKind
  chatId: string
  /** 这一种自己的频率 / 冷却(只对 initiative 生效)。 */
  perKind?: { ok: true } | { ok: false; reason: string }
  /** 定时触发的(早报、周报):赶上免打扰当天记 skipped:quiet。 */
  scheduled?: boolean
  /** 调用方这一拍的时刻(伙伴一拍有自己的 nowIso);缺省 = 时钟。免打扰按它判,账按它记。 */
  nowMs?: number
}

export interface SpeechLedgerEntry {
  kind: SpeechKind
  origin: SpeechOrigin
  chatId: string
  outcome: 'allowed' | 'deferred' | 'dropped' | 'failed'
  reason: string | null
  channel: ProactiveChannel | null
  ts: string
}

export type SpeechOutcome = ({ allow: true; channel: ProactiveChannel | null }) | Exclude<SpeechDecision, { allow: true }>

export interface SpeechPolicy {
  say(req: SpeechRequest, produce: (turn: ProactiveTurn) => Promise<void>): Promise<SpeechOutcome>
  /**
   * 一句话的主动开口(系统通知、社交通知 …):问门,放行就发。`send` 缺省 = 经 say 开的那一轮(微信能用走微信,
   * 降级落到 App);社交那几句要经 sendAssistantText 发 —— 它管 App 回话截获与旁听 —— 就把它传进来。
   * **report / blocking 被推后 ⇒ 进「待说」队列**(pending-notices.ts),flushPending 时补说 —— defer 不是不送。
   * 发出去了 ⇒ true;被推后 / 被拒 / 发失败 ⇒ false(调用方可以照旧走自己的兜底,比如桌面通知)。
   */
  tell(kind: SpeechKind, chatId: string, text: string, send?: (chatId: string, text: string) => Promise<unknown>): Promise<boolean>
  /** 压着的几句再问一次门;放行 ⇒ 每条对话合成一句,经 say 开的那一轮发(降级时落到 App),说完清掉。 */
  flushPending(): Promise<void>
}

export function makeSpeechPolicy(deps: {
  /** 这条对话此刻的主动关心档(没设过的主人 = low,见 companion/calibration careLevel)。 */
  care(chatId: string): CareSetting
  /** 在免打扰时段里 ⇒ 时段结束的时刻(毫秒,core/quiet-hours quietEndsAt);不在 ⇒ null。 */
  quietEndsAt(chatId: string, nowMs: number): number | null
  outbound: ProactiveOutbound
  /** 外发账(第 1 步由调用方注入;speech_log 表另起一个 PR)。抛错只记日志。 */
  ledger?: (e: SpeechLedgerEntry) => void
  log: (tag: string, line: string) => void
  now?: () => number
  /** 「待说」队列(没接 ⇒ 推后的 report 就是这一句不说,只用于测试 / 最小嵌入)。 */
  pending?: import('./pending-notices').PendingNotices
}): SpeechPolicy {
  const now = deps.now ?? Date.now
  /** (kind, chatId) → 上一次记下的那次推后(理由 + 时刻)。只在内存里:重启后多记一行无妨。 */
  const lastDefer = new Map<string, { reason: string; at: number }>()
  const DEFER_LOG_EVERY_MS = 60 * 60_000
  const write = (e: SpeechLedgerEntry): void => {
    try { deps.ledger?.(e) } catch (err) { deps.log('SPEECH', `ledger write failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  const policy: SpeechPolicy = {
    async say(req, produce) {
      const nowMs = req.nowMs ?? now()
      const ts = new Date(nowMs).toISOString()
      const ends = deps.quietEndsAt(req.chatId, nowMs)
      const decision = decideSpeech(req.kind, {
        care: deps.care(req.chatId),
        quiet: ends === null ? null : { endsIso: new Date(ends).toISOString() },
        deliverable: deps.outbound.canDeliver(req.chatId),
        ...(req.perKind ? { perKind: req.perKind } : {}),
        ...(req.scheduled ? { scheduled: true } : {}),
      })
      const base = { kind: req.kind, origin: originOf(req.kind), chatId: req.chatId, ts }
      const key = `${req.kind}\u0000${req.chatId}`
      if ('defer' in decision) {
        const prev = lastDefer.get(key)
        if (prev && prev.reason === decision.reason && nowMs - prev.at < DEFER_LOG_EVERY_MS) return decision
        lastDefer.set(key, { reason: decision.reason, at: nowMs })
        write({ ...base, outcome: 'deferred', reason: decision.reason, channel: null })
        deps.log('SPEECH', `${req.kind} chat=${req.chatId} deferred: ${decision.reason}`)
        return decision
      }
      lastDefer.delete(key)
      if ('drop' in decision) {
        write({ ...base, outcome: 'dropped', reason: decision.reason, channel: null })
        deps.log('SPEECH', `${req.kind} chat=${req.chatId} dropped: ${decision.reason}`)
        return decision
      }
      const turn = deps.outbound.open(req.chatId)
      try {
        await produce(turn)
      } catch (err) {
        write({ ...base, outcome: 'failed', reason: err instanceof Error ? err.message : String(err), channel: turn.channel() })
        throw err
      } finally {
        turn.finish()
      }
      write({ ...base, outcome: 'allowed', reason: null, channel: turn.channel() })
      return { allow: true, channel: turn.channel() }
    },
    async tell(kind, chatId, text, send) {
      let sent = false
      const o = await policy.say({ kind, chatId }, async (turn) => {
        if (send) { await send(chatId, text); sent = true; return }
        sent = !(await turn.sendText(chatId, text)).error
      })
      if ('defer' in o && originOf(kind) !== 'initiative' && deps.pending) {
        deps.pending.add({ kind, chatId, text, at: new Date(now()).toISOString() })
        deps.log('SPEECH', `${kind} chat=${chatId} kept to say later (${o.reason})`)
      }
      return sent
    },
    async flushPending() {
      if (!deps.pending) return
      for (const g of deps.pending.groups()) {
        // 有等主人拍板的就按 blocking 问(免打扰不拦);否则按第一条 report 问
        const kind = g.items.find(i => originOf(i.kind) === 'blocking')?.kind ?? g.items[0]!.kind
        let sent = false
        const o = await policy.say({ kind, chatId: g.chatId }, async (turn) => { sent = !(await turn.sendText(g.chatId, mergePending(g.items, g.dropped))).error })
        if ('allow' in o && sent) { deps.pending.clear(g.chatId); deps.log('SPEECH', `told ${g.items.length} pending notice(s) chat=${g.chatId}`) }
      }
    },
  }
  return policy
}
