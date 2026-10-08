/** service.ts 对外的公共类型。放在 service/ 里是为了让域模块能引用而不 import ../service(那会成环)。 */
import type { QuotaKind } from '../../provider-quota'
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import type { Task } from '../store'
import type { EntryReceipt } from '../task-entry'
import type { TaskWaitingFor } from '../wechat-types'
import type { ProviderRegistry } from '../../provider-registry'
import type { WorkbenchExecutorCapabilities } from '../executor-capabilities'

export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string; requestId?:string; executionMode?:import('../task-entry').ExecutionMode; /** false ⇒ 不登记成项目(独立工作区的目录)。 */ registerProject?: boolean }
/**
 * 主人眼里的进度,两家执行者一致。持久化的 status 记的是这条 run 的生命周期
 * (Claude 会话保留时它永远是 running,Codex 自行收尾后是 completed),而主人要问的
 * 是「本轮做完没有、还能不能接着说」—— 那是 replied,与进程留不留无关。
 */
export type WorkbenchPhase='queued'|'working'|'replied'|'failed'|'cancelled'|'interrupted'
export interface WorkbenchTaskView extends Task { phase:WorkbenchPhase; importedOnly?:boolean; canArchive:boolean; writerExit?:'alive'|'unconfirmed'; worktree?:{branch:string;projectPath:string;removed:boolean}; waitingFor: TaskWaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot; networkSuspended?:{since:number} }
export type EntryResult = {receipt: EntryReceipt; task: WorkbenchTaskView}

/** 已准入的执行者登记项:登记处的条目 + 一定带 workbench 能力(admission.provider 的返回;放这里是为了 ctx.ts 能引用而不 import admission 成环)。 */
type RegistryEntry = NonNullable<ReturnType<ProviderRegistry['get']>>
export type AdmittedProvider = RegistryEntry & {opts:RegistryEntry['opts']&{workbench:WorkbenchExecutorCapabilities}}

/** 工作台详情里的额度交接:能交(offer)/ 没人能接(none)/ 已经交出去了(handed,matterId = 新的那件事)。 */
export type QuotaHandoffView =
  | { state: 'offer'; from: string; to: string; kind: QuotaKind; resetAt: number }
  | { state: 'none'; from: string; kind: QuotaKind; resetAt: number }
  | { state: 'handed'; from: string; to: string; matterId: string }

/** Recovery coordination contract: ctx depends on types, never on a domain factory. */
export interface RecoveryDomain {
  manager:ReturnType<typeof import('../restore-manager').createRestoreManager>
  owned(taskId:string):{task:import('../store').StoredTask;w:import('../git-workspace-store').GitWorkspaceRecord}
  git():ReturnType<typeof import('../git-workspaces').createGitWorkspaces>
  blockReason(workspaceId:string):string|undefined
  admit(path:string,gitWorkspaceId?:string|null):void
  captureWriters():void
  registeredConflict(path:string):boolean
  gate(path:string,own?:import('./state').Active):void
  begin(running:import('./state').Active):Promise<void>
  remember(running:import('./state').Active):void
  mark(running:import('./state').Active,status:'closing'|'uncertain'):void
  close(running:import('./state').Active,kind?:'session_close'|'spawn_rejected'|'groups_gone'|'administrator'):Promise<void>
  confirmOrphan(taskId:string,kind:'groups_gone'|'administrator'):Promise<void>
  adopt():void
  recover():Promise<void>
  facts(taskId:string):string
  withMutation<T>(workspaceId:string,operation:()=>Promise<T>):Promise<T>
  withCommit<T>(taskId:string,operation:()=>Promise<T>):Promise<T>
}
