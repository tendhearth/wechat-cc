/** service.ts 对外的公共类型。放在 service/ 里是为了让域模块能引用而不 import ../service(那会成环)。 */
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import type { Task } from '../store'
import type { EntryReceipt } from '../task-entry'
import type { TaskWaitingFor } from '../wechat-types'
import type { ProviderRegistry } from '../../provider-registry'
import type { WorkbenchExecutorCapabilities } from '../executor-capabilities'

export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string }
/**
 * 主人眼里的进度,两家执行者一致。持久化的 status 记的是这条 run 的生命周期
 * (Claude 会话保留时它永远是 running,Codex 自行收尾后是 completed),而主人要问的
 * 是「本轮做完没有、还能不能接着说」—— 那是 replied,与进程留不留无关。
 */
export type WorkbenchPhase='queued'|'working'|'replied'|'failed'|'cancelled'|'interrupted'
export interface WorkbenchTaskView extends Task { phase:WorkbenchPhase; importedOnly?:boolean; canArchive:boolean; waitingFor: TaskWaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot }
export type EntryResult = {receipt: EntryReceipt; task: WorkbenchTaskView}

/** 已准入的执行者登记项:登记处的条目 + 一定带 workbench 能力(admission.provider 的返回;放这里是为了 ctx.ts 能引用而不 import admission 成环)。 */
type RegistryEntry = NonNullable<ReturnType<ProviderRegistry['get']>>
export type AdmittedProvider = RegistryEntry & {opts:RegistryEntry['opts']&{workbench:WorkbenchExecutorCapabilities}}
