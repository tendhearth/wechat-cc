/**
 * reply-delivery — daemon 负责送达(回复交付 spec docs/superpowers/specs/2026-10-03-reply-delivery-design.md §4.3)。
 *
 * 执行者一轮结束时最后写下的那段话就是回复(core/turn-reply.ts 取出来);这里管剩下的全部:
 *   1. 静默(NO_REPLY,场合允许才算数;私聊里同样不显示,但记 REPLY_SILENT_IN_DM)
 *   2. app 接收器:桌面 / 手机这一轮 ⇒ 整个 TurnReply(文字 + 附件 + 旁白)交给接收器,不进微信
 *   3. 旁听(打猎记账):原文、分条之前
 *   4. 前缀:/chat、/both 的 `[名字]`,每一条都加
 *   5. 分条:reply-bubbles 的规则(空行分段、最多 4 条、代码整块……)
 *   6. 节奏:条与条之间 paceMs
 *   7. 传输层 4000 字切块(ilink sendReply 自己做;超长代码块已在第 5 步按行切开补围栏)
 *   8. 附件:文字之后、按调用顺序;只有语音(或文字与语音一样)⇒ 只发语音;语音失败 ⇒ 改发文字
 *   9. 记账:DeliveryReport 写进 TurnRecord
 *
 * 失败处理不改现有规矩:每条只依赖 ilink 自带的重试;第一条失败就停、剩下的不发;**绝不因为送达失败
 * 再调一次模型**(断线时停掉外发与 LLM 轮次)。
 *
 * 迁移期还有一个 shadow 模式:legacy 照旧走 reply 工具,这里只把「如果按新路会发什么」与 legacy 实际
 * 发出去的比一比,记 [REPLY_SHADOW](§5.1 第 3 项)。
 */
import { splitBubbles } from './reply-bubbles'
import { paceMs } from './reply-split'
import {
  buildTurnReply,
  type DeliveryKind, type DeliveryReport, type ReplyContext, type ReplyDeliveryPort,
  type TurnAttachment, type TurnDeliveryHandle, type TurnReply, type TurnTextParts,
} from '../core/turn-reply'

/** 登记在这一轮上的附件:描述 + 真正发出去的动作(由 attach 路由在登记时绑好)。 */
export interface PendingAttachment {
  attachment: TurnAttachment
  send(): Promise<{ ok: boolean; error?: string }>
}

export interface DeliverDeps {
  /** 一条文字(ilink sendReply:带重试、带 4000 字切块、记外发健康)。 */
  sendText(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  sleep?(ms: number): Promise<void>
  /** app 接收器:开着 ⇒ 收下整个 TurnReply 并返回 true(调用方不发微信)。 */
  sink?: { captureReply(chatId: string, reply: TurnReply): boolean }
  /** 旁听(打猎记账)。 */
  observe?(chatId: string, text: string): void
  chatPrefs?(chatId: string): { split?: boolean } | undefined
  log(tag: string, line: string, fields?: Record<string, unknown>): void
}

export interface DeliverInput {
  chatId: string
  reply: TurnReply
  attachments: readonly PendingAttachment[]
  context: ReplyContext
  participantLabel?: string
  /** 本轮 `message` 工具发给主人聊天的文字(§4.6 去重)。 */
  messagedOwner?: readonly string[]
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '')

function sameOrContains(a: string, b: string): boolean {
  const x = norm(a), y = norm(b)
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x))
}

function classify(text: { bubbles: number }, attachmentsSent: number, silent: boolean): DeliveryKind {
  if (text.bubbles > 0) return 'text'
  if (attachmentsSent > 0) return 'attachments_only'
  return silent ? 'silent' : 'empty'
}

export async function deliverTurnReply(input: DeliverInput, deps: DeliverDeps): Promise<DeliveryReport> {
  const { chatId, reply, attachments, context } = input
  const sleep = deps.sleep ?? defaultSleep

  // 2. app 接收器:整个对象交过去,一个字都不进微信(包括语音 / 表情 —— 修 §1.2 ④)。
  if (deps.sink?.captureReply(chatId, reply)) {
    const hasText = reply.text.trim() !== ''
    return {
      delivery: hasText ? 'text' : reply.attachments.length > 0 ? 'attachments_only' : reply.silent ? 'silent' : 'empty',
      target: 'sink', bubbles: hasText ? 1 : 0, attachmentsSent: 0, failures: [], msgIds: [],
    }
  }

  const failures: string[] = []
  const msgIds: string[] = []
  let bubbles = 0
  let attachmentsSent = 0
  let deduped = false

  // 文字要不要发:静默 ⇒ 不发;只有语音 / 文字与语音一样 ⇒ 不发(已定 ⑤);message 已经说过 ⇒ 不发(§4.6)。
  let text = reply.silent ? '' : reply.text.trim()
  const voices = attachments.filter(a => a.attachment.kind === 'voice')
  if (text !== '' && voices.some(v => v.attachment.kind === 'voice' && norm(v.attachment.text) === norm(text))) text = ''
  if (text !== '' && (input.messagedOwner ?? []).some(m => sameOrContains(m, text))) {
    deduped = true
    text = ''
    deps.log('REPLY_DEDUPED', `chat=${chatId} message 工具已把同样的话发给主人,最后的话不再重复交付`)
  }

  const sendOne = async (t: string): Promise<boolean> => {
    try {
      const r = await deps.sendText(chatId, t)
      if (r.error) { failures.push(r.error); return false }
      msgIds.push(r.msgId)
      return true
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  if (text !== '') {
    // 3. 旁听:原文、分条之前、只在真的进微信时。
    deps.observe?.(chatId, text)
    // 5. 分条 + 4. 前缀(每条都加,第 2 条起不会丢掉署名)
    const prefix = input.participantLabel ? `[${input.participantLabel}] ` : ''
    // 聊天型模型的多段:每段按 ④ 各自分条,依次发(spec 修订 2026-10-03);否则整段分条。
    const split = deps.chatPrefs?.(chatId)?.split !== false
    const sources = reply.segments && reply.segments.length > 0 && !reply.silent ? reply.segments : [text]
    const parts = sources.flatMap(seg => splitBubbles(seg, { split })).map(p => `${prefix}${p}`)
    for (let i = 0; i < parts.length; i++) {
      if (!(await sendOne(parts[i]!))) {
        deps.log('REPLY_DELIVERY_FAIL', `chat=${chatId} sent=${bubbles}/${parts.length} err=${failures[failures.length - 1]}`)
        // 第一条失败就停:剩下的文字和附件都不发。
        return { delivery: classify({ bubbles }, 0, reply.silent), target: 'wechat', bubbles, attachmentsSent: 0, failures, msgIds, ...(deduped ? { deduped } : {}) }
      }
      bubbles++
      // 6. 节奏:条与条之间(最后一条之后若还有附件,也停一下)
      if (i < parts.length - 1 || attachments.length > 0) await sleep(paceMs(parts[i]!))
    }
  }

  // 8. 附件:按调用顺序;语音失败 ⇒ daemon 自己改发文字。
  for (const a of attachments) {
    let r: { ok: boolean; error?: string }
    try { r = await a.send() } catch (err) { r = { ok: false, error: err instanceof Error ? err.message : String(err) } }
    if (r.ok) { attachmentsSent++; continue }
    if (a.attachment.kind === 'voice') {
      deps.log('REPLY_VOICE_FALLBACK', `chat=${chatId} voice failed (${r.error ?? 'unknown'}) — sending the same words as text`)
      if (await sendOne(a.attachment.text)) bubbles++
      else deps.log('REPLY_DELIVERY_FAIL', `chat=${chatId} voice→text fallback failed err=${failures[failures.length - 1]}`)
      continue
    }
    failures.push(r.error ?? `${a.attachment.kind}_failed`)
    deps.log('REPLY_ATTACHMENT_FAIL', `chat=${chatId} kind=${a.attachment.kind} err=${r.error ?? 'unknown'}`)
  }

  return {
    delivery: classify({ bubbles }, attachmentsSent, reply.silent),
    target: 'wechat', bubbles, attachmentsSent, failures, msgIds,
    ...(deduped ? { deduped } : {}),
  }
}

// ─── 一轮的句柄 ───────────────────────────────────────────────────────────

export interface ReplyDeliveryRuntimeDeps extends DeliverDeps {
  /** 这个 chat 此刻有没有开着的 app 接收器 —— 有 ⇒ 长任务进度不进微信。 */
  isSinkOpen?(chatId: string): boolean
}

export interface ReplyDeliveryRuntime extends ReplyDeliveryPort {
  /** attach 路由:登记到这个 chat 正在进行的那一轮。没有开着的轮 ⇒ false(工具回执报错)。 */
  attach(chatId: string, pending: PendingAttachment): boolean
  /** 这个 chat 此刻有没有一轮在收附件。 */
  hasOpenTurn(chatId: string): boolean
  /** message 路由:记一笔,交付时去重(只认发给主人聊天的)。 */
  noteMessage(chatId: string, m: { toOwner: boolean; text: string }): void
  /** legacy 出口旁听(reply 路由 / fallback):shadow 轮开着才记。 */
  observeLegacy(chatId: string, text: string): void
  /**
   * 这家 provider 此刻正在 daemon 模式下跑的那一轮是哪个聊天。给**没有自己的 chat 的共享令牌**用
   * (agy 的 `agy-static`:一份全局 MCP 配置,所有 agy 对话共用一枚 trusted 令牌 —— 令牌里读不出 chat)。
   * 恰好一个聊天有这家的 daemon 轮开着 ⇒ 就是它;没有 ⇒ none;不止一个 ⇒ ambiguous(说不清是哪一轮,
   * 调用方必须拒绝,绝不猜)。
   */
  turnChatFor(providerId: string): TurnChatBinding
}

export type TurnChatBinding =
  | { kind: 'bound'; chatId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

interface OpenTurn { attachments: PendingAttachment[]; messagedOwner: string[]; legacy: string[]; refs: number }

export function makeReplyDeliveryRuntime(deps: ReplyDeliveryRuntimeDeps): ReplyDeliveryRuntime {
  const open = new Map<string, OpenTurn>()
  // providerId → (chatId → 开着的 daemon 轮数)。只记 daemon 模式:附件工具只在 daemon 模式下注册。
  const daemonTurns = new Map<string, Map<string, number>>()
  const trackDaemon = (providerId: string, chatId: string, delta: 1 | -1): void => {
    const byChat = daemonTurns.get(providerId) ?? new Map<string, number>()
    const n = (byChat.get(chatId) ?? 0) + delta
    if (n > 0) byChat.set(chatId, n); else byChat.delete(chatId)
    if (byChat.size > 0) daemonTurns.set(providerId, byChat); else daemonTurns.delete(providerId)
  }

  const acquire = (chatId: string): OpenTurn => {
    let t = open.get(chatId)
    if (!t) { t = { attachments: [], messagedOwner: [], legacy: [], refs: 0 }; open.set(chatId, t) }
    t.refs++
    return t
  }
  const release = (chatId: string, t: OpenTurn): void => {
    t.refs--
    if (t.refs <= 0 && open.get(chatId) === t) open.delete(chatId)
  }

  function begin(chatId: string, opts: Parameters<ReplyDeliveryPort['begin']>[1]): TurnDeliveryHandle {
    const turn = acquire(chatId)
    let done = false
    const finish = () => { if (!done) { done = true; release(chatId, turn) } }

    if (opts.mode === 'shadow') {
      return {
        mode: 'shadow',
        async progress() { /* shadow 不发任何东西 */ },
        async deliver(parts: TurnTextParts): Promise<DeliveryReport> {
          const legacy = [...turn.legacy]
          finish()
          const { reply } = buildTurnReply(parts, [], opts.context, opts.textStrategy)
          const split = deps.chatPrefs?.(chatId)?.split !== false
          const wouldSend = reply.silent ? [] : (reply.segments ?? [reply.text]).flatMap(seg => splitBubbles(seg, { split }))
          const legacyJoined = legacy.join('\n')
          const match = legacy.length === 0 && wouldSend.length === 0 ? 'both_empty'
            : legacy.length === 0 ? 'legacy_empty'
            : wouldSend.length === 0 ? 'shadow_empty'
            : norm(legacyJoined) === norm(reply.text) ? 'same'
            : sameOrContains(legacyJoined, reply.text) ? 'contains'
            : 'differs'
          deps.log('REPLY_SHADOW', `chat=${chatId} provider=${opts.providerId} context=${opts.context} legacy_n=${legacy.length} legacy_len=${legacyJoined.length} shadow_bubbles=${wouldSend.length} shadow_len=${reply.text.length} narration=${reply.narration.length} silent=${reply.silent} match=${match}`, {
            event: 'reply_shadow', chat_id: chatId, provider: opts.providerId, context: opts.context,
            legacy_n: legacy.length, shadow_bubbles: wouldSend.length, narration: reply.narration.length, silent: reply.silent, match,
          })
          return { delivery: classify({ bubbles: wouldSend.length }, 0, reply.silent), target: 'wechat', bubbles: wouldSend.length, attachmentsSent: 0, failures: [], msgIds: [], shadow: true }
        },
        abandon() { finish() },
      }
    }

    trackDaemon(opts.providerId, chatId, 1)
    const finishDaemon = () => { if (!done) trackDaemon(opts.providerId, chatId, -1); finish() }
    return {
      mode: 'daemon',
      async progress(text: string) {
        if (done || text.trim() === '') return
        if (deps.isSinkOpen?.(chatId)) return // app 这一轮:旁白在 app 里本来就看得见,不进微信
        try {
          const r = await deps.sendText(chatId, text)
          deps.log('REPLY_PROGRESS', `chat=${chatId} provider=${opts.providerId}${r.error ? ` err=${r.error}` : ''}`)
        } catch (err) {
          deps.log('REPLY_PROGRESS', `chat=${chatId} provider=${opts.providerId} threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
      async deliver(parts: TurnTextParts): Promise<DeliveryReport> {
        const pending = [...turn.attachments]
        const messagedOwner = [...turn.messagedOwner]
        finishDaemon()
        const built = buildTurnReply(parts, pending.map(p => p.attachment), opts.context, opts.textStrategy)
        if (built.mixed) deps.log('NO_REPLY_MIXED', `chat=${chatId} provider=${opts.providerId} 令牌行已剥掉,其余照发`)
        if (built.silentInDm) {
          deps.log('REPLY_SILENT_IN_DM', `chat=${chatId} provider=${opts.providerId} 私聊里写了 NO_REPLY —— 不显示、不替模型补话,记一次应答轮交付为空`, { event: 'reply_silent_in_dm', chat_id: chatId, provider: opts.providerId })
        } else if (built.reply.silent) {
          deps.log('REPLY_SILENT', `chat=${chatId} provider=${opts.providerId} kind=${opts.context}`, { event: 'reply_silent', chat_id: chatId, provider: opts.providerId, kind: opts.context })
        }
        const report = await deliverTurnReply({
          chatId, reply: built.reply, attachments: pending, context: opts.context,
          ...(opts.participantLabel ? { participantLabel: opts.participantLabel } : {}),
          messagedOwner,
        }, deps)
        deps.log('REPLY', `chat=${chatId} provider=${opts.providerId} context=${opts.context} target=${report.target} delivery=${report.delivery} bubbles=${report.bubbles} attachments=${report.attachmentsSent}/${pending.length} narration=${built.reply.narration.length}${report.failures.length ? ` failures=${report.failures.length}` : ''}`)
        return report
      },
      abandon(reason: string) {
        if (done) return
        if (turn.attachments.length > 0) deps.log('REPLY_ABANDONED', `chat=${chatId} provider=${opts.providerId} reason=${reason} dropped_attachments=${turn.attachments.length}`)
        finishDaemon()
      },
    }
  }

  return {
    begin,
    attach(chatId, pending) {
      const t = open.get(chatId)
      if (!t) return false
      t.attachments.push(pending)
      return true
    },
    hasOpenTurn: (chatId) => open.has(chatId),
    noteMessage(chatId, m) {
      if (m.toOwner) open.get(chatId)?.messagedOwner.push(m.text)
    },
    observeLegacy(chatId, text) {
      open.get(chatId)?.legacy.push(text)
    },
    turnChatFor(providerId) {
      const byChat = daemonTurns.get(providerId)
      if (!byChat || byChat.size === 0) return { kind: 'none' }
      if (byChat.size > 1) return { kind: 'ambiguous', count: byChat.size }
      return { kind: 'bound', chatId: [...byChat.keys()][0]! }
    },
  }
}
