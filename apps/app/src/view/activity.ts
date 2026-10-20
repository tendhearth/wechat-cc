// 「CC 做过的事」(B9,2026-10-20)的纯视图模型:按本地日期分组(今天 / 昨天 / M月D日),一行 = HH:MM + 电脑写好的那句。
// 那句里已经带了成没成(「想跟你说一句,没发出去」「没跑成」…),这里不改写、不猜状态。纯 TS,不碰 react / expo。
import type { ActivityItemT, ActivityPageT } from '../backend/types'
import { t, type Lang } from '../i18n'

export type ActivityRow = { id: string; time: string; title: string; href: string | null }
export type ActivityGroup = { key: string; label: string; rows: ActivityRow[] }
export type ActivityView = { groups: ActivityGroup[]; empty: string | null; partial: string | null }

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 点一行去哪:一起做 ⇒ 那件事;终端 ⇒ 那条会话;信 ⇒ 那封信。别的(或 id 空)不能点。 */
export function activityHref(ref: ActivityItemT['ref']): string | null {
  if (!ref || !ref.id) return null
  const id = encodeURIComponent(ref.id)
  if (ref.type === 'task') return `/matter/${id}`
  if (ref.type === 'terminal') return `/terminal/${id}`
  if (ref.type === 'letter') return `/letters/${id}`
  return null
}

/** 组名:同一本地日 ⇒ 今天;前一日 ⇒ 昨天;再早 ⇒ 中文「10月18日」、英文「10/18」(同定时页)。 */
export function activityDayLabel(at: number, now: number, lang: Lang): string {
  const d = new Date(at), n = new Date(now)
  if (dayKey(d) === dayKey(n)) return t(lang, 'activity.today')
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1)
  if (dayKey(d) === dayKey(y)) return t(lang, 'activity.yesterday')
  return lang === 'zh-Hans' ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getMonth() + 1}/${d.getDate()}`
}

/** 翻页拼起来:按 id 去重(前一页的优先),再按时间倒序 —— 不信任两页之间的顺序。 */
export function mergeActivity(pages: readonly (readonly ActivityItemT[])[]): ActivityItemT[] {
  const seen = new Set<string>()
  const out: ActivityItemT[] = []
  for (const p of pages) for (const i of p) { if (seen.has(i.id)) continue; seen.add(i.id); out.push(i) }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function activityGroups(items: readonly ActivityItemT[], now: number, lang: Lang): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const i of mergeActivity([items])) {
    if (!Number.isFinite(i.at)) continue
    const d = new Date(i.at)
    const key = dayKey(d)
    let g = groups.at(-1)
    if (!g || g.key !== key) { g = { key, label: activityDayLabel(i.at, now, lang), rows: [] }; groups.push(g) }
    g.rows.push({ id: i.id, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, title: i.title, href: activityHref(i.ref) })
  }
  return groups
}

/** 整页:空 ⇒ 一句「这两周还没替你做过什么」;有来源读不到 ⇒ 一句灰字(不上红,其余照出)。 */
export function activityView(page: Pick<ActivityPageT, 'degraded'> & { items: readonly ActivityItemT[] }, now: number, lang: Lang): ActivityView {
  const groups = activityGroups(page.items, now, lang)
  return {
    groups,
    empty: groups.length === 0 ? t(lang, 'activity.empty') : null,
    partial: page.degraded.length > 0 ? t(lang, 'activity.partial') : null,
  }
}
