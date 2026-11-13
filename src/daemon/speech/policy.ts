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
import { isRoutineSpeech } from '../../domain/topic-noise'
import { decideSpeech, type CareSetting, type SpeechDecision } from '../../domain/speech/decide'
import { keepForMs, originOf, type SpeechKind, type SpeechOrigin } from '../../domain/speech/kinds'
import type { ProactiveChannel, ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import type { SpeechSource } from './proposal'
import { MAX_FLUSH_CHATS_PER_TICK, mergePending, type PendingAttach, type PendingNotice } from './pending-notices'

export interface SpeechRequest {
  kind: SpeechKind
  chatId: string
  /** 这一种自己的频率 / 冷却(只对 initiative 生效)。 */
  perKind?: { ok: true } | { ok: false; reason: string }
  /** 定时触发的(早报、周报):赶上免打扰当天记 skipped:quiet。 */
  scheduled?: boolean
  /** 调用方这一拍的时刻(伙伴一拍有自己的 nowIso);缺省 = 时钟。免打扰按它判,账按它记。 */
  nowMs?: number
  /** 同一个事件的键(domain/speech/event-ref.ts;S3a):几条路问同一件事时带同一个,账上并成一行。 */
  ref?: string
}

/** 账上记的通道:proactive-channel 的两条之外,还有一件事的提议里的「桌面」那一级(S3b)。 */
export type SpeechChannel = ProactiveChannel | 'desktop'

export interface SpeechLedgerEntry {
  /** First successful delivery receipt; never inferred from allowed. */
  spokenAt?: number
  kind: SpeechKind
  origin: SpeechOrigin
  chatId: string
  outcome: 'allowed' | 'deferred' | 'dropped' | 'failed'
  reason: string | null
  channel: SpeechChannel | null
  ts: string
  /** 同一个事件的键(v103):带了的同一个只有一行(ledger-store.ts)。 */
  ref?: string
}

export type SpeechOutcome = ({ allow: true; channel: SpeechChannel | null }) | Exclude<SpeechDecision, { allow: true }>

export interface SpeechProposalRequest extends SpeechRequest {
  source: SpeechSource | 'requested'
  summary: string
  createdAt?: number
  expiresAt?: number
  payloadRef?: import('./proposal').SpeechProposal['payloadRef']
  getTargets?: () => readonly string[]
  context?: () => Promise<object>
  targets?: readonly string[]
  validate?: (nowMs: number) => boolean | Promise<boolean>
}

export interface SpeechPolicy {
  /** Submit an initiative; only the presence scheduler may authorize produce. */
  propose(req: SpeechProposalRequest, produce: (turn: ProactiveTurn, target?: string) => Promise<void | import('./proposal').ProductionResult>): Promise<SpeechOutcome>
  say(req: SpeechRequest, produce: (turn: ProactiveTurn) => Promise<void>): Promise<SpeechOutcome>
  /**
   * 一句话的主动开口(系统通知、社交通知 …):问门,放行就发。`send` 缺省 = 经 say 开的那一轮(微信能用走微信,
   * 降级落到 App);社交那几句要经 sendAssistantText 发 —— 它管 App 回话截获与旁听 —— 就把它传进来。
   * **report / blocking 被推后 ⇒ 进「待说」队列**(pending-notices.ts),flushPending 时补说 —— defer 不是不送。
   * initiative 里声明了留多久的(新贴纸 6 小时、见闻 24 小时;kinds.ts keepForMs)同样进队列(S2c)。
   * 发出去了 ⇒ true;被推后 / 被拒 / 发失败 ⇒ false(调用方可以照旧走自己的兜底,比如桌面通知)。
   */
  tell(kind: SpeechKind, chatId: string, text: string, send?: (chatId: string, text: string) => Promise<unknown>): Promise<boolean>
  /**
   * 自己经 say 开口、被推后了的(新贴纸那一句带图、明信片):交给「待说」队列,过了免打扰再说(S2c)。
   * 只收 keepForMs 不是 null 的种类;留多久按种类。收下了 ⇒ true。
   */
  keep(item: { kind: SpeechKind; chatId: string; text: string; attach?: PendingAttach }): boolean
  /**
   * 压着的几句再问一次门;放行 ⇒ 每条对话合成一句,经 say 开的那一轮发(降级时落到 App),说完清掉。
   * CC 自己的(新贴纸、见闻)不并进那一句:各按自己的种类问门、各自发(带图的先发图;图发不出去 ⇒ 这一样不说);
   * 见闻一次最多一条(最新的那条),更早的留在背包里、不补说。
   */
  flushPending(): Promise<void>
  /**
   * 只问门、不开一轮:给「自己就是通道」的发送口用 —— App 原生推送(speech/push-gate.ts)。判定、记账跟 say 一样;
   * 放行 ⇒ 账记 allowed、channel 记调用方给的那条,发送由调用方自己做。被推后 / 被拒 ⇒ 原样回,怎么补是调用方的事
   * (report / blocking 不能丢)。`deliverable` 由调用方给:推送送不送得到是推送自己的事,跟微信断没断无关。
   * 账上的 allowed 记的是**门的判定**,不是送达:放行以后推到 0 台(没配对 / 都离线)账上照样是 allowed,送达与否看推送自己的日志(#536 评审)。
   */
  ask(req: SpeechRequest, o: { channel: SpeechChannel; deliverable: boolean }): SpeechOutcome
  /**
   * 只判、不记账、不开一轮(S1):要先花钱(调便宜模型挑候选)的发起方用它在花钱之前问一声「这一拍门会不会放」——
   * 免打扰 / 关心档关着就别挑了。判法和 say 同一份(decideSpeech);真要说的时候照样走 say(那一次才记账)。
   */
  peek(req: SpeechRequest): SpeechDecision
  /**
   * 压着的一样过期了、不再说(S2b):记一行账 outcome=dropped、reason=expired。待说队列自己在 flushPending 里记;
   * 自己就是通道的(App 推送,push-gate)放压着的那几条时调它。
   */
  expired(e: { kind: SpeechKind; chatId: string; channel: ProactiveChannel | null; ref?: string }): void
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
  /** 补说明信片那一类带文件的(S2c):走微信发文件;没接 / 发失败 ⇒ 那一样不补说(背包里照样有)。 */
  sendFile?: (chatId: string, path: string) => Promise<boolean>
  /** 「待说」队列(没接 ⇒ 推后的 report 就是这一句不说,只用于测试 / 最小嵌入)。 */
  /** Production wiring installs the single presence scheduler. */
  proposals?: (execute: SpeechPolicy['say'], peek: SpeechPolicy['peek']) => SpeechPolicy['propose']
  pending?: import('./pending-notices').PendingNotices
}): SpeechPolicy {
  const now = deps.now ?? Date.now
  /** (kind, chatId) → 上一次记下的那次推后(理由 + 时刻)。只在内存里:重启后多记一行无妨。 */
  const lastDefer = new Map<string, { reason: string; at: number }>()
  const DEFER_LOG_EVERY_MS = 60 * 60_000
  const MAX_DEFER_KEYS = 256
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
    const base = { kind: req.kind, origin: originOf(req.kind), chatId: req.chatId, ts, ...(req.ref ? { ref: req.ref } : {}) }
    // 带事件键的按事件分开(S3a):两件不同的事同一小时里被推后,各记各的那一行;同一件事连着推后照旧一小时只记一次
    const key = `${req.kind}\u0000${req.chatId}${req.ref ? `\u0000${req.ref}` : ''}`
    if ('defer' in decision) {
      const prev = lastDefer.get(key)
      if (prev && prev.reason === decision.reason && nowMs - prev.at < DEFER_LOG_EVERY_MS) return { decision, base }
      lastDefer.set(key, { reason: decision.reason, at: nowMs })
      // 带事件键的每件事一项(S3a):过了一小时的窗口就没用了,攒多了顺手清掉,长跑的 daemon 不会越攒越多
      if (lastDefer.size > MAX_DEFER_KEYS) for (const [k, v] of lastDefer) if (nowMs - v.at >= DEFER_LOG_EVERY_MS) lastDefer.delete(k)
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
  let submit: SpeechPolicy['propose'] | undefined
  const policy: SpeechPolicy = {
    propose(req, produce) {
      if (originOf(req.kind) !== 'initiative') return policy.say(req, async turn => { await produce(turn) })
      if (submit && req.perKind && !req.perKind.ok) return execute(req, async turn => { await produce(turn) })
      if (submit) return submit(req, produce)
      // Minimal policy embeddings have no daemon scheduler. Production wiring always installs it.
      return policy.say(req, async turn => { await produce(turn) })
    },
    onFlush(cb) { flushHooks.push(cb) },
    expired(e) {
      if (e.ref) lastDefer.delete(`${e.kind}\u0000${e.chatId}\u0000${e.ref}`)
      write({ kind: e.kind, origin: originOf(e.kind), chatId: e.chatId, outcome: 'dropped', reason: 'expired', channel: e.channel, ts: new Date(now()).toISOString(), ...(e.ref ? { ref: e.ref } : {}) })
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
      const rawTurn = (isRoutineSpeech(req.kind) || req.kind === 'companion' ? deps.outbound.open(req.chatId, { source: `speech:${req.kind}` }) : deps.outbound.open(req.chatId))
      let spokenAt: number | undefined
      let receiptChannel: ProactiveChannel | null = null
      const confirmed = () => { spokenAt ??= now() }
      const turn: ProactiveTurn = {
        ...rawTurn,
        confirmDelivery(channel) { receiptChannel = channel; confirmed() },
        async sendText(c, text) { const r = await rawTurn.sendText(c, text); if (!r.error) confirmed(); return r },
        async sendAttachment(c, a) { const ok = await rawTurn.sendAttachment(c, a); if (ok) confirmed(); return ok },
        async sendSticker(c, tag, path) { const ok = await rawTurn.sendSticker(c, tag, path); if (ok) confirmed(); return ok },
        ...(rawTurn.sendTextWith ? { sendTextWith: async (...args: Parameters<NonNullable<ProactiveTurn['sendTextWith']>>) => { const r = await rawTurn.sendTextWith!(...args); if (r.ok) confirmed(); return r } } : {}),
      }
      try {
        await produce(turn)
      } catch (err) {
        write({ ...base, outcome: 'failed', reason: err instanceof Error ? err.message : String(err), channel: receiptChannel ?? turn.channel(), ...(spokenAt !== undefined ? { spokenAt } : {}) })
        throw err
      } finally {
        turn.finish()
      }
      write({ ...base, outcome: 'allowed', reason: null, channel: receiptChannel ?? turn.channel(), ...(spokenAt !== undefined ? { spokenAt } : {}) })
      return { allow: true, channel: turn.channel() }
    },
    async tell(kind, chatId, text, send) {
      let sent = false
      const sendTurn = originOf(kind) === 'initiative'
        ? (produce: (turn: ProactiveTurn) => Promise<void>) => policy.propose({ source: 'social', summary: text.slice(0, 1000), kind, chatId }, produce)
        : (produce: (turn: ProactiveTurn) => Promise<void>) => policy.say({ kind, chatId }, produce)
      const o = await sendTurn(async (turn) => {
        try {
          // 自带的 send(比如 sendAssistantText)发不出去时回 false、不抛 ⇒ 那也算没说出去
          if (send) { sent = (await send(chatId, text)) !== false; if (sent) turn.confirmDelivery?.('wechat'); return }
          sent = !(await turn.sendText(chatId, text)).error
        } catch (err) {
          deps.log('SPEECH', `${kind} chat=${chatId} send threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      // report / blocking 没说出去 —— 被推后,**或者放行了但发失败**(ilink 回 error / 网络抖)—— 都入队,之后补说(整合者评审 #531 ①)
      const notSaid = 'defer' in o || ('allow' in o && !sent)
      // 带会过期码的卡不排队(keepForMs = null):晚补出去只会给一个失效的码;initiative 只有声明了 keepMs 的才排(S2c)
      if (notSaid && !('defer' in o && o.reason === 'delivery_unknown') && policy.keep({ kind, chatId, text })) {
        deps.log('SPEECH', `${kind} chat=${chatId} kept to say later (${'defer' in o ? o.reason : 'send failed'})`)
      }
      return sent
    },
    keep(item) {
      const keepMs = keepForMs(item.kind)
      if (keepMs === null || !deps.pending) return false
      const t = now()
      deps.pending.add({ kind: item.kind, chatId: item.chatId, text: item.text, at: new Date(t).toISOString(), expiresAt: t + keepMs, ...(item.attach ? { attach: item.attach } : {}) })
      return true
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
    // Routine receipts must never share a persisted message with owner project reports.
    const groups = deps.pending.groups(t).flatMap(g => {
      const regular = g.items.filter(i => !isRoutineSpeech(i.kind))
      const routine = new Map<SpeechKind, PendingNotice[]>()
      for (const i of g.items.filter(i => isRoutineSpeech(i.kind))) routine.set(i.kind, [...(routine.get(i.kind) ?? []), i])
      return [regular, ...routine.values()].filter(items => items.length > 0).map((items, index) => ({ ...g, items, dropped: index === 0 ? g.dropped : 0 }))
    })
    for (const g of groups) {
      if (tried >= MAX_FLUSH_CHATS_PER_TICK) break   // 每一拍有上限:静音一结束不一口气冒出一串
      const told = g.items.filter(i => originOf(i.kind) !== 'initiative')
      // 只剩 CC 自己的那几样(被挤掉的计数也许不是 0)⇒ 不单独说一句「还有 N 件更早的」:那一句跟着下一次回报说;
      // 单说那一句发失败了也没有行可记退避(Codex 评审 S2c P2)
      if (told.length > 0) {
        // 有等主人拍板的就按 blocking 问(免打扰不拦);否则按第一条 report 问
        const kind = told.find(i => originOf(i.kind) === 'blocking')?.kind ?? told[0]!.kind
        let sent = false
        const o = await policy.say({ kind, chatId: g.chatId }, async (turn) => {
          try { sent = !(await turn.sendText(g.chatId, mergePending(told, g.dropped))).error } catch { sent = false }
        })
        if ('allow' in o) {
          tried++
          if (sent) {
            // 只删这次真说了的那几条(发送途中又进来的留着,下一拍说;整合者评审 #531 ②)
            deps.pending.remove(g.chatId, told.map(i => i.id), g.dropped)
            deps.log('SPEECH', `told ${told.length} pending notice(s) chat=${g.chatId}`)
          } else {
            const fails = deps.pending.failed(g.chatId, told.map(i => i.id), t)
            deps.log('SPEECH', `pending notices chat=${g.chatId} send failed (try ${fails}) — backing off`)
            continue   // 这条对话的线断了:CC 自己的那几样也别撞
          }
        }
      }
      tried += await flushOwn(g.chatId, g.items.filter(i => originOf(i.kind) === 'initiative'), t, MAX_FLUSH_CHATS_PER_TICK - tried)
    }
  }
  /** CC 自己的那几样(新贴纸、见闻;S2c):各按自己的种类问门、各自发。回这一拍真开口试过几次。 */
  async function flushOwn(chatId: string, own: PendingNotice[], t: number, budget: number): Promise<number> {
    // 见闻一次最多一条:留最新的那条,更早的留在背包 / 觅食台里,不补说(主人 11-04)
    const stories = own.filter(i => i.kind === 'social_story')
    for (const s of stories.slice(0, -1)) {
      deps.pending!.remove(chatId, [s.id], 0)
      write({ kind: s.kind, origin: originOf(s.kind), chatId, outcome: 'dropped', reason: 'story_limit', channel: null, ts: new Date(t).toISOString() })
      deps.log('SPEECH', `social_story chat=${chatId} older pending story left in the bag (one story per flush)`)
    }
    let stopped = false
    const tasks = own.filter(i => i.kind !== 'social_story' || i === stories.at(-1)).slice(0, budget).map(item => async () => {
      if (stopped) return 0
      let sent = false, undeliverable = false
      const o = await policy.propose({ source: item.kind === 'sticker' ? 'sticker' : 'social', summary: item.text.slice(0, 1000), ref: `pending:${item.id}`, createdAt: Date.parse(item.at), expiresAt: item.expiresAt ?? Date.parse(item.at) + (keepForMs(item.kind) ?? 0), payloadRef: { pending: item.id }, kind: item.kind, chatId }, async (turn) => {
        try {
          // 带图的先发图;图发不出去 ⇒ 这一样什么都不说,**不退成一句光秃秃的文字**(新贴纸那一句的老规矩)
          const a = item.attach
          if (a && 'sticker' in a && !(await turn.sendSticker(chatId, a.sticker.mood, a.sticker.path))) { undeliverable = true; return }
          if (a && 'file' in a) {
            if (!(deps.sendFile && await deps.sendFile(chatId, a.file))) { undeliverable = true; return }
            turn.confirmDelivery?.('wechat')
          }
          sent = item.text ? !(await turn.sendText(chatId, item.text)).error : true
        } catch { sent = false }
      })
      if ('defer' in o) return 0
      if ('drop' in o) { deps.pending!.remove(chatId, [item.id], 0); return 0 }   // 别烦我 / 频率:账上已经记了 dropped
      if (sent || undeliverable) {
        deps.pending!.remove(chatId, [item.id], 0)
        deps.log('SPEECH', `${item.kind} chat=${chatId} pending ${undeliverable ? 'item not deliverable (image) — dropped, it stays in the library / bag' : 'item said'}`)
      } else {
        stopped = true
        const fails = deps.pending!.failed(chatId, [item.id], t)
        deps.log('SPEECH', `${item.kind} chat=${chatId} pending send failed (try ${fails}) — backing off`)
      }
      return 1
    })
    const attempts: number[] = []
    if (submit) attempts.push(...await Promise.all(tasks.map(run => run())))
    else for (const run of tasks) attempts.push(await run())
    return attempts.reduce((sum: number, n) => sum + n, 0)
  }
  const execute = policy.say.bind(policy)
  submit = deps.proposals?.(execute, policy.peek.bind(policy))
  if (submit) policy.say = (req, produce) => originOf(req.kind) === 'initiative'
    ? Promise.resolve({ drop: true, reason: 'proposal_required' })
    : execute(req, produce)
  return policy
}

