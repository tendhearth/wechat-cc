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
import { safeSvg } from '../lib/svg-sanitize'

export type FeedKind = 'hunt' | 'visit' | 'postcard' | 'recollection' | 'thought' | 'chat_day'
export type FeedSource = 'journal' | 'thought' | 'chat_day'

export interface FeedEvent {
  id: string
  ts: string
  kind: FeedKind
  title: string
  note: string | null
  /** 伙伴时区下的 YYYY-MM-DD,页面按它分组(不让页面自己算时区)。 */
  day: string
  /** 伙伴时区下的 HH:mm(同 day 用一个 Intl 时区算——不让页面用手机的时区拼时间)。 */
  hhmm: string
  ref?: { url: string | null; image_svg: string | null; status: string }
}

export interface TurnLite { chatId: string; endedAt: number; outcome: string; mode: string; startedAt: number }

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

const hhmmFmtCache = new Map<string, Intl.DateTimeFormat>()
function hhmmFmt(timezone: string): Intl.DateTimeFormat {
  let f = hhmmFmtCache.get(timezone)
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }) }
    catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }) }
    hhmmFmtCache.set(timezone, f)
  }
  return f
}

/**
 * 伙伴时区下的 HH:mm ——跟 dayKey 用同一个 Intl timeZone,不让页面用手机的
 * 时区拼时间(I3:两地相隔一个时区,「今天 08:00」在页面本地重算会变天)。
 */
export function hhmmOf(ms: number, timezone: string): string {
  return hhmmFmt(timezone).format(new Date(ms))
}

const THOUGHT_TITLE: Record<string, string> = { hunt: '出门打猎去了', visit: '去串门了', none: '在家待着' }

export function thoughtEvent(e: PlanLogEntry, timezone: string): FeedEvent {
  // 手改坏的 plan-log 条目可能有 at/chatId 却没有 why(或不是字符串)——
  // M1:这里绝不能抛,抛出会在 collectSources 的 try/catch 之外(buildFeed
  // 里),把整个请求 500 掉,而不是把这一源记成 degraded。
  const why = typeof e.why === 'string' ? e.why : ''
  const aborted = why.startsWith('(failed) ') || why.startsWith('(skipped) ')
  const atMs = Date.parse(e.at)
  return {
    // M2:id 带上 chatId —— 光用 at(毫秒)会在两个聊天同一毫秒决策时撞车,
    // 撞车又恰好落在分页边界上会被游标去重悄悄吞掉一条。
    id: `thought:${e.chatId}:${e.at}`,
    ts: e.at,
    kind: 'thought',
    title: aborted ? '想出门,没走成' : (THOUGHT_TITLE[e.decision] ?? e.decision),
    // 只有模型自己说的话才是想法;fallback 的 why 是机器原因,downgraded 的
    // why 说的是另一件事(想做的没在候选里)。都不给它编理由。
    note: !aborted && e.source === 'model' && why ? why : null,
    day: dayKey(atMs, timezone),
    hhmm: hhmmOf(atMs, timezone),
  }
}

export function chatDayEvents(turns: readonly TurnLite[], ownerChatId: string | null, timezone: string): FeedEvent[] {
  const byDay = new Map<string, { owner: number; guestTurns: number; guests: Set<string>; lastMs: number }>()
  // I1:parallel 模式一条 inbound 会按 provider 各写一行,同一 (chatId,
  // startedAt) 折叠成一次;chatroom 模式一条 inbound 按「发言人 × 轮数」
  // 写多行,直接整段跳过 —— 这两种都不是「主人又聊了一回」。
  const seenParallel = new Set<string>()
  for (const t of turns) {
    if (t.outcome !== 'completed') continue
    if (t.mode === 'chatroom') continue
    if (t.mode === 'parallel') {
      const key = `${t.chatId}|${t.startedAt}`
      if (seenParallel.has(key)) continue
      seenParallel.add(key)
    }
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
    out.push({ id: `chat_day:${day}`, ts: new Date(b.lastMs).toISOString(), kind: 'chat_day', title, note: null, day, hhmm: hhmmOf(b.lastMs, timezone) })
  }
  return out
}

function journalEvent(r: CatchRow, timezone: string): FeedEvent {
  const ms = Date.parse(r.ts)
  return {
    id: `journal:${r.id}`, ts: r.ts, kind: r.kind, title: r.title, note: r.note || null,
    day: dayKey(ms, timezone),
    hhmm: hhmmOf(ms, timezone),
    // I6:写路径已经 gate 过(wire-visit → safeSvg),这里是读侧防御性再消毒
    // ——跟 internal-api/routes-memory.ts 对小像的做法一致(手改文件兜底)。
    ref: { url: r.url, image_svg: r.image_svg ? safeSvg(r.image_svg) : null, status: r.status },
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
