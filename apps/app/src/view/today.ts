import type { OverseerTodayT, TodayItemT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { relAgo } from './terminal'

/**
 * 「今天」那一小段(2026-10-14,GET /m/api/today):CC 统管的所有执行者过去 24 小时的几个数 + 最近做完的三件。
 * 与微信「日报」同一份数据。点一行 ⇒ 现成的页面:终端会话进 /terminal/[id],一起做进 /matter/[id]。
 */
export type TodayRow = { key: string; href: string; title: string; sub: string; ago: string }
export type TodayView = {
  /** 「过去 24 小时」;离开手机一小时以上、这期间有做完的 ⇒ 「你不在的这 N 小时」(只数这段)。 */
  title: string
  /** 「5 件做完 · 1 件在做 · 1 件可能卡住」;是 0 的不写。等你的不在这里数 —— 下面「N 件事等你」已经列着,同一个数不出现两次。 */
  counts: string
  /** Number behind the compact history entry; uses exactly the same range as title and rows. */
  doneCount: number
  /** 最近做完的前 3 件。 */
  done: TodayRow[]
  /** 有一路(终端 / 一起做)读不到 ⇒ 数字不全。 */
  partial: boolean
}

export const TODAY_DONE_ROWS = 3
/** 离开多久才算「不在」:短于这个(切个应用又回来)照旧看 24 小时。 */
export const AWAY_MIN_MS = 3_600_000

export function todayHref(i: Pick<TodayItemT, 'source' | 'id'>): string {
  return i.source === 'terminal' ? `/terminal/${encodeURIComponent(i.id)}` : `/matter/${encodeURIComponent(i.id)}`
}

export function todayRow(i: TodayItemT, now: number, lang: Lang): TodayRow {
  const title = (i.source === 'together' ? i.title || i.project : i.project) || i.agent
  return {
    key: `${i.source}:${i.id}`,
    href: todayHref(i),
    title,
    sub: i.summary ? `${i.agent} · ${i.summary}` : i.agent,
    ago: relAgo(i.at, now, lang),
  }
}

/**
 * 没数据 / 除了等你的什么都没有(且两路都读得到)⇒ null:此刻页不放一段空的。
 * away = 上次把 App 放到后台的时间(2026-10-17,「你不在的时候」):离开 ≥ 1 小时、还在 24 小时窗口里、这期间有做完的
 * ⇒ 标题换成「你不在的这 N 小时」,做完的只数、只列这段;在跑 / 可能卡住是此刻的状态,照旧。
 */
export function todayView(today: OverseerTodayT | undefined, now: number, lang: Lang, away?: number | null): TodayView | null {
  if (!today) return null
  const c = today.counts
  const partial = today.unavailable.length > 0
  if (c.done + c.running + c.stuck === 0 && !partial) return null
  const sinceAway = away && now - away >= AWAY_MIN_MS && away >= today.since ? today.done.filter(i => i.at > away) : []
  const done = sinceAway.length ? sinceAway : today.done
  const title = sinceAway.length ? t(lang, 'today.whileAway', { n: Math.round((now - away!) / 3_600_000) }) : t(lang, 'today.title')
  const parts = [
    ...(sinceAway.length || c.done ? [t(lang, 'today.done', { n: sinceAway.length || c.done })] : []),
    ...(c.running ? [t(lang, 'today.running', { n: c.running })] : []),
    ...(c.stuck ? [t(lang, 'today.stuck', { n: c.stuck })] : []),
  ]
  return { title, counts: parts.join(' · '), doneCount: sinceAway.length || c.done, done: done.slice(0, TODAY_DONE_ROWS).map(i => todayRow(i, now, lang)), partial }
}
