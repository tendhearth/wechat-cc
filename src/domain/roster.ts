/**
 * roster.ts —— 「在做」名单(设计稿 docs/superpowers/specs/2026-11-17-butler-layout-design.md §4.1)。
 *
 * 一行是「一件事」或「一个没挂进事的终端会话」;三端(桌面右栏 / 手机名单条)只用这一份分组与排序。
 * 纯函数:不读时钟、不碰 IO,数据由 features/roster/reader.ts 取好了交进来。
 *
 * 进不进:
 *   - task / terminal 事 ⇒ matter 行;terminal 事的状态按它那条会话算(matter 自己的 state 对终端说不清)。
 *   - 没有 matter_id 的终端会话 ⇒ terminal 行;ended 的不列。
 *   - act(CC 自己做的事)、chat(主人对话本身)、归档的事都不进 —— 主人 10-31 定「CC 自己做的事不混排」。
 * 分组按协议包 STATUS_TABLE;带回来的只收 24 小时内。
 * 排序:等你按等待开始升序(等得久的在前)→ 在做按更新降序 → 带回来的没看过在前、再按更新降序。
 */
import { QUIET_AFTER_MS, STATUS_TABLE, isMatterArchived, statusOfMatter, terminalStatusKey, type MatterStateT, type RosterItemT, type StatusKey } from '@wechat-cc/protocol'

export const ROSTER_BACK_WINDOW_MS = 24 * 3_600_000

export interface RosterPending { kind: 'permission' | 'question'; id: string; summary: string; since: number }
export interface RosterTerminal {
  session_id: string; code: string; source: string; displayName?: string
  status: 'running' | 'waiting' | 'idle' | 'ended'
  project: string; last_summary: string | null; last_event_at: number
  matter_id?: string; live_window?: boolean
  pending: { since: number; actionable?: boolean } | null
}
export interface RosterInput {
  matters: Array<{ id: string; kind: string; title: string; state?: MatterStateT; archivedAt?: number | null; updatedAt: number; agents?: string[]; agentNames?: Record<string, string>; project?: string | null }>
  /** 工作台里还登记着的任务(id ⇒ 状态 / 阶段)。 */
  tasks: Map<string, { status: string; phase?: string }>
  /** 一件事上还没拍板的权限卡 / 提问。 */
  pending: Map<string, RosterPending[]>
  /** 计划了多棒的事:第几棒、共几棒、当前那一棒是谁。 */
  relays: Map<string, { index: number; total: number; currentAgent: string }>
  /** 终端登记处(已折算 stale)。 */
  terminals: RosterTerminal[]
  /** 这件事 sinceMs 之后在哪一端被看过;没看过 ⇒ null。 */
  seen: (matterId: string, sinceMs: number) => string | null
  now: number
}

type Row = RosterItemT & { waitingSince: number }

const groupOf = (s: StatusKey) => STATUS_TABLE[s].group as RosterItemT['group']

function terminalPart(t: RosterTerminal): NonNullable<RosterItemT['terminal']> {
  return {
    sessionId: t.session_id, code: t.code, summary: t.last_summary,
    ...(t.live_window ? { liveWindow: true } : {}),
    ...(t.pending?.actionable !== undefined ? { actionable: t.pending.actionable } : {}),
  }
}

function matterRow(m: RosterInput['matters'][number], input: RosterInput, session: RosterTerminal | undefined): Row {
  const pend = [...(input.pending.get(m.id) ?? [])].sort((a, b) => a.since - b.since)
  const status: StatusKey = session && pend.length === 0
    ? terminalStatusKey(session.status)
    : statusOfMatter({ state: m.state, archivedAt: m.archivedAt ?? null, kind: m.kind }, input.tasks.get(m.id) ?? null, pend.length)
  const group = groupOf(status)
  const relay = input.relays.get(m.id)
  const ids = session ? [session.source] : m.agents ?? []
  const name = (id: string) => (session && id === session.source ? session.displayName : m.agentNames?.[id])
  const updatedAt = session ? Math.max(m.updatedAt, session.last_event_at) : m.updatedAt
  const first = pend[0]
  const waitingSince = first?.since ?? (session?.status === 'waiting' ? session.pending?.since ?? updatedAt : updatedAt)
  return {
    key: `matter:${m.id}`, kind: 'matter', id: m.id, title: m.title,
    ...(m.project ? { project: m.project } : session ? { project: session.project } : {}),
    group, status,
    agents: ids.map(id => ({ id, ...(name(id) ? { name: name(id)! } : {}), current: relay ? id === relay.currentAgent : true })),
    ...(relay ? { relay: { index: relay.index, total: relay.total } } : {}),
    ...(first ? { waiting: { kind: first.kind, requestId: first.id, summary: first.summary, count: pend.length } } : {}),
    quiet: status === 'working' && input.now - updatedAt > QUIET_AFTER_MS,
    updatedAt,
    unseen: group === 'back' && input.seen(m.id, updatedAt) === null,
    ...(session ? { terminal: terminalPart(session) } : {}),
    waitingSince,
  }
}

function terminalRow(t: RosterTerminal, now: number): Row {
  const status = terminalStatusKey(t.status)
  return {
    key: `terminal:${t.session_id}`, kind: 'terminal', id: t.session_id, title: t.project, project: t.project,
    group: groupOf(status), status,
    agents: [{ id: t.source, ...(t.displayName ? { name: t.displayName } : {}), current: true }],
    quiet: status === 'working' && now - t.last_event_at > QUIET_AFTER_MS,
    updatedAt: t.last_event_at,
    unseen: false,
    terminal: terminalPart(t),
    waitingSince: t.pending?.since ?? t.last_event_at,
  }
}

export function buildRoster(input: RosterInput): RosterItemT[] {
  const live = input.terminals.filter(t => t.status !== 'ended')
  const byMatter = new Map(live.filter(t => t.matter_id).map(t => [t.matter_id!, t]))
  const listed = new Set<string>()
  const rows: Row[] = []
  for (const m of input.matters) {
    if (m.kind !== 'task' && m.kind !== 'terminal') continue
    if (isMatterArchived({ archivedAt: m.archivedAt ?? null })) continue
    const session = m.kind === 'terminal' ? byMatter.get(m.id) : undefined
    // 终端事的会话已经结束了(或登记处里没有)⇒ 这件事也就结束了,不列
    if (m.kind === 'terminal' && !session) continue
    rows.push(matterRow(m, input, session))
    listed.add(m.id)
  }
  for (const t of live) {
    if (t.matter_id && listed.has(t.matter_id)) continue
    if (t.matter_id && input.matters.some(m => m.id === t.matter_id)) continue   // 那件事被筛掉了(归档 / 看不见)⇒ 会话也不单列
    rows.push(terminalRow(t, input.now))
  }
  const kept = rows.filter(r => r.group !== 'back' || r.updatedAt >= input.now - ROSTER_BACK_WINDOW_MS)
  const order = { waiting: 0, working: 1, back: 2 } as const
  kept.sort((a, b) => order[a.group] - order[b.group]
    || (a.group === 'waiting' ? a.waitingSince - b.waitingSince : 0)
    || (a.group === 'back' ? Number(b.unseen) - Number(a.unseen) : 0)
    || b.updatedAt - a.updatedAt
    || a.key.localeCompare(b.key))
  return kept.map(({ waitingSince: _drop, ...item }) => item)
}
