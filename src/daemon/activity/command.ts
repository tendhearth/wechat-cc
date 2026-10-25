/**
 * 微信「做过的事 [今天|本周]」(B9 在微信上,2026-10-20):与手机时间线同一组来源,只认主人。
 * 只读、确定性,不调模型;一条一行带时间,最多 15 行。
 */
import type { ActivityItem } from '../../core/cc-activity'
import type { ReplyHandler } from '../commands/registry'

export const ACTIVITY_WECHAT_LINES = 15

export function parseActivityCommand(text: string): { days: 1 | 7 } | null {
  const m = /^\s*做过的事(?:\s+(\S+))?\s*$/.exec(text)
  if (!m) return null
  if (!m[1] || m[1] === '今天') return { days: 1 }
  if (m[1] === '本周' || m[1] === '这周' || m[1] === '这一周') return { days: 7 }
  return null
}

export function formatActivityForWechat(r: { items: ActivityItem[]; degraded: string[] }, o: { now: number; days: 1 | 7; timeZone: string }): string {
  const since = o.now - o.days * 86_400_000
  const items = r.items.filter(i => i.at >= since && i.at <= o.now).sort((a, b) => b.at - a.at)
  const span = o.days === 1 ? '过去 24 小时' : '这一周'
  if (!items.length) return `${span} CC 还没替你做过什么。${r.degraded.length ? '(有一部分暂时读不到)' : ''}`
  const when = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: o.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]))
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`
  }
  const lines = items.slice(0, ACTIVITY_WECHAT_LINES).map(i => `· ${when(i.at)} ${i.title}`)
  return [
    `${span} CC 替你做的事(${items.length} 件):`,
    ...lines,
    ...(items.length > ACTIVITY_WECHAT_LINES ? [`(还有 ${items.length - ACTIVITY_WECHAT_LINES} 件没列,手机「此刻」底下「CC 做过的事」能往下翻)`] : []),
    ...(r.degraded.length ? ['(有一部分暂时读不到)'] : []),
  ].join('\n')
}

export function makeActivityCommand(deps: {
  isOwner: (chatId: string) => boolean
  say: (chatId: string, text: string) => Promise<unknown>
  now: () => number
  timeZone: () => string
  /** 最近 N 天的条目(只算主人);抛 ⇒ 说读不到。 */
  items: (days: 1 | 7) => { items: ActivityItem[]; degraded: string[] }
}): ReplyHandler {
  return {
    probe: (text, chatId) => parseActivityCommand(text) !== null && deps.isOwner(chatId),
    async handle(text, chatId) {
      const c = parseActivityCommand(text)
      if (!c || !deps.isOwner(chatId)) return false
      let r: { items: ActivityItem[]; degraded: string[] }
      try { r = deps.items(c.days) } catch { await deps.say(chatId, '现在读不到 CC 做过的事,过一会儿再试。'); return true }
      await deps.say(chatId, formatActivityForWechat(r, { now: deps.now(), days: c.days, timeZone: deps.timeZone() }))
      return true
    },
  }
}
