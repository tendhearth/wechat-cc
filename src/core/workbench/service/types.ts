/** service.ts 对外的公共类型。放在 service/ 里是为了让域模块能引用而不 import ../service(那会成环)。 */
import type { QuotaKind } from '../../../domain/provider-quota'
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import type { Task } from '../store'
import type { MatterOrigin } from '../../matters/store'
import type { EntryReceipt } from '../task-entry'
import type { TaskWaitingFor } from '../wechat-types'
import type { ProviderRegistry } from '../../provider-registry'
import type { WorkbenchExecutorCapabilities } from '../executor-capabilities'

export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string; /** false ⇒ 不登记成项目(独立工作区的目录)。 */ registerProject?: boolean; /** 这件事的出生地(matters.origin_surface,只写一次);调用方从鉴权来源填,不知道 ⇒ 省略。 */ origin?: MatterOrigin | null }
/**
 * 主人眼里的进度,两家执行者一致。持久化的 status 记的是这条 run 的生命周期
 * (Claude 会话保留时它永远是 running,Codex 自行收尾后是 completed),而主人要问的
 * 是「本轮做完没有、还能不能接着说」—— 那是 replied,与进程留不留无关。
 */
export type WorkbenchPhase='queued'|'working'|'replied'|'failed'|'cancelled'|'interrupted'
export interface WorkbenchTaskView extends Task { phase:WorkbenchPhase; importedOnly?:boolean; canArchive:boolean; writerExit?:'alive'|'unconfirmed'; worktree?:{branch:string;projectPath:string;removed:boolean;merged:boolean;port?:number;/** 工作区脚本(2026-10-20):只有详情带。 */scripts?:ScriptsView}; waitingFor: TaskWaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot; networkSuspended?:{since:number}; /** 参与过的执行者(2026-10-19,同 matter.agents):桌面行尾画成叠在一起的圆头像。只有列表 / 详情带。 */ agents?:string[]; /** 出生地(同 matter.origin,2026-10-19):行尾头像组旁边一个小字形。不知道 ⇒ 不带。 */ origin?:MatterOrigin; /** 每件事花了多少额度(v82):执行者报的合计;一轮都没报 ⇒ 不带;某项 null = 这家不报。 */ usage?:import('../../../domain/turn-usage').UsageTotals; /** 做到条件成立为止(v80):命令原文 + 进度;没设就不带。 */ until?:{command:string;maxRounds:number;rounds:number;status:'active'|'passed'|'exhausted'|'stopped';lastExit:number|null;stopReason:string|null} }
export type EntryResult = {receipt: EntryReceipt; task: WorkbenchTaskView}

/** 已准入的执行者登记项:登记处的条目 + 一定带 workbench 能力(admission.provider 的返回;放这里是为了 ctx.ts 能引用而不 import admission 成环)。 */
type RegistryEntry = NonNullable<ReturnType<ProviderRegistry['get']>>
export type AdmittedProvider = RegistryEntry & {opts:RegistryEntry['opts']&{workbench:WorkbenchExecutorCapabilities}}

/** 工作台详情里的额度交接:能交(offer)/ 没人能接(none)/ 已经交出去了(handed,matterId = 新的那件事)。 */
export type QuotaHandoffView =
  | { state: 'offer'; from: string; to: string; kind: QuotaKind; resetAt: number }
  | { state: 'none'; from: string; kind: QuotaKind; resetAt: number }
  | { state: 'handed'; from: string; to: string; matterId: string }
/** 工作区脚本(2026-10-20,service/scripts.ts)在详情里的样子;放这里免得 types ↔ scripts 绕圈。 */
export type ScriptsView =
  | { configured: false; invalid: string }
  | {
    configured: true
    approved: boolean
    hash: string
    /** 三条脚本原文:只进桌面详情(确认框要逐字给主人看)。 */
    config: import('../worktree-scripts').ScriptsConfig
    setup: 'none' | 'pending' | 'running' | 'done' | 'failed'
    run: 'none' | 'idle' | 'queued' | 'running'
    archiving: boolean
  }

