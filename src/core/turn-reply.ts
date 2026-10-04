/**
 * turn-reply — 一轮的回复对象(回复交付设计 docs/superpowers/specs/2026-10-03-reply-delivery-design.md §4.1)。
 *
 * 执行者不再「调工具说话」:一轮结束时它最后写下的那段话就是回复。这里是**纯**的那一半 ——
 * 从事件流里取出「最后的话」与旁白、处理 NO_REPLY 令牌、按场合判定静默算不算数;怎么分条、
 * 什么节奏、送到哪里由 daemon 的 reply-delivery.ts 管(core 不依赖 daemon,只声明端口)。
 *
 * 迁移期一家一家来(§5):每家 provider 的 `ProviderCapabilities.replyDelivery` 决定它走哪条路 ——
 *   legacy  今天的样子:reply 工具说话,FALLBACK_REPLY 兜底;
 *   shadow  照旧走 legacy,但每轮额外算一次「如果按新路会发什么」,只记 [REPLY_SHADOW] 日志,不发;
 *   daemon  新路:最后的话 → deliverTurnReply。
 */

export type ReplyDeliveryMode = 'legacy' | 'shadow' | 'daemon'

/**
 * 一轮的哪些文字算回复(2026-10-03 修订,见 spec 修订记录):
 *   last_segment  编码型执行者(Claude Code / Codex / Cursor):最后一段非空文字是回复,之前是长任务旁白
 *                 (不进微信,长任务 120 秒发一句进度)。spec 的原规则就是为它们设计的。
 *   all_segments  聊天型模型(openai 兼容,以后也包括 agy 这类):本轮所有文字段按顺序都交付,每段按 ④ 分条。
 *                 工具调用前说的「我查一下」也是正常的聊天内容 —— 用「最后一段」会把内容吞掉(场景 c 的第一项)。
 * 这是按执行者类型的结构性区分,不按内容猜。
 */
export type ReplyTextStrategy = 'last_segment' | 'all_segments'

/** 这一轮属于哪种场合 —— 决定 NO_REPLY 是不是一个被认可的决定(已定 ②)。 */
export type ReplyContext = 'dm' | 'tick' | 'chatroom' | 'parallel'

export const NO_REPLY_TOKEN = 'NO_REPLY'

/** 表情附件:本地 tag;或联网候选(先 search_online_sticker_candidates 看图再选);或按情绪联网搜一张。 */
export type StickerRef =
  | { tag: string }
  | { mood: string; id?: string; url: string }
  | { mood: string; query: string }

export type TurnAttachment =
  | { kind: 'voice'; text: string }
  | { kind: 'sticker'; ref: StickerRef }
  | { kind: 'file'; path: string }

export interface TurnReply {
  /** 最后的话(已去掉 NO_REPLY);可以为空。 */
  text: string
  /** 模型写了 NO_REPLY。私聊里同样不显示,但调用方要记异常(见 buildTurnReply)。 */
  silent: boolean
  /** 按模型调用顺序。 */
  attachments: TurnAttachment[]
  /** 最后的话之前的各段文字 —— 不发微信(已定 ①),桌面 / 手机显示成过程行。all_segments 时为空。 */
  narration: string[]
  /** all_segments:要按顺序交付的各段(每段各自分条);`text` 是它们用空行拼起来。last_segment 时不设。 */
  segments?: string[]
}

export interface TurnTextParts {
  finalText: string
  narration: string[]
}

/**
 * 交付报告(§4.3 第 9 步)—— 写进 TurnRecord。
 *  - text:发出了至少一条文字气泡(或交给了 app 接收器的非空文字)
 *  - silent:NO_REPLY,且没有附件发出
 *  - attachments_only:没有文字,只有附件
 *  - empty:完成了但什么都没有(空文字、没附件、不是 NO_REPLY)
 */
export type DeliveryKind = 'text' | 'silent' | 'empty' | 'attachments_only'

export interface DeliveryReport {
  delivery: DeliveryKind
  target: 'wechat' | 'sink'
  bubbles: number
  attachmentsSent: number
  failures: string[]
  msgIds: string[]
  /** 本轮 `message` 工具已经把同样的话发给主人了,最后的话不再重复交付(§4.6)。 */
  deduped?: boolean
  /** shadow 模式:只是算出来的,什么都没发。 */
  shadow?: boolean
}

/** 一轮的交付句柄:daemon 实现(reply-delivery.ts),coordinator / 伙伴推送使用。 */
export interface TurnDeliveryHandle {
  readonly mode: 'daemon' | 'shadow'
  /** 长任务进度(已定 ①,一轮最多一次,由调用方保证)。app 这一轮 ⇒ 不进微信。 */
  progress(text: string): Promise<void>
  /** 只有 outcome === 'completed' 的轮才调这个(§4.2 末段)。 */
  deliver(parts: TurnTextParts): Promise<DeliveryReport>
  /** 超时 / 出错 / 认证失败:不交付文字,登记的附件丢弃(会记日志)。 */
  abandon(reason: string): void
}

export interface ReplyDeliveryPort {
  begin(chatId: string, opts: {
    mode: 'daemon' | 'shadow'
    context: ReplyContext
    providerId: string
    /** /chat、/both 的发言人显示名 —— 前缀 `[名字]` 由 daemon 加(§4.3 第 4 步)。 */
    participantLabel?: string
    /** 哪些文字算回复;缺省 last_segment。 */
    textStrategy?: ReplyTextStrategy
  }): TurnDeliveryHandle
}

// ─── 「最后的话」 ─────────────────────────────────────────────────────────

/** AgentEvent 的结构子集 —— 只看 text / tool_call 两种(不 import agent-provider,免得两个模块互相引用)。 */
export interface SegmentEvent { kind: string; text?: string; itemId?: string; textMode?: 'append' | 'replace'; ownSegment?: boolean }

/**
 * 增量版:按事件顺序喂进来,`tool_call` 是段与段的边界。同一段里的多条 text 事件用空行拼 ——
 * 每条 text 事件按 AgentEvent 的契约是「一条完整的助理消息」,空行正好是 daemon 分条的边界。
 * 带 `ownSegment` 的 text(Codex 的 agent_message)自成一段:最后的话 = 最后一条非空的那条消息。
 * `error` 事件**从不**进任何一段(#190:错误不许当回复发)。
 */
export function makeTurnTextCollector(): {
  push(ev: SegmentEvent): void
  parts(): TurnTextParts
  /** 目前为止最近一段非空文字(长任务进度用)。 */
  latestSegment(): string | undefined
} {
  const segments: string[][] = [[]]
  const itemIndex = new Map<string, number>() // itemId → 当前段里的下标
  const cur = () => segments[segments.length - 1]!
  const nonEmpty = (): string[] => segments.map(s => s.join('\n\n')).filter(s => s.trim() !== '')
  return {
    push(ev) {
      if (ev.kind === 'tool_call') {
        if (cur().length > 0) segments.push([])
        itemIndex.clear()
        return
      }
      if (ev.kind !== 'text' || typeof ev.text !== 'string') return
      const seg = cur()
      if (ev.itemId !== undefined && ev.textMode === 'replace' && itemIndex.has(ev.itemId)) {
        seg[itemIndex.get(ev.itemId)!] = ev.text
        return
      }
      if (ev.text.trim() === '') return
      if (ev.ownSegment && seg.length > 0) { segments.push([ev.text]); itemIndex.clear(); if (ev.itemId !== undefined) itemIndex.set(ev.itemId, 0); return }
      if (ev.itemId !== undefined) itemIndex.set(ev.itemId, seg.length)
      seg.push(ev.text)
    },
    parts() {
      const all = nonEmpty()
      if (all.length === 0) return { finalText: '', narration: [] }
      return { finalText: all[all.length - 1]!, narration: all.slice(0, -1) }
    },
    latestSegment() {
      const all = nonEmpty()
      return all[all.length - 1]
    },
  }
}

export function extractTurnReply(events: Iterable<SegmentEvent>): TurnTextParts {
  const c = makeTurnTextCollector()
  for (const ev of events) c.push(ev)
  return c.parts()
}

// ─── NO_REPLY ─────────────────────────────────────────────────────────────

const TOKEN_LINE = /^\s*NO_REPLY\s*$/i
const TOKEN_EDGE_START = /^\s*NO_REPLY(?=[\s,，。.!！?？:：]|$)[\s,，。.!！?？:：]*/
const TOKEN_EDGE_END = /\s*(?<![A-Za-z0-9_`])NO_REPLY\s*$/

/**
 * 整段等于令牌(不分大小写)⇒ silent。令牌单独成行 / 贴在开头或结尾 ⇒ 剥掉、其余照发(mixed)。
 * 行内夹在句子中间的(比如在代码里讨论这个令牌)原样保留 —— 那是内容,不是决定。
 */
export function parseSilence(raw: string): { text: string; silent: boolean; mixed: boolean } {
  if (TOKEN_LINE.test(raw)) return { text: '', silent: true, mixed: false }
  let mixed = false
  let text = raw
  if (raw.split('\n').some(l => TOKEN_LINE.test(l))) {
    text = raw.split('\n').filter(l => !TOKEN_LINE.test(l)).join('\n')
    mixed = true
  }
  const start = text.replace(TOKEN_EDGE_START, '')
  if (start !== text) { text = start; mixed = true }
  const end = text.replace(TOKEN_EDGE_END, '')
  if (end !== text) { text = end; mixed = true }
  if (!mixed) return { text: raw, silent: false, mixed: false }
  text = text.trim()
  if (text === '') return { text: '', silent: true, mixed: false }
  return { text, silent: false, mixed: true }
}

/** 已定 ②:推送、/chat、/both 的发言人可以静默;私聊(含桌面 / 手机)不行。 */
export function silenceAllowed(context: ReplyContext): boolean {
  return context !== 'dm'
}

/**
 * 把一轮的文字部分 + 登记的附件组装成 TurnReply。私聊里的 NO_REPLY 照样**不显示**(令牌永不外泄),
 * 但 `silentInDm=true` 交给调用方记 `REPLY_SILENT_IN_DM` 并计入「应答轮交付为空」的连击 —— 不替模型补话。
 */
export function buildTurnReply(
  parts: TurnTextParts,
  attachments: readonly TurnAttachment[],
  context: ReplyContext,
  strategy: ReplyTextStrategy = 'last_segment',
): { reply: TurnReply; silentInDm: boolean; mixed: boolean } {
  if (strategy === 'all_segments') {
    // 每段各自剥令牌。最后一段是 NO_REPLY = 模型的最终决定:允许静默的场合整轮不发(前面的「我先看看」
    // 也不发);私聊不认静默 —— 令牌吞掉、记异常,前面真说过的话照发(不替模型补话,也不吞它的话)。
    const raw = [...parts.narration, parts.finalText].filter(t => t.trim() !== '')
    const parsed = raw.map(t => parseSilence(t))
    const last = parsed[parsed.length - 1]
    const finalSilent = last?.silent === true
    const mixed = parsed.some(p => p.mixed)
    if (finalSilent && silenceAllowed(context)) {
      return { reply: { text: '', silent: true, attachments: [...attachments], narration: [], segments: [] }, silentInDm: false, mixed }
    }
    // 只有标点 / 空白的段(「。」)不是一句话,不单独发成一条气泡。
    const segments = parsed.filter(p => !p.silent && p.text.replace(/[\s\p{P}]/gu, '') !== '').map(p => p.text)
    return {
      reply: { text: segments.join('\n\n'), silent: finalSilent && segments.length === 0, attachments: [...attachments], narration: [], segments },
      silentInDm: finalSilent && !silenceAllowed(context),
      mixed,
    }
  }
  const s = parseSilence(parts.finalText)
  const narration = parts.narration
    .map(n => parseSilence(n))
    .filter(n => !n.silent && n.text.trim() !== '')
    .map(n => n.text)
  return {
    reply: { text: s.text, silent: s.silent, attachments: [...attachments], narration },
    silentInDm: s.silent && !silenceAllowed(context),
    mixed: s.mixed,
  }
}
