import type { ConnectionsT } from '../backend/types'
import { t, type Lang } from '../i18n'

export type Dot = 'ok' | 'warn' | 'bad' | 'unknown'
type State = ConnectionsT['sources'][number]['state']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** zh「9月8日」/ en「Sep 8」,本地时区。 */
export const shortDate = (ms: number, lang: Lang): string => {
  const d = new Date(ms)
  return lang === 'zh-Hans' ? `${d.getMonth() + 1}月${d.getDate()}日` : `${MONTHS[d.getMonth()]!} ${d.getDate()}`
}

const DOT: Record<State, Dot> = { ready: 'ok', behind: 'warn', not_loaded: 'bad', unknown: 'unknown' }
// 最坏的在前:headline 取最坏;没有任何来源 ⇒ unknown(绝不默认绿)
const SEVERITY: Dot[] = ['bad', 'warn', 'unknown', 'ok']
const HEADLINE = { ok: 'links.headlineOk', warn: 'links.headlineWarn', bad: 'links.headlineBad', unknown: 'links.headlineUnknown' } as const
type HeadlineKey = (typeof HEADLINE)[Dot] | 'links.headlineOffline'

export function connectionsView(s: ConnectionsT, _now: number, lang: Lang): {
  headline: { dot: Dot; key: HeadlineKey; n: number }
  sources: Array<{ id: string; name: string; dot: Dot; label: string }>
  computers: Array<{ id: string; label: string; dot: Dot; detail: string }>
  recent: Array<{ matterId: string; title: string; when: string }>
  outputs: Array<{ matterId: string; name: string; when: string }>
} {
  const sources = s.sources.map(x => {
    const date = x.latestAt === null ? null : shortDate(x.latestAt, lang)
    const label = x.state === 'ready' ? (date ? t(lang, 'links.latestOn', { date }) : t(lang, 'links.ready'))
      : x.state === 'behind' ? (date ? t(lang, 'links.behindSince', { date }) : t(lang, 'links.behind'))
      : x.state === 'not_loaded' ? t(lang, 'links.notLoaded') : t(lang, 'links.unknown')
    const name = x.kind === 'wechat_history' ? t(lang, 'links.src.wechat') : x.kind === 'knowledge' ? t(lang, 'links.src.knowledge') : x.name
    return { id: x.id, name, dot: DOT[x.state], label }
  })
  // 电脑不在线也并进最坏的严重度(红):不能一边电脑掉线一边说「都连上了」。来源本身有红 ⇒ 按来源说;否则说几台不在线。
  const offline = s.computers.filter(c => !c.online).length
  const worst = SEVERITY.find(d => sources.some(x => x.dot === d) || (d === 'bad' && offline > 0)) ?? 'unknown'
  const badSources = sources.filter(x => x.dot === 'bad').length
  const headline: { dot: Dot; key: HeadlineKey; n: number } = worst === 'bad' && badSources === 0
    ? { dot: 'bad', key: 'links.headlineOffline', n: offline }
    : { dot: worst, key: HEADLINE[worst], n: sources.filter(x => x.dot === worst).length }
  const computers = s.computers.map(c => ({
    id: c.id, label: c.label, dot: (c.online ? 'ok' : 'bad') as Dot,
    detail: !c.online ? t(lang, 'links.computerOffline') : c.since === null ? t(lang, 'links.computerOnlineNow') : t(lang, 'links.computerOnline', { date: shortDate(c.since, lang) }),
  }))
  return {
    headline, sources, computers,
    recent: s.recent.map(r => ({ matterId: r.matterId, title: r.title, when: shortDate(r.at, lang) })),
    outputs: s.outputs.map(o => ({ matterId: o.matterId, name: o.name, when: shortDate(o.at, lang) })),
  }
}
