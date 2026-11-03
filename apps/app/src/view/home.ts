import { QUIET_AFTER_MS, ROW_HINT_WORDS, STATUS_TABLE, type HomeGroupKey } from '@wechat-cc/protocol'
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
  /** 够不着电脑时留着上次看到的等你那几件(「全部」页:找得到那件事);主页不留,只说「暂时不知道」。 */
  keepStaleWaiting?: boolean
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
  /** 等你、而且手机上拍得了的那几条(`matter:<id>:<请求>` / `terminal:<会话>:<码>`),给 CC 的「等」动作;终端自己在问的不算。够不着电脑 ⇒ 空。 */
  actionableWaiting: string[]
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
  // 三端同一句(协议包的状态表):一件事同时等你好几项 ⇒「共 N 项」;在做却 30 分钟没动静 ⇒「可能卡住」(和微信日报同一条线)
  const hints = ROW_HINT_WORDS[lang]
  const total = (id: string) => { const n = pendingN(id); return n > 1 ? hints.pendingTotal.replace('{n}', String(n)) : null }
  // 批准到了、列表还没跟上(新事 / 超出列表上限 / 还没拉到)⇒ 照样一行等你:标题用请求概括,去处是那一步
  const listed = new Set(matters.map(m => m.id))
  const orphans: HomeRow[] = [...first.values()].filter(a => !listed.has(a.taskId)).map(a => ({
    id: a.taskId,
    source: 'matter' as const,
    href: `/matter/${encodeURIComponent(a.taskId)}/decide?request=${encodeURIComponent(a.id)}`,
    title: a.summary,
    caption: total(a.taskId),
    detail: null,
    note: null,
    status: 'waiting' as const,
    pendingRequestId: a.id,
    agents: [],
    origin: null,
    updatedAt: input.now,
  }))
  return [...orphans, ...matters
    .filter(m => m.status !== 'archived' && m.kind !== 'chat')
    .map(m => {
      const task = agents.tasks.find(x => x.id === m.id)
      const status = statusOfMatter(m, task ? { status: 'running', phase: task.phase } : null, pendingN(m.id))
      const p = status === 'waiting' ? first.get(m.id) ?? null : null
      const quiet = status === 'working' && input.now - m.updatedAt > QUIET_AFTER_MS
      const caption = p ? [m.title, total(m.id)].filter(Boolean).join(' · ') : STATUS_TABLE[status].group === 'back' ? t(lang, STATUS_TABLE[status].word) : quiet ? hints.quiet : null
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
    })]
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
  const all = [...matterRows(input).sort(byRecent), ...terminalHomeRows(input).sort(byRecent)].filter(r => input.known || input.keepStaleWaiting || r.status !== 'waiting')
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
  const actionableWaiting = input.known
    ? [
        ...all.filter(r => r.source === 'matter' && r.status === 'waiting' && r.pendingRequestId).map(r => `matter:${r.id}:${r.pendingRequestId}`),
        ...terminalNeedsYou(input.terminal, true).map(s => `terminal:${s.session_id}:${s.pending?.hash ?? ''}`),
      ]
    : []
  return { waitingUnknown: !input.known, groups, actionableWaiting, moreCount }
}
