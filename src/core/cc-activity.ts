/**
 * 「CC 做过的事」时间线(B9,spec 2026-10-20-cc-activity-design)的纯函数:多来源合并、游标、窗口、成句。
 * 只读、确定性、不调模型;来源各自读失败 ⇒ null ⇒ 进 degraded,其余照出。
 */

export const ACTIVITY_WINDOW_MS = 14 * 86_400_000
export const ACTIVITY_DEFAULT_LIMIT = 30
export const ACTIVITY_MAX_LIMIT = 100
export const ACTIVITY_TITLE_MAX = 120

export type ActivityKind = 'decision' | 'together' | 'terminal' | 'letter' | 'memory' | 'proactive' | 'job' | 'reminder' | 'cli_upgrade'
export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** 毫秒 */
  at: number
  title: string
  ref?: { type: 'task' | 'terminal' | 'letter'; id: string }
}
export type ActivitySourceName = 'decisions' | 'together' | 'terminal' | 'letters' | 'memory' | 'log' | 'jobs'
export type ActivitySources = Partial<Record<ActivitySourceName, ActivityItem[] | null>>

const encode = (at: number, id: string) => Buffer.from(`${at}|${id}`, 'utf8').toString('base64url')
function decode(s: string): { at: number; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(s)) return null
  const raw = Buffer.from(s, 'base64url').toString('utf8')
  const i = raw.indexOf('|')
  if (i <= 0 || i === raw.length - 1) return null
  const at = Number(raw.slice(0, i))
  return Number.isFinite(at) ? { at, id: raw.slice(i + 1) } : null
}
/** 新的在前;同一刻按 id 升序(稳定,游标才接得上)。 */
const cmp = (a: ActivityItem, b: ActivityItem) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function buildActivity(src: ActivitySources, opts: { now: number; limit?: number; cursor?: string | null }): { items: ActivityItem[]; next: string | null; degraded: ActivitySourceName[] } {
  const degraded: ActivitySourceName[] = []
  const all: ActivityItem[] = []
  for (const [name, items] of Object.entries(src) as Array<[ActivitySourceName, ActivityItem[] | null | undefined]>) {
    if (items === null) { degraded.push(name); continue }
    for (const it of items ?? []) if (it.at <= opts.now && it.at >= opts.now - ACTIVITY_WINDOW_MS) all.push(it)
  }
  all.sort(cmp)
  const limit = Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? ACTIVITY_DEFAULT_LIMIT)))
  const c = opts.cursor ? decode(opts.cursor) : null
  const after = c ? all.filter(e => e.at < c.at || (e.at === c.at && e.id > c.id)) : all
  const page = after.slice(0, limit)
  const last = page.at(-1)
  return { items: page, next: after.length > limit && last ? encode(last.at, last.id) : null, degraded: degraded.sort() }
}

/** 一行、去掉绝对路径(只留最后一段目录名)、封顶 120 字。 */
export function activityTitle(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const noPaths = flat
    .replace(/(?:\/(?:Users|home|private|var|tmp|Volumes)[^\s]*)/g, m => m.replace(/\/+$/, '').split('/').pop() ?? '')
    .replace(/[A-Za-z]:\\[^\s]*/g, m => m.replace(/\\+$/, '').split('\\').pop() ?? '')
  return [...noPaths].slice(0, ACTIVITY_TITLE_MAX).join('')
}
