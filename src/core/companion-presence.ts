/**
 * companion-presence.ts — 桌宠状态的推导(spec 2026-09-03-companion-presence)。
 *
 * 红线:桌宠说的每一件事都能在日志里对上。所以这里没有任何「演」的状态,
 * 每个值都从 daemon 正在做的事推出来;输入全是现成信号(busy-registry label、
 * 串门登记、活跃会话、外发健康、子系统、journal 未看计数)。纯函数,daemon 只喂输入。
 *
 * 三轴互不干扰:在不在(presence)/ 在干什么(activity)/ 带了什么回来(news)。
 * activity 命中多个时按优先级取一个 —— 「正在跟你说话」永远比「出门了」更真。
 */

export type ActivityKind = 'idle' | 'chatting' | 'hosting_human' | 'visiting' | 'hosting_peer' | 'foraging' | 'working'
export type PresenceLevel = 'ok' | 'degraded' | 'offline'

export interface ActiveVisit { id: string; peerLabel: string; hosting: boolean; sinceMs: number }

export interface PresenceInputs {
  nowMs: number
  ownerChatId: string | null
  sessions: ReadonlyArray<{ chatId: string; lastUsedAt: number }>
  busyLabels: ReadonlyArray<string>
  visit: ActiveVisit | null
  outbound: 'unknown' | 'ok' | 'degraded' | null
  subsystemsDegraded: number
  journal: { unread: number; latest: { kind: string; title: string; ts: string } | null }
}

export interface Presence {
  presence: PresenceLevel
  activity: { kind: ActivityKind; label: string; since: string | null }
  news: { unread: number; latest_kind: string | null; latest_title: string | null }
}

/** 会话多久之内算「正在聊」。 */
export const ACTIVE_WINDOW_MS = 3 * 60_000

/** 这些 label 是「出门找东西」:打猎、派心愿。 */
const FORAGING_LABELS = new Set(['hunt', 'social-forage'])

/**
 * 不是伙伴活动的 label:`api:*` 是 internal-api 给每个非 GET 请求持的 token
 * (桌面自己的 POST 不能让熊「在忙」);`companion-*` 是三个调度器每拍都持的
 * (push/introspect/ingest),例行公事,打猎有自己的 `hunt` 名字。
 */
function isHousekeeping(label: string): boolean {
  return label.startsWith('api:') || label.startsWith('companion-')
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function derivePresence(i: PresenceInputs): Presence {
  // ── presence ──
  const presence: PresenceLevel =
    i.outbound === 'degraded' ? 'offline'
    : i.subsystemsDegraded > 0 ? 'degraded'
    : 'ok'

  // ── activity(按优先级,第一个命中的赢)──
  const active = i.sessions.filter(s => i.nowMs - s.lastUsedAt <= ACTIVE_WINDOW_MS)
  const owner = i.ownerChatId ? active.find(s => s.chatId === i.ownerChatId) : undefined
  const guest = active.find(s => s.chatId !== i.ownerChatId)
  const work = i.busyLabels.filter(l => !isHousekeeping(l))
  const foraging = work.some(l => FORAGING_LABELS.has(l))

  let activity: Presence['activity']
  if (owner) activity = { kind: 'chatting', label: '在跟你聊', since: iso(owner.lastUsedAt) }
  else if (guest) activity = { kind: 'hosting_human', label: '家里有客人', since: iso(guest.lastUsedAt) }
  else if (i.visit && !i.visit.hosting) activity = { kind: 'visiting', label: `去${i.visit.peerLabel}家串门了`, since: iso(i.visit.sinceMs) }
  else if (i.visit && i.visit.hosting) activity = { kind: 'hosting_peer', label: `${i.visit.peerLabel}来串门了`, since: iso(i.visit.sinceMs) }
  else if (foraging) activity = { kind: 'foraging', label: '觅食中', since: null }
  else if (work.length > 0) activity = { kind: 'working', label: '在忙一件事', since: null }
  else activity = { kind: 'idle', label: '', since: null }

  // ── news(透传;计数在存储层)──
  const news = {
    unread: i.journal.unread,
    latest_kind: i.journal.latest?.kind ?? null,
    latest_title: i.journal.latest?.title ?? null,
  }

  return { presence, activity, news }
}
