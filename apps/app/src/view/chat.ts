// 「跟 CC 说」对话页的纯视图模型。被根目录测试 import:纯 TS,不碰 react / expo。
import type { ChatMessageT, ChatPageT } from '../backend/types'

export type Bubble = { key: string; side: 'me' | 'cc'; text: string; at: number; source: 'wechat' | 'desktop' | 'phone'; state: 'sent' | 'thinking' | 'failed'; failedKind?: 'busy' | 'unavailable' | 'maybeLost'; requestId?: string; truncated: boolean }
export type Accepted = { requestId: string; text: string; at: number }
type JobState = Pick<ChatPageT, 'pending' | 'failed'>

const LOST_WINDOW_MS = 60_000
/** 本机回执最多留这么久(Ruling 5):过了还没落地也清掉,免得翻页后一直挂着「可能没送到」。 */
export const ACCEPTED_TTL_MS = 120_000

export function mergeChatPages(latest: ChatPageT, older: ChatPageT[]): ChatMessageT[] {
  const byId = new Map<string, ChatMessageT>()
  for (const p of [...older, latest]) for (const m of p.messages) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

export function olderCursor(latest: ChatPageT, older: ChatPageT[]): string | null {
  const last = older.length ? older[older.length - 1]! : latest
  return last.hasMore ? last.nextBefore : null
}

/** 本机发过的这句是否已经出现在对话里(手机来源、同样正文、时间不早于回执前 60 秒;被截断的按前缀比)。 */
function landed(msgs: ChatMessageT[], accepted: Accepted): boolean {
  return msgs.some(m => m.role === 'me' && m.source === 'phone' && m.at >= accepted.at - LOST_WINDOW_MS
    && (m.truncated ? accepted.text.startsWith(m.text) : m.text === accepted.text))
}

export function chatBubbles(msgs: ChatMessageT[], page: JobState, accepted: Accepted | null): Bubble[] {
  const out: Bubble[] = msgs.map(m => ({ key: m.id, side: m.role, text: m.text, at: m.at, source: m.source, state: 'sent', truncated: m.truncated }))
  const { pending, failed } = page
  if (pending) {
    out.push({ key: `p:${pending.requestId}`, side: 'me', text: pending.text, at: pending.since, source: 'phone', state: 'sent', truncated: false })
    out.push({ key: `t:${pending.requestId}`, side: 'cc', text: '', at: pending.since, source: 'phone', state: 'thinking', truncated: false })
  } else if (failed) {
    out.push({ key: `f:${failed.requestId}`, side: 'me', text: failed.text, at: failed.since, source: 'phone', state: 'failed', failedKind: failed.error === 'busy' ? 'busy' : 'unavailable', requestId: failed.requestId, truncated: false })
  }
  if (accepted && pending?.requestId !== accepted.requestId && failed?.requestId !== accepted.requestId && !landed(msgs, accepted)) {
    out.push({ key: `l:${accepted.requestId}`, side: 'me', text: accepted.text, at: accepted.at, source: 'phone', state: 'failed', failedKind: 'maybeLost', requestId: accepted.requestId, truncated: false })
  }
  return out
}

/**
 * 屏幕该不该清掉本机回执(Ruling 5):已经看到落地 ⇒ 清;daemon 还说 pending / failed 着这条 ⇒ 留
 * (那两种自己有气泡);否则过了 ACCEPTED_TTL_MS 一律清 —— 落地的那条翻出最新一页后不会再冒出幽灵气泡。
 */
export function acceptedSettled(accepted: Accepted | null, msgs: ChatMessageT[], page: JobState, now: number): boolean {
  if (!accepted) return true
  if (landed(msgs, accepted)) return true
  if (page.pending?.requestId === accepted.requestId || page.failed?.requestId === accepted.requestId) return false
  return now - accepted.at > ACCEPTED_TTL_MS
}

/** 只有主人的那条聊天才改道去 /chat(Ruling 9);ownerChatMatterId 来自 GET chat 的 matterId,没主人 ⇒ null。 */
export function isOwnerChatMatter(m: { id: string; kind: string }, ownerChatMatterId: string | null): boolean {
  return m.kind === 'chat' && ownerChatMatterId !== null && m.id === ownerChatMatterId
}
