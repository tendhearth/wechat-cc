import { STATUS_TABLE, type HomeGroupKey } from '@wechat-cc/protocol'
import type { AgentsTopicT, ApprovalItemT, CliSessionRowT, MatterT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { matterOrigin, type MatterOrigin } from './origin'
import { statusOfMatter, terminalStatusKey, type StatusKey } from './status'
import { terminalNeedsYou, terminalRow } from './terminal'

/**
 * 主页的一份看法(设计稿 2026-10-31 §4 U):此刻与一起做合成一个主页,一件事 / 终端会话都是同一种行。
 * 分组固定 等你 → 在做 → 带回来的;带回来的只收 24 小时内的,更早的去「全部」。
 * known=false(够不着电脑)⇒ 不出等你组、页面说「暂时不知道」,不显示旧的等你行。
 */
export type HomeInput = {
  matters: MatterT[]
  approvals: ApprovalItemT[]
  agents: AgentsTopicT
  terminal: CliSessionRowT[]
  known: boolean
  now: number
  lang: Lang
  /** 上次把 App 放到后台的时间;离开 ≥ 1 小时 ⇒ 带回来的那组改叫「你不在的这 N 小时」。 */
  away?: number | null
  /** 带回来的只收多久以内;null ⇒ 不限(「全部」页)。默认 24 小时。 */
  backWindowMs?: number | null
}

export type HomeRow = {
  id: string
  source: 'matter' | 'terminal'
  href: string
  title: string
  /** 第二行小字:等你时是这件事的标题,做完类是状态词;终端是 项目 · 状态 · 多久前。没有 ⇒ null。 */
  caption: string | null
  /** 第三行:终端此刻那一步 / 最近一句;没有 ⇒ null。 */
  detail: string | null
  /** 单独一行的提醒(终端自己在问 ⇒「回电脑上答」)。 */
  note: string | null
  status: StatusKey
  /** 等你的第一条请求(标题按它请求说明);不等你 ⇒ null。 */
  pendingRequestId: string | null
  agents: string[]
  agentNames?: Record<string, string>
  origin: MatterOrigin | null
  updatedAt: number
}

export type HomeView = {
  waitingUnknown: boolean
  groups: Array<{ key: HomeGroupKey; title: string; rows: HomeRow[] }>
  /** 等你、而且手机上拍得了的件数(终端自己在问的不算)。 */
  waitingCount: number
  /** 24 小时以前带回来的,只在「全部」里。 */
  moreCount: number
}

export const BACK_WINDOW_MS = 24 * 3_600_000
const AWAY_MIN_MS = 3_600_000
const GROUP_ORDER: HomeGroupKey[] = ['waiting', 'working', 'back']

function matterRows(input: HomeInput): HomeRow[] {
  const { matters, approvals, agents, lang } = input
  const first = new Map<string, ApprovalItemT>()
  for (const a of approvals) if (!first.has(a.taskId)) first.set(a.taskId, a)
  const pendingN = (id: string) => approvals.filter(a => a.taskId === id).length
  return matters
    .filter(m => m.status !== 'archived' && m.kind !== 'chat')
    .map(m => {
      const task = agents.tasks.find(x => x.id === m.id)
      const status = statusOfMatter(m, task ? { status: 'running', phase: task.phase } : null, pendingN(m.id))
      const p = status === 'waiting' ? first.get(m.id) ?? null : null
      const caption = p ? m.title : STATUS_TABLE[status].group === 'back' ? t(lang, STATUS_TABLE[status].word) : null
      return {
        id: m.id,
        source: 'matter' as const,
        href: `/matter/${encodeURIComponent(m.id)}${p ? `/decide?request=${encodeURIComponent(p.id)}` : ''}`,
        title: p ? p.summary : m.title,
        caption,
        detail: null,
        note: null,
        status,
        pendingRequestId: p ? p.id : null,
        agents: m.agents ?? [],
        ...(m.agentNames ? { agentNames: m.agentNames } : {}),
        origin: matterOrigin(m.origin),
        updatedAt: m.updatedAt,
      }
    })
}

function terminalHomeRows(input: HomeInput): HomeRow[] {
  const { lang, now } = input
  return input.terminal
    .filter(s => s.status !== 'ended')
    .map(s => {
      const r = terminalRow(s, now, lang)
      const status = terminalStatusKey(s.status)
      const local = s.status === 'waiting' && !r.actionable ? t(lang, 'terminal.askedLocally') : null
      const word = r.stale ? t(lang, 'terminal.stale.hint') : STATUS_TABLE[status].group === 'back' ? t(lang, STATUS_TABLE[status].word) : null
      return {
        id: r.id,
        source: 'terminal' as const,
        href: `/terminal/${encodeURIComponent(r.id)}`,
        title: r.pendingText || r.project,
        caption: [r.pendingText ? r.project : null, word, r.ago].filter(Boolean).join(' · ') || null,
        detail: !r.pendingText && !r.stale ? r.nowText || r.summary : null,
        note: local,
        status,
        pendingRequestId: null,
        agents: [r.agent],
        origin: null,
        updatedAt: s.last_event_at,
      }
    })
}

export function homeView(input: HomeInput): HomeView {
  const { now, lang } = input
  const byRecent = (a: HomeRow, b: HomeRow) => b.updatedAt - a.updatedAt
  // 等你组里一件事在前、终端在后(和原来的此刻一致);各自按最近动静
  // 够不着电脑:等你的那几件读到的是旧的 ⇒ 整行不出(不把它误标成「在做」),页面说「暂时不知道」
  const all = [...matterRows(input).sort(byRecent), ...terminalHomeRows(input).sort(byRecent)].filter(r => input.known || r.status !== 'waiting')
  let moreCount = 0
  const groups = GROUP_ORDER.map(key => {
    let rows = all.filter(r => STATUS_TABLE[r.status].group === key)
    if (key !== 'waiting') rows = rows.sort(byRecent)
    if (key === 'back') {
      const windowMs = input.backWindowMs === undefined ? BACK_WINDOW_MS : input.backWindowMs
      const recent = windowMs === null ? rows : rows.filter(r => r.updatedAt >= now - windowMs)
      moreCount = rows.length - recent.length
      rows = recent
    }
    const away = input.away
    const whileAway = key === 'back' && away != null && now - away >= AWAY_MIN_MS && rows.some(r => r.updatedAt > away)
    const title = whileAway ? t(lang, 'today.whileAway', { n: Math.round((now - away!) / 3_600_000) }) : t(lang, `home.group.${key}`)
    return { key, title, rows }
  }).filter(g => g.rows.length > 0)
  const waitingCount = input.known
    ? new Set(input.approvals.map(a => a.taskId)).size + terminalNeedsYou(input.terminal, true).length
    : 0
  return { waitingUnknown: !input.known, groups, waitingCount, moreCount }
}
