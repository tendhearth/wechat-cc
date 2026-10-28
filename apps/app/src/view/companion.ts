import { markdownPlainText, safeMarkdownUrl } from '@wechat-cc/markdown'
import type { FeedEventT } from '../backend/types'
import type { MessageKey } from '../i18n'

/**
 * 此刻页让 CC 活起来的两样(2026-10-18):CC 下面一行「它在干什么」+ 一张它带回来的东西。
 * 红线同桌宠:永不撒谎 —— 每句都对得上 daemon 的真信号(companion-presence.ts 的 activity、agents 主题的 running);
 * 没信号 / 歇着 / 认不出的状态 ⇒ 不说话(null),不编「在等你」之类的客套。
 */

/** activity → 文案。idle 与认不出的 kind 不在表里 ⇒ 不说。 */
const ACTIVITY = new Map<string, MessageKey>([
  ['chatting', 'companion.chatting'],
  ['hosting_human', 'companion.hostingHuman'],
  ['visiting', 'companion.visiting'],
  ['hosting_peer', 'companion.hostingPeer'],
  ['foraging', 'companion.foraging'],
  ['working', 'companion.busy'],
])

/**
 * CC 下面那一行。known = 这份数据是真的、现在的(真连接且令牌被认过 / 演示);否则一个字都不说。
 * 优先级:在跟人说话 > 执行者正在写(running > 0,agents 主题)> 串门 / 来客 / 打猎 > 别的忙。
 * running 不写数:「过去 24 小时」那段已经有「N 件在做」(口径还不同,两个数会打架)。
 */
export function companionStatus(i: { known: boolean; activity: string | null | undefined; running: number }): MessageKey | null {
  if (!i.known) return null
  const said = i.activity ? ACTIVITY.get(i.activity) ?? null : null
  if (i.activity === 'chatting' || i.activity === 'hosting_human') return said
  if (i.running > 0) return 'companion.working'
  return said
}

/** 此刻页只放打猎找到的和明信片;想法、聊天日摘要、串门记录留在桌面觅食台 / 网页版。 */
export const COMPANION_CARD_KINDS: ReadonlySet<string> = new Set(['hunt', 'postcard'])
/** 水位从没设过(null = 全算没看)时,太旧的不再当「新的」端上来。 */
export const COMPANION_FRESH_MS = 7 * 86_400_000

export type CompanionCard = {
  id: string
  kind: 'hunt' | 'postcard'
  ts: string
  at: number
  title: string
  note: string | null
  /** 只有 http(s) 才给;点卡片就开它。没有 ⇒ 点了原地展开。 */
  url: string | null
}

const after = (ts: string, mark: string | null | undefined): boolean => {
  if (!mark) return true
  const a = Date.parse(ts), b = Date.parse(mark)
  return !Number.isFinite(b) || (Number.isFinite(a) && a > b)
}

/**
 * 最新一张没看过的(events 新的在前,与 daemon 同序)。seenUntil = 电脑上的水位;localSeen = 本机刚点过、电脑还没回话的那一刻。
 * 都看过 / 没有 / 太旧 ⇒ null,卡片整个不出现。
 */
export function companionCard(events: readonly FeedEventT[] | undefined, seenUntil: string | null, now: number, localSeen?: string | null): CompanionCard | null {
  for (const e of events ?? []) {
    if (!COMPANION_CARD_KINDS.has(e.kind)) continue
    const at = Date.parse(e.ts)
    if (!Number.isFinite(at)) continue
    if (!after(e.ts, seenUntil) || !after(e.ts, localSeen)) return null // 新的在前:最新那张都看过了,更旧的也不再提
    if (seenUntil === null && now - at > COMPANION_FRESH_MS) return null
    const title = markdownPlainText(e.title).trim()
    if (!title) continue
    const note = e.note ? markdownPlainText(e.note).trim() || null : null
    const url = e.ref?.url ? safeMarkdownUrl(e.ref.url) : null
    return { id: e.id, kind: e.kind as CompanionCard['kind'], ts: e.ts, at, title, note, url }
  }
  return null
}

/** home 主题里会让卡片变的那两样(未读数、最新一条的游标);变了才重拉首屏,不轮询。状态行直接读主题,不靠重拉。 */
export function companionSignature(topic: { unread: number; nextCursor: string | null } | undefined): string | null {
  return topic ? `${topic.unread}|${topic.nextCursor ?? ''}` : null
}
