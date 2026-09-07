/**
 * mobile-feed.ts — 随身 CC 首屏「伙伴的一天」(spec 2026-09-06-mobile-home-feed §3)。
 *
 * 三个已有来源读时合并成一条事件流:journal(背包)、plan-log(伙伴自己的
 * 决定 = 想法)、turn_records(聊天日摘要)。**纯函数,无 IO**:读盘/读库在
 * settings-panel 的 deps 注入里。不把想法/聊天写进 journal —— journal 是
 * 背包,条目有 tried/using/dropped 语义,硬塞会污染那套状态。
 *
 * 分页范围是「合并后的有界窗口」(journal 200 条 + plan-log 14 天 + 聊天 14
 * 天),不是无限历史;v1 在内存里合并排序,不做 SQL 级多源游标。
 */
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'

export type FeedKind = 'hunt' | 'visit' | 'postcard' | 'thought' | 'chat_day'
export type FeedSource = 'journal' | 'thought' | 'chat_day'

export interface FeedEvent {
  id: string
  ts: string
  kind: FeedKind
  title: string
  note: string | null
  /** 伙伴时区下的 YYYY-MM-DD,页面按它分组(不让页面自己算时区)。 */
  day: string
  ref?: { url: string | null; image_svg: string | null; status: string }
}

export interface TurnLite { chatId: string; endedAt: number; outcome: string }

export interface FeedSources {
  journal: readonly CatchRow[] | null
  thoughts: readonly PlanLogEntry[] | null
  turns: readonly TurnLite[] | null
}

export interface FeedOpts {
  ownerChatId: string | null
  timezone: string
  cursor?: string | null
  limit?: number
  seenUntil?: string | null
}

export interface FeedResult {
  events: FeedEvent[]
  next_cursor: string | null
  unread: number
  sources_degraded: FeedSource[]
}

export const FEED_DEFAULT_LIMIT = 30
export const FEED_MAX_LIMIT = 100

const dayFmtCache = new Map<string, Intl.DateTimeFormat>()
function dayFmt(timezone: string): Intl.DateTimeFormat {
  let f = dayFmtCache.get(timezone)
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
    catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }) }
    dayFmtCache.set(timezone, f)
  }
  return f
}

/** en-CA 的 short date 恰好是 YYYY-MM-DD。 */
export function dayKey(ms: number, timezone: string): string {
  return dayFmt(timezone).format(new Date(ms))
}

const THOUGHT_TITLE: Record<string, string> = { hunt: '出门打猎去了', visit: '去串门了', none: '在家待着' }

export function thoughtEvent(e: PlanLogEntry, timezone: string): FeedEvent {
  const aborted = e.why.startsWith('(failed) ') || e.why.startsWith('(skipped) ')
  return {
    id: `thought:${e.at}`,
    ts: e.at,
    kind: 'thought',
    title: aborted ? '想出门,没走成' : (THOUGHT_TITLE[e.decision] ?? e.decision),
    // 只有模型自己说的话才是想法;fallback 的 why 是机器原因,downgraded 的
    // why 说的是另一件事(想做的没在候选里)。都不给它编理由。
    note: !aborted && e.source === 'model' ? e.why : null,
    day: dayKey(Date.parse(e.at), timezone),
  }
}

export function chatDayEvents(turns: readonly TurnLite[], ownerChatId: string | null, timezone: string): FeedEvent[] {
  const byDay = new Map<string, { owner: number; guestTurns: number; guests: Set<string>; lastMs: number }>()
  for (const t of turns) {
    if (t.outcome !== 'completed') continue
    const day = dayKey(t.endedAt, timezone)
    let b = byDay.get(day)
    if (!b) { b = { owner: 0, guestTurns: 0, guests: new Set(), lastMs: 0 }; byDay.set(day, b) }
    if (ownerChatId !== null && t.chatId === ownerChatId) b.owner++
    else { b.guestTurns++; b.guests.add(t.chatId) }
    if (t.endedAt > b.lastMs) b.lastMs = t.endedAt
  }
  const out: FeedEvent[] = []
  for (const [day, b] of byDay) {
    const guest = b.guestTurns > 0 ? `和 ${b.guests.size} 位客人聊了 ${b.guestTurns} 回` : ''
    const title = b.owner > 0
      ? (guest ? `和主人聊了 ${b.owner} 回,还${guest}` : `和主人聊了 ${b.owner} 回`)
      : guest
    out.push({ id: `chat_day:${day}`, ts: new Date(b.lastMs).toISOString(), kind: 'chat_day', title, note: null, day })
  }
  return out
}

function journalEvent(r: CatchRow, timezone: string): FeedEvent {
  return {
    id: `journal:${r.id}`, ts: r.ts, kind: r.kind, title: r.title, note: r.note || null,
    day: dayKey(Date.parse(r.ts), timezone),
    ref: { url: r.url, image_svg: r.image_svg, status: r.status },
  }
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(s: string): { ts: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const raw = Buffer.from(s, 'base64url').toString('utf8')
  const i = raw.indexOf('|')
  if (i <= 0 || i === raw.length - 1) return null
  const ts = raw.slice(0, i)
  if (Number.isNaN(Date.parse(ts))) return null
  return { ts, id: raw.slice(i + 1) }
}

/** ts 降序;同 ts 按 id 升序(稳定,游标才接得上)。 */
function cmp(a: FeedEvent, b: FeedEvent): number {
  return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function buildFeed(src: FeedSources, opts: FeedOpts): FeedResult {
  const degraded: FeedSource[] = []
  const all: FeedEvent[] = []
  if (src.journal) for (const r of src.journal) all.push(journalEvent(r, opts.timezone)); else degraded.push('journal')
  if (src.thoughts) for (const e of src.thoughts) all.push(thoughtEvent(e, opts.timezone)); else degraded.push('thought')
  if (src.turns) all.push(...chatDayEvents(src.turns, opts.ownerChatId, opts.timezone)); else degraded.push('chat_day')
  all.sort(cmp)

  const seen = opts.seenUntil ?? null
  const unread = seen === null ? all.length : all.filter(e => e.ts > seen).length

  const limit = Math.min(FEED_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? FEED_DEFAULT_LIMIT)))
  const c = opts.cursor ? decodeCursor(opts.cursor) : null
  const after = c ? all.filter(e => e.ts < c.ts || (e.ts === c.ts && e.id > c.id)) : all
  const page = after.slice(0, limit)
  const last = page.at(-1)
  const next_cursor = after.length > limit && last ? encodeCursor(last.ts, last.id) : null
  return { events: page, next_cursor, unread, sources_degraded: degraded }
}
