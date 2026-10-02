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
type HeadlineKey = (typeof HEADLINE)[Dot] | 'links.headlineOffline' | 'links.headlineStarting'

/**
 * opts.stale:这份快照只是「上次所知」(见 connectionsTrust)⇒ 电脑那行不说「在线」。
 * 「电脑还在启动」只在 daemon 自己说 starting 时用;别的不知道用中性措辞。
 * 来源行的日期是最新一条消息的时间(不是同步时间),文案照此标。
 */
export function connectionsView(s: ConnectionsT, _now: number, lang: Lang, opts: { stale?: boolean; demo?: boolean } = {}): {
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
    : { dot: worst, key: worst === 'unknown' && s.starting === true ? 'links.headlineStarting' : HEADLINE[worst], n: sources.filter(x => x.dot === worst).length }
  // 演示:根本没有电脑 ⇒ 不说「在线」,写明是演示(与顶栏「演示 · 没有连电脑」一致);圆点由 connectionsPage 压灰
  const computers = opts.demo ? s.computers.map(c => ({ id: c.id, label: t(lang, 'links.demoComputer'), dot: 'unknown' as Dot, detail: t(lang, 'links.demoComputerDetail') })) : s.computers.map(c => ({
    id: c.id, label: c.label, dot: (c.online ? 'ok' : 'bad') as Dot,
    detail: !c.online ? t(lang, 'links.computerOffline') : opts.stale ? t(lang, 'links.computerLastKnownOnline') : c.since === null ? t(lang, 'links.computerOnlineNow') : t(lang, 'links.computerOnline', { date: shortDate(c.since, lang) }),
  }))
  return {
    headline, sources, computers,
    recent: s.recent.map(r => ({ matterId: r.matterId, title: r.title, when: shortDate(r.at, lang) })),
    outputs: s.outputs.map(o => ({ matterId: o.matterId, name: o.name, when: shortDate(o.at, lang) })),
  }
}

/**
 * 这份连接快照还能不能当「现在」看:没有数据 ⇒ none;有数据但最近一次拉取失败、或手机和电脑断着 ⇒ stale(只当「上次所知」,
 * 不显示任何绿点);否则 live。绝不拿缓存的 ready 冒充现状。
 */
export function connectionsTrust(q: { data?: unknown; error?: string }, connState: string): 'none' | 'stale' | 'live' {
  if (q.data === undefined) return 'none'
  return q.error !== undefined || connState !== 'online' ? 'stale' : 'live'
}

/** stale 时把所有圆点压成 unknown(灰),文字照旧当作「上次所知」。 */
export function muteDots<V extends { headline: { dot: Dot }; sources: Array<{ dot: Dot }>; computers: Array<{ dot: Dot }> }>(v: V): V {
  return {
    ...v,
    headline: { ...v.headline, dot: 'unknown' as Dot },
    sources: v.sources.map(x => ({ ...x, dot: 'unknown' as Dot })),
    computers: v.computers.map(x => ({ ...x, dot: 'unknown' as Dot })),
  }
}

/**
 * 连接页要显示的全部:信任度、视图(stale 或演示 ⇒ 所有圆点灰)、顶上一行(与桌面连接卡同一套 headline key,终审 M8)。
 * 演示永远不画绿:演示后端说自己在线,但没有电脑(终审 I1)。
 */
export function connectionsPage(q: { data?: ConnectionsT; error?: string }, connState: string, now: number, lang: Lang, opts: { demo?: boolean } = {}) {
  const trust = connectionsTrust(q, connState)
  if (!q.data) return { trust, view: null, headline: null }
  const base = connectionsView(q.data, now, lang, { stale: trust === 'stale', demo: opts.demo })
  const view = trust === 'stale' || opts.demo ? muteDots(base) : base
  return { trust, view, headline: { dot: view.headline.dot, text: t(lang, view.headline.key, { n: view.headline.n }) } }
}
