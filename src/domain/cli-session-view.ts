/**
 * 终端会话的纯规则(架构终态 E5,从 adapters/store/cli-session-store.ts 搬来):读时把库里的状态按 stale 规则折算成
 * 对外的一条、排序。不碰库、不碰 node。
 */
import type { CliSessionRow, CliSessionStatus, CliSessionView } from '../ports/cli-session'

/** running / waiting 多久没事件就当 idle(读时判定,不跑定时器)。 */
export const CLI_SESSION_STALE_MS = 30 * 60_000

/** 读时折算:running / waiting 超过 STALE_MS 没事件 ⇒ idle。 */
export function effectiveStatus(row: Pick<CliSessionRow, 'status' | 'last_event_at'>, now: number): { status: CliSessionStatus; stale: boolean } {
  if ((row.status === 'running' || row.status === 'waiting') && now - row.last_event_at > CLI_SESSION_STALE_MS) return { status: 'idle', stale: true }
  return { status: row.status, stale: false }
}

export function toCliSessionView(row: CliSessionRow, now: number): CliSessionView {
  const { status, stale } = effectiveStatus(row, now)
  return {
    session_id: row.session_id,
    code: row.session_id.slice(0, 6),
    source: row.source,
    status,
    stale,
    project: basename(row.cwd),
    cwd: row.cwd,
    machine: row.machine,
    origin_agent: row.origin_agent,
    last_summary: row.last_summary,
    last_event_at: row.last_event_at,
    last_prompt_at: row.last_prompt_at,
    created_at: row.created_at,
    pending: status === 'waiting' && row.pending_tool ? { tool: row.pending_tool, summary: row.pending_summary, since: row.pending_at ?? row.last_event_at } : null,
  }
}

/** 等你批准的在最前,其余按最近事件倒序(不按状态再分组 —— 主人要的是「刚刚谁动了」)。 */
export function sortCliSessionViews(views: CliSessionView[]): CliSessionView[] {
  return [...views].sort((a, b) => {
    const wa = a.status === 'waiting' ? 0 : 1, wb = b.status === 'waiting' ? 0 : 1
    if (wa !== wb) return wa - wb
    return b.last_event_at - a.last_event_at
  })
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
