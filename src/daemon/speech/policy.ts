/**
 * policy.say —— CC 主动开口只有这一道门(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)。
 *
 * 先判(core/speech/decide,纯函数),allow 才从 proactive-channel 开一轮交给生产者;发完收尾。被拒 / 被推后时
 * 生产者根本不跑 —— 调模型这种贵的事放在判定之后,被免打扰挡住的那一拍一个 token 都不花。
 * 「能不能说」在这里,「往哪儿送」(微信 / 降级走 App)仍是 proactive-channel 的事。
 *
 * 每次判定记一行账(种类、类别、结果、原因、通道、时间;**不记正文**),回答「CC 为什么说了 / 没说」。
 * 例外:同一种话、同一条对话、同一个理由**连着被推后**,账和日志一小时只记一次(整合者评审 #521:一夜免打扰 ×
 * 每拍再问一次,会把账淹掉)。放行 / 被拒 / 失败以后重新算。
 * 第 1 步只加不接:还没有调用方,行为不变。
 */
import { decideSpeech, type CareSetting, type SpeechDecision } from '../../domain/speech/decide'
import { isExpiring, originOf, type SpeechKind, type SpeechOrigin } from '../../domain/speech/kinds'
import type { ProactiveChannel, ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import { MAX_FLUSH_CHATS_PER_TICK, mergePending } from './pending-notices'

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
  /**
   * 只问门、不开一轮:给「自己就是通道」的发送口用 —— App 原生推送(speech/push-gate.ts)。判定、记账跟 say 一样;
   * 放行 ⇒ 账记 allowed、channel 记调用方给的那条,发送由调用方自己做。被推后 / 被拒 ⇒ 原样回,怎么补是调用方的事
   * (report / blocking 不能丢)。`deliverable` 由调用方给:推送送不送得到是推送自己的事,跟微信断没断无关。
   * 账上的 allowed 记的是**门的判定**,不是送达:放行以后推到 0 台(没配对 / 都离线)账上照样是 allowed,送达与否看推送自己的日志(#536 评审)。
   */
  ask(req: SpeechRequest, o: { channel: ProactiveChannel; deliverable: boolean }): SpeechOutcome
  /**
   * 只判、不记账、不开一轮(S1):要先花钱(调便宜模型挑候选)的发起方用它在花钱之前问一声「这一拍门会不会放」——
   * 免打扰 / 关心档关着就别挑了。判法和 say 同一份(decideSpeech);真要说的时候照样走 say(那一次才记账)。
   */
  peek(req: SpeechRequest): SpeechDecision
  /**
   * 压着的一样过期了、不再说(S2b):记一行账 outcome=dropped、reason=expired。待说队列自己在 flushPending 里记;
   * 自己就是通道的(App 推送,push-gate)放压着的那几条时调它。
   */
  expired(e: { kind: SpeechKind; chatId: string; channel: ProactiveChannel | null }): void
  /**
   * 「待说」那一拍的尾巴上顺手跑一下(S2b):自己压着东西的通道(App 推送)借这一拍再问一次门 ——
   * 主人提前关了免打扰,压着的推送不必等到原来的时段结束。抛错只记日志。
   */
  onFlush(cb: () => void): void
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
  /** 判一次;推后 / 被拒在这里记账(推后同理由一小时只记一次)。放行的那一行由调用方在发完后记。 */
  const judge = (req: SpeechRequest, deliverable: boolean): { decision: SpeechDecision; base: Omit<SpeechLedgerEntry, 'outcome' | 'reason' | 'channel'> } => {
    const nowMs = req.nowMs ?? now()
    const ts = new Date(nowMs).toISOString()
    const ends = deps.quietEndsAt(req.chatId, nowMs)
    const decision = decideSpeech(req.kind, {
      care: deps.care(req.chatId),
      quiet: ends === null ? null : { endsIso: new Date(ends).toISOString() },
      deliverable,
      ...(req.perKind ? { perKind: req.perKind } : {}),
      ...(req.scheduled ? { scheduled: true } : {}),
    })
    const base = { kind: req.kind, origin: originOf(req.kind), chatId: req.chatId, ts }
    const key = `${req.kind}\u0000${req.chatId}`
    if ('defer' in decision) {
      const prev = lastDefer.get(key)
      if (prev && prev.reason === decision.reason && nowMs - prev.at < DEFER_LOG_EVERY_MS) return { decision, base }
      lastDefer.set(key, { reason: decision.reason, at: nowMs })
      write({ ...base, outcome: 'deferred', reason: decision.reason, channel: null })
      deps.log('SPEECH', `${req.kind} chat=${req.chatId} deferred: ${decision.reason}`)
      return { decision, base }
    }
    lastDefer.delete(key)
    if ('drop' in decision) {
      write({ ...base, outcome: 'dropped', reason: decision.reason, channel: null })
      deps.log('SPEECH', `${req.kind} chat=${req.chatId} dropped: ${decision.reason}`)
    }
    return { decision, base }
  }
  const flushHooks: Array<() => void> = []
  const policy: SpeechPolicy = {
    onFlush(cb) { flushHooks.push(cb) },
    expired(e) {
      write({ kind: e.kind, origin: originOf(e.kind), chatId: e.chatId, outcome: 'dropped', reason: 'expired', channel: e.channel, ts: new Date(now()).toISOString() })
    },
    peek(req) {
      const nowMs = req.nowMs ?? now()
      const ends = deps.quietEndsAt(req.chatId, nowMs)
      return decideSpeech(req.kind, {
        care: deps.care(req.chatId),
        quiet: ends === null ? null : { endsIso: new Date(ends).toISOString() },
        deliverable: deps.outbound.canDeliver(req.chatId),
        ...(req.perKind ? { perKind: req.perKind } : {}),
        ...(req.scheduled ? { scheduled: true } : {}),
      })
    },
    ask(req, o) {
      const { decision, base } = judge(req, o.deliverable)
      if (!('allow' in decision)) return decision
      write({ ...base, outcome: 'allowed', reason: null, channel: o.channel })
      return { allow: true, channel: o.channel }
    },
    async say(req, produce) {
      const { decision, base } = judge(req, deps.outbound.canDeliver(req.chatId))
      if (!('allow' in decision)) return decision
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
        try {
          // 自带的 send(比如 sendAssistantText)发不出去时回 false、不抛 ⇒ 那也算没说出去
          if (send) { sent = (await send(chatId, text)) !== false; return }
          sent = !(await turn.sendText(chatId, text)).error
        } catch (err) {
          deps.log('SPEECH', `${kind} chat=${chatId} send threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      // report / blocking 没说出去 —— 被推后,**或者放行了但发失败**(ilink 回 error / 网络抖)—— 都入队,之后补说(整合者评审 #531 ①)
      const notSaid = 'defer' in o || ('allow' in o && !sent)
      // 带会过期码的卡不排队(isExpiring):晚补出去只会给一个失效的码
      if (notSaid && originOf(kind) !== 'initiative' && !isExpiring(kind) && deps.pending) {
        deps.pending.add({ kind, chatId, text, at: new Date(now()).toISOString() })
        deps.log('SPEECH', `${kind} chat=${chatId} kept to say later (${'defer' in o ? o.reason : 'send failed'})`)
      }
      return sent
    },
    flushPending() {
      // 一次只跑一拍:上一拍还在发(线上那一层 1 秒 × 3 次就要 2 秒多)时再起一份,就是两份叠着撞同一条断了的线,
      // 退避也要等第一份失败了才记得上(S2a 沙盒抓到的:200ms 一拍、断线,3 秒里撞了 21 次)
      if (!flushing) {
        flushing = flushOnce().finally(() => {
          flushing = null
          for (const cb of flushHooks) {
            try { cb() } catch (err) { deps.log('SPEECH', `flush hook failed: ${err instanceof Error ? err.message : String(err)}`) }
          }
        })
      }
      return flushing
    },
  }
  let flushing: Promise<void> | null = null
  async function flushOnce(): Promise<void> {
    if (!deps.pending) return
    const t = now()
    // 过期的先收掉:记一行账「过期作废」,不再说(S2b:每一行有过期时间)
    for (const x of deps.pending.expire(t)) {
      policy.expired({ kind: x.kind, chatId: x.chatId, channel: null })
      deps.log('SPEECH', `${x.kind} chat=${x.chatId} pending notice expired — not said`)
    }
    // 还在退避的对话不在 groups 里(退避记在行上:共用 backoffMs,重启不归零;no-retry-storm)
    let tried = 0
    for (const g of deps.pending.groups(t)) {
      if (tried >= MAX_FLUSH_CHATS_PER_TICK) break   // 每一拍有上限:静音一结束不一口气冒出一串
      // 有等主人拍板的就按 blocking 问(免打扰不拦);否则按第一条 report 问
      const kind = g.items.find(i => originOf(i.kind) === 'blocking')?.kind ?? g.items[0]!.kind
      let sent = false
      const o = await policy.say({ kind, chatId: g.chatId }, async (turn) => {
        try { sent = !(await turn.sendText(g.chatId, mergePending(g.items, g.dropped))).error } catch { sent = false }
      })
      if (!('allow' in o)) continue
      tried++
      if (sent) {
        // 只删这次真说了的那几条(发送途中又进来的留着,下一拍说;整合者评审 #531 ②)
        deps.pending.remove(g.chatId, g.items.map(i => i.id), g.dropped)
        deps.log('SPEECH', `told ${g.items.length} pending notice(s) chat=${g.chatId}`)
      } else {
        const fails = deps.pending.failed(g.chatId, g.items.map(i => i.id), t)
        deps.log('SPEECH', `pending notices chat=${g.chatId} send failed (try ${fails}) — backing off`)
      }
    }
  }
  return policy
}

