/** 部署 shutdown 留下的续接凭据。只记任务/运行身份；消费前先移除，至多尝试一次。 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { writeFileAtomic } from '../../lib/json-file'

export const RESTART_CONTINUATIONS_FILE = 'workbench-restart-continuations.json'
export interface RestartContinuation { taskId: string; runId: string; lastUserId: number | null; pendingDecision: boolean; directoryIdentity: string; unstarted: boolean }
export function saveRestartContinuations(stateDir: string, entries: RestartContinuation[]): void {
  const all=new Map(readRestartContinuations(stateDir).map(e=>[e.taskId,e]))
  for(const entry of entries)all.set(entry.taskId,entry)
  writeEntries(stateDir,[...all.values()])
}
function writeEntries(stateDir:string,entries:RestartContinuation[]) {
  writeFileAtomic(join(stateDir, RESTART_CONTINUATIONS_FILE), JSON.stringify(entries) + '\n', { mode: 0o600 })
}
export function readRestartContinuations(stateDir: string): RestartContinuation[] {
  const file = join(stateDir, RESTART_CONTINUATIONS_FILE)
  if (!existsSync(file)) return []
  const value = readJsonFile<unknown>(file)
  if (!Array.isArray(value)) return []
  return value.filter((e): e is RestartContinuation => !!e && typeof e === 'object' && typeof e.taskId === 'string' && typeof e.runId === 'string' && (e.lastUserId === null || Number.isSafeInteger(e.lastUserId)) && typeof e.pendingDecision === 'boolean' && typeof e.directoryIdentity==='string' && typeof e.unstarted==='boolean')
}
/** 发起续接前撤销凭据；写失败就不得派发。主人停止时可按任务撤销全部待接续。 */
export function dropRestartContinuation(stateDir:string,taskId:string,runId?:string):void {
  const file=join(stateDir,RESTART_CONTINUATIONS_FILE)
  if(!existsSync(file))return
  writeEntries(stateDir,readRestartContinuations(stateDir).filter(e=>e.taskId!==taskId||(runId!==undefined&&e.runId!==runId)))
}
