/**
 * policy.say —— CC 主动开口只有这一道门(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)。
 *
 * 先判(core/speech/decide,纯函数),allow 才从 proactive-channel 开一轮交给生产者;发完收尾。被拒 / 被推后时
 * 生产者根本不跑 —— 调模型这种贵的事放在判定之后,被免打扰挡住的那一拍一个 token 都不花。
 * 「能不能说」在这里,「往哪儿送」(微信 / 降级走 App)仍是 proactive-channel 的事。
 *
 * 每次判定记一行账(种类、类别、结果、原因、通道、时间;**不记正文**),回答「CC 为什么说了 / 没说」。
 * 第 1 步只加不接:还没有调用方,行为不变。
 */
import { decideSpeech, type CareSetting, type SpeechDecision } from '../../core/speech/decide'
import { originOf, type SpeechKind, type SpeechOrigin } from '../../core/speech/kinds'
import type { ProactiveChannel, ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'

export interface SpeechRequest {
  kind: SpeechKind
  chatId: string
  /** 这一种自己的频率 / 冷却(只对 initiative 生效)。 */
  perKind?: { ok: true } | { ok: false; reason: string }
  /** 定时触发的(晨报、周报):赶上免打扰当天记 skipped:quiet。 */
  scheduled?: boolean
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
}): SpeechPolicy {
  const now = deps.now ?? Date.now
  const write = (e: SpeechLedgerEntry): void => {
    try { deps.ledger?.(e) } catch (err) { deps.log('SPEECH', `ledger write failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return {
    async say(req, produce) {
      const nowMs = now()
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
      if (!('allow' in decision)) {
        write({ ...base, outcome: 'defer' in decision ? 'deferred' : 'dropped', reason: decision.reason, channel: null })
        deps.log('SPEECH', `${req.kind} chat=${req.chatId} ${'defer' in decision ? 'deferred' : 'dropped'}: ${decision.reason}`)
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
  }
}
