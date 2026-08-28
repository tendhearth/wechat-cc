export interface InboundMsg {
  chatId: string
  userId: string
  userName?: string
  text: string
  msgType: string
  createTimeMs: number
  /**
   * A quoted/replied-to message, extracted inline from ilink's `ref_msg`.
   * ilink gives us the content (text or a media-type label), never a stable
   * id — so this is the actual quoted text, not a lookup key. Rendered as a
   * `<quote type="…">…</quote>` element inside the <wechat> envelope.
   */
  quote?: { type: string; text: string }
  /**
   * 微信侧的消息 id(ilink MessageItem.msg_id,取首个带 id 的 item)。
   * 外部 provider 集成反馈 #4 (2026-08-26):信封里没有它,provider 侧
   * 无法做端到端幂等,只能信任上游 mw-dedup。有才渲染,老 provider 无感。
   */
  msgId?: string
  accountId: string
  /**
   * ilink-issued per-chat context token. ilink requires it on outbound
   * sendmessage; without it sendmessage returns errcode=-14 (session
   * timeout). The daemon captures this from each incoming message and
   * persists to context_tokens.json, then reads it back when replying.
   *
   * This field was lost in the v1.0 phase-1 rebuild — the old server.ts
   * did `if (msg.context_token) contextTokens.set(...)`; the new
   * src/daemon/main.ts dropped the field. v0.3.1 wires it back.
   */
  contextToken?: string
  attachments?: { kind: 'image' | 'file' | 'voice'; path: string; caption?: string }[]
  /**
   * Auto-recall (2026-08 memory-upgrades) — pre-formatted memory snippets
   * attached by mw-recall (admin chats only), rendered as a <recall> element
   * ahead of the message body so the agent starts the turn with relevant
   * context even when it never calls knowledge_search/memory_read itself.
   */
  recall?: string[]
}

/** Cap on the rendered <recall> body — recall is a hint, not a transcript. */
export const RECALL_BLOCK_MAX = 800

/**
 * 本地钟点 + 时区偏移的 ISO(如 2026-08-27T09:05:53-07:00)。偏移一律取自
 * 运行机器的系统时区(getTimezoneOffset),不假设任何地区。信封的「当前
 * 时间」基准用它而非 UTC 的 …Z —— CC 对「明天早上8点」「周三下午」这类
 * 本地钟点推理才算得对(2026-08-27:UTC-only 让 CC 无从知道用户时区,
 * 设提醒可能整点差几小时)。同一时刻,只是显示成系统本地墙钟 + 偏移;
 * Date.parse 仍还原到正确 instant。
 */
export function toLocalISO(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()   // 分钟:本地相对 UTC 的偏移(东为正)
  const sign = offMin >= 0 ? '+' : '-'
  const a = Math.abs(offMin)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/**
 * 本地日历日键 `YYYY-MM-DD`,给「连续 N 天」这类按天分桶的功能用。
 *
 * `offsetMinutes` = 相对 UTC 的分钟(东为正:UTC+8 → 480,PDT → -420)。
 *  - 省略 → 跟随运行机器在该时刻的系统时区(自动,且 getTimezoneOffset 逐
 *    时刻取值,夏令时也对)。daemon 跑在用户自己机器上,系统时区即"用户
 *    此刻人在哪",旅行会自动跟。
 *  - 传值 → 手动覆盖的口子(万一将来 daemon 上服务器,或用户就想钉死一个
 *    时区)。固定偏移不做夏令时换算 —— 对没有夏令时的地区(如中国)没问题。
 *
 * 关键约定:**记录时按当时的偏移算好写进去,永不回改**。因此旅行迁移不会
 * 让历史数据漂移 —— 每条记录在发生那一刻就按对当时的用户正确的那天分好了。
 */
export function localDayKey(ms: number, offsetMinutes?: number | null): string {
  const off = offsetMinutes ?? -new Date(ms).getTimezoneOffset()
  return new Date(ms + off * 60_000).toISOString().slice(0, 10)
}

export function formatInbound(m: InboundMsg): string {
  const attrs = [
    `chat_id="${escAttr(m.chatId)}"`,
    `user="${escAttr(m.userName ?? m.userId)}"`,
    `user_id="${escAttr(m.userId)}"`,
    `account="${escAttr(m.accountId)}"`,
    `msg_type="${escAttr(m.msgType)}"`,
    m.msgId ? `msg_id="${escAttr(m.msgId)}"` : '',
    `ts="${toLocalISO(m.createTimeMs)}"`,
  ].filter(Boolean).join(' ')

  const attachmentLines = (m.attachments ?? []).map(a => {
    const caption = a.caption ? ` ${escBody(a.caption)}` : ''
    return `[${a.kind}:${a.path}]${caption}`
  })

  const quoteEl = m.quote
    ? `<quote type="${escAttr(m.quote.type)}">${escBody(m.quote.text)}</quote>`
    : ''
  const recallLines = (m.recall ?? []).filter(r => r.trim().length > 0)
  const recallEl = recallLines.length
    ? `<recall hint="自动检索的相关片段，可能不相关，仅供参考">\n${escBody(recallLines.join('\n')).slice(0, RECALL_BLOCK_MAX)}\n</recall>`
    : ''
  const body = [recallEl, quoteEl, escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
  return `<wechat ${attrs}>\n${body}\n</wechat>`
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
