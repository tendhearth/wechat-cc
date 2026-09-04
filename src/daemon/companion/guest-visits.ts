/**
 * guest-visits.ts — 人类做客:主人的朋友本人来跟伙伴聊了一会儿(guest path),
 * 聊完走了,伙伴回头跟主人顺口提一句「刚才谁来过」。
 *
 * WHY(2026-09-03):owner 原话「社交才会让人感觉自己的伙伴能与别的 agent/**人**
 * 去交流」。人这一半其实早就通了 —— guest path 上线两周,朋友什么都不用装
 * 就能跟你的伙伴聊 —— 但它一直被当成「访客用工具」,伙伴从不把这当成自己
 * 的社交讲给主人听。这是冷启动最强的解:朋友不用装 wechat-cc。
 *
 * 纯判定部分在这里(什么算「一次做客结束了」),IO 在 tick-bodies 注入。
 */

/** 客人这么久没再说话,就算走了。 */
export const GUEST_IDLE_MS = 30 * 60_000
/** 少于这么多句进来的话,不算一次做客(「在吗」不值得一提)。 */
export const GUEST_MIN_INBOUND = 2

export interface GuestVisitState {
  /** chatId → 上次讲过的水位(那次做客最后一条消息的 ts)。 */
  narrated: Record<string, string>
}

export interface GuestChatSnapshot {
  chatId: string
  latestInboundTs: string | null
  /** 水位之后的消息(含双向)。 */
  since: Array<{ direction: 'in' | 'out'; text: string; ts: string }>
}

/**
 * 这个 chat 现在该不该讲。返回要讲的那段(水位之后的消息)或 null。
 *  - 没有新的入站 → 否
 *  - 客人最后一句还不到 GUEST_IDLE_MS → 否(还在聊)
 *  - 水位之后客人说的不到 GUEST_MIN_INBOUND 句 → 否(一句「在吗」不算做客)
 */
export function dueGuestVisit(
  snap: GuestChatSnapshot,
  state: GuestVisitState,
  nowMs: number,
): GuestChatSnapshot['since'] | null {
  if (!snap.latestInboundTs) return null
  const mark = state.narrated[snap.chatId]
  if (mark && snap.latestInboundTs <= mark) return null
  const last = Date.parse(snap.latestInboundTs)
  if (Number.isNaN(last) || nowMs - last < GUEST_IDLE_MS) return null
  const fresh = mark ? snap.since.filter(m => m.ts > mark) : snap.since
  if (fresh.filter(m => m.direction === 'in').length < GUEST_MIN_INBOUND) return null
  return fresh
}

/** 微信的 chatId 太丑;没名字时给主人一个能读的说法。 */
export function guestLabel(name: string | null | undefined, chatId: string): string {
  const n = (name ?? '').trim()
  if (n) return n
  const head = chatId.split('@')[0] ?? chatId
  return `「${head.slice(0, 6)}…」那位`
}
