import type { OverseerTodayT, TodayItemT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { relAgo } from './terminal'

/**
 * 「今天」那一小段(2026-10-14,GET /m/api/today):CC 统管的所有执行者过去 24 小时的几个数 + 最近做完的三件。
 * 与微信「日报」同一份数据。点一行 ⇒ 现成的页面:终端会话进 /terminal/[id],一起做进 /matter/[id]。
 */
export type TodayRow = { key: string; href: string; title: string; sub: string; ago: string }
export type TodayView = {
  /** 「2 件等你 · 5 件做完 · 1 件在跑 · 1 件可能卡住」;可能卡住为 0 时不写。 */
  counts: string
  /** 最近做完的前 3 件。 */
  done: TodayRow[]
  /** 有一路(终端 / 一起做)读不到 ⇒ 数字不全。 */
  partial: boolean
}

export const TODAY_DONE_ROWS = 3

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

/** 没数据 / 什么都没有(且两路都读得到)⇒ null:此刻页不放一段空的。 */
export function todayView(today: OverseerTodayT | undefined, now: number, lang: Lang): TodayView | null {
  if (!today) return null
  const c = today.counts
  const partial = today.unavailable.length > 0
  if (c.needsYou + c.done + c.running + c.stuck === 0 && !partial) return null
  const parts = [
    t(lang, 'today.needsYou', { n: c.needsYou }),
    t(lang, 'today.done', { n: c.done }),
    t(lang, 'today.running', { n: c.running }),
    ...(c.stuck ? [t(lang, 'today.stuck', { n: c.stuck })] : []),
  ]
  return { counts: parts.join(' · '), done: today.done.slice(0, TODAY_DONE_ROWS).map(i => todayRow(i, now, lang)), partial }
}
