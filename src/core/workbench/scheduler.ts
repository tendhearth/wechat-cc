import { isAbsolute, relative, sep } from 'node:path'

/** 三种都由路径关系判定(见 findPathBlocker)。占用从派发到会话关闭为止,所以「挡路的那条
 *  会话已经答复」不是另一种原因 —— 它仍然占着文件夹
 *  (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md)。 */
export type WaitingReason = 'same_path' | 'nested_path' | 'writer_not_closed'
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
