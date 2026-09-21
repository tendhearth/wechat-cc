import { isAbsolute, relative, sep } from 'node:path'

/** 前三种由路径关系判定(见 findPathBlocker);'retained_turn' 由 service 判定:挡路的是一条
 *  保留会话、而且已经开了新回合 —— 主人续接了它,队伍没卡住(spec §D)。 */
export type WaitingReason = 'same_path' | 'nested_path' | 'writer_not_closed' | 'retained_turn'
export interface WaitingFor { taskId: string; title: string; reason: WaitingReason }
export interface PathReservation {
  identity: string
  taskId: string
  title: string
  path: string
  order: number
  state: 'queued' | 'active' | 'uncertain'
}

function within(parent: string, child: string): boolean {
  const rel=relative(parent,child)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Paths arrive canonicalized; compare components rather than string prefixes. */
export function pathsConflict(a: string, b: string): boolean {
  return within(a,b) || within(b,a)
}

export function findPathBlocker(candidate: PathReservation, possible: PathReservation[]): WaitingFor | null {
  const conflicts=possible.filter(item => item.identity !== candidate.identity && pathsConflict(candidate.path,item.path))
  const blocker=conflicts.find(item => item.state === 'uncertain') ?? conflicts.sort((a,b) => a.order-b.order)[0]
  if (!blocker) return null
  return {
    taskId:blocker.taskId,
    title:blocker.title,
    reason:blocker.state === 'uncertain' ? 'writer_not_closed' : blocker.path === candidate.path ? 'same_path' : 'nested_path',
  }
}
