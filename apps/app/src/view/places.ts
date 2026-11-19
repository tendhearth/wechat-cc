/**
 * places.ts —— 「地方」那几行在手机上怎么说、点了去哪、怎么筛说话(设计稿 2026-11-18-cc-two-sides-design.md §3–4;
 * 桌面同一套说法在 apps/desktop/src/modules/places-strip.js)。不用状态词:圆点 = 在等你,加粗 = 没看过,「现在」= 在干。
 */
import type { PlaceT } from '@wechat-cc/protocol'
import type { Lang } from '../i18n'
import type { ConversationItem } from './conversation-work'

const MIN = 60_000

export function placeTime(place: PlaceT, now: number, lang: Lang): string {
  const zh = lang === 'zh-Hans'
  if (place.moving) return zh ? '现在' : 'now'
  const at = place.updatedAt
  if (at == null) return ''
  const d = now - at
  if (d < MIN) return zh ? '刚刚' : 'just now'
  if (d < 60 * MIN) return zh ? `${Math.floor(d / MIN)} 分钟前` : `${Math.floor(d / MIN)} min ago`
  const a = new Date(at), n = new Date(now)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(n) - day(a)) / 86_400_000)
  if (days === 0) return `${String(a.getHours()).padStart(2, '0')}:${String(a.getMinutes()).padStart(2, '0')}`
  if (days === 1) return zh ? '昨天' : 'yesterday'
  if (days < 7) return zh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][a.getDay()]! : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][a.getDay()]!
  return zh ? `${a.getMonth() + 1} 月 ${a.getDate()} 日` : `${a.getMonth() + 1}/${a.getDate()}`
}

export function placeLine(place: PlaceT, lang: Lang): string {
  const line = place.line?.trim() ?? ''
  if (!line || place.waiting) return line
  const zh = lang === 'zh-Hans'
  if (place.status === 'working') return line.endsWith('…') ? line : `${line}…`
  if (place.status === 'failed') return zh ? `${line}(没做成)` : `${line} (didn't work out)`
  if (place.status === 'stopped') return zh ? `${line}(停了)` : `${line} (stopped)`
  return line
}

/** 「›」打开哪一件:在等你的那件,否则最近的一件事,否则最近的终端会话;都没有 ⇒ null。 */
export function placeHref(place: PlaceT): string | null {
  const w = place.waiting
  if (w?.matterId) return `/matter/${encodeURIComponent(w.matterId)}`
  if (w?.sessionId) return `/terminal/${encodeURIComponent(w.sessionId)}`
  if (place.matterIds[0]) return `/matter/${encodeURIComponent(place.matterIds[0])}`
  if (place.sessionIds[0]) return `/terminal/${encodeURIComponent(place.sessionIds[0])}`
  return null
}

/** 说话只看这个地方的:那几件事的引用、分出它们的那几句、它们的回复、挂着的终端;在路上的(还没发出去)照留。 */
export function inPlace(item: ConversationItem, place: PlaceT | null): boolean {
  if (!place) return true
  if (item.gap) return true
  const matters = new Set(place.matterIds), messages = new Set(place.messageIds), sessions = new Set(place.sessionIds)
  const row = item.row
  if (row) {
    if (row.source === 'terminal') return sessions.has(row.id)
    return matters.has(row.matterId ?? row.id)
  }
  const b = item.bubble
  if (!b) return false
  if (b.state === 'thinking') return true
  return messages.has(b.key) || (!!b.matterId && matters.has(b.matterId))
}
