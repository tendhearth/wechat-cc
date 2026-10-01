// 「跟 CC 说」对话页的纯视图模型。被根目录测试 import:纯 TS,不碰 react / expo。
import { CHAT_TEXT_MAX } from '@wechat-cc/protocol'
import type { ChatMessageT, ChatPageT } from '../backend/types'
import { composeOutcome } from './compose'

export type Bubble = { key: string; side: 'me' | 'cc'; text: string; at: number; source: 'wechat' | 'desktop' | 'phone'; state: 'sent' | 'thinking' | 'failed'; failedKind?: 'busy' | 'unavailable' | 'maybeLost' | 'notConfirmed'; requestId?: string; truncated: boolean }
export type Accepted = { requestId: string; text: string; at: number }
type JobState = Pick<ChatPageT, 'pending' | 'failed'>

const LOST_WINDOW_MS = 60_000
const TS_SLACK_MS = 1_000
/**
 * 修订 Ruling 5:本机回执过了这么久还没落地、daemon 也不认 ⇒ 气泡从「可能没送到」改成「没确认送到」(可重试 / 不管它),
 * 不会悄悄消失;只在看到落地、重试后有了回复、或主人点「不管它」时才清。
 */
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

/**
 * 本机发过的这句是否已经出现在对话里:手机来源的「我」消息,且
 * - 正文 trim 后相等,时间不早于回执前 60 秒;或
 * - 被 daemon 截断过:正好截到 CHAT_TEXT_MAX、原文更长且以它开头,时间不早于回执前 1 秒(同一台 daemon 的钟,
 *   只留 ts 取整的余量;上一句回完才能说下一句,开头相同的上一条长消息不会被认成这一条)。空正文永远不算。
 */
function landed(msgs: ChatMessageT[], accepted: Accepted): boolean {
  const want = accepted.text.trim()
  return msgs.some(m => {
    if (m.role !== 'me' || m.source !== 'phone') return false
    if (m.at >= accepted.at - LOST_WINDOW_MS && m.text.trim() !== '' && m.text.trim() === want) return true
    return m.truncated && m.at >= accepted.at - TS_SLACK_MS && m.text.length >= CHAT_TEXT_MAX
      && accepted.text.length > m.text.length && accepted.text.startsWith(m.text)
  })
}

/** accepted:本机收过回执的句子(可以几句:前一句没确认时主人又说了一句);now 用 daemon 的钟(与 accepted.at 同一把)。 */
export function chatBubbles(msgs: ChatMessageT[], page: JobState, accepted: Accepted | readonly Accepted[] | null, now: number): Bubble[] {
  const out: Bubble[] = msgs.map(m => ({ key: m.id, side: m.role, text: m.text, at: m.at, source: m.source, state: 'sent', truncated: m.truncated }))
  const { pending, failed } = page
  if (pending) {
    out.push({ key: `p:${pending.requestId}`, side: 'me', text: pending.text, at: pending.since, source: 'phone', state: 'sent', truncated: false })
    out.push({ key: `t:${pending.requestId}`, side: 'cc', text: '', at: pending.since, source: 'phone', state: 'thinking', truncated: false })
  } else if (failed) {
    out.push({ key: `f:${failed.requestId}`, side: 'me', text: failed.text, at: failed.since, source: 'phone', state: 'failed', failedKind: failed.error === 'busy' ? 'busy' : 'unavailable', requestId: failed.requestId, truncated: false })
  }
  const mine: readonly Accepted[] = accepted === null ? [] : Array.isArray(accepted) ? accepted : [accepted as Accepted]
  for (const a of mine) {
    if (pending?.requestId === a.requestId || failed?.requestId === a.requestId || landed(msgs, a)) continue
    out.push({ key: `l:${a.requestId}`, side: 'me', text: a.text, at: a.at, source: 'phone', state: 'failed', failedKind: now - a.at > ACCEPTED_TTL_MS ? 'notConfirmed' : 'maybeLost', requestId: a.requestId, truncated: false })
  }
  return out
}

/**
 * 屏幕该不该清掉本机回执(修订 Ruling 5):只有看到落地才清。daemon 还说 pending / failed 着 ⇒ 留(那两种自己有气泡);
 * 过了 ACCEPTED_TTL_MS 也不清 —— chatBubbles 把它画成「没确认送到」,由重试(同一个 requestId)或「不管它」收尾。
 */
export function acceptedSettled(accepted: Accepted | null, msgs: ChatMessageT[], _page: JobState): boolean {
  return !accepted || landed(msgs, accepted)
}

/** 提交结果 ⇒ 对话页输入框上方那一行提示的种类。 */
export function chatSendOutcome(r: 'ok' | 'busy' | { error: string }): 'ok' | 'busy' | 'ccBusy' | 'uncertain' | 'revoked' | 'failed' {
  if (r === 'ok' || r === 'busy') return r
  return composeOutcome(r.error)
}

/** 只有主人的那条聊天才改道去 /chat(Ruling 9);ownerChatMatterId 来自 GET chat 的 matterId,没主人 ⇒ null。 */
export function isOwnerChatMatter(m: { id: string; kind: string }, ownerChatMatterId: string | null): boolean {
  return m.kind === 'chat' && ownerChatMatterId !== null && m.id === ownerChatMatterId
}
