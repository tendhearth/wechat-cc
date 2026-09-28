/**
 * 域模块看到的 service 上下文(spec 2026-09-27-workbench-service-split §2)。
 * 显式、只读、不含 service 对象本身:域需要「别的域 / service 的动作」一律 ctx.actions.deref() 在**调用时**取
 * —— Ref 由 service.ts 在 public 对象建好后 set 一次;工厂体里不许 deref(那时还没 set)。
 */
import type { Ref } from '../../../lib/lifecycle'
import type { ProviderRegistry } from '../../provider-registry'
import type { UsageSnapshot } from '../../subscription-usage'
import type { WorkbenchStore } from '../store'
import type { LiveInput } from '../live-inputs'
import type { Active, WorkbenchRuntimeState } from './state'
import type { InputMaterials, WorkbenchTaskView } from './types'

export interface ServiceHub {
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  touched(id:string,seq?:number):void
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。 */
  bumped(id:string):void
}
/** service.ts / 别的域提供、域模块在调用时才取的动作;后续 PR 往里加字段(execute/pump/cancelRun/…)。 */
export interface ServiceActions {
  submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
  continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials,attachmentPolicy?:'owner'):WorkbenchTaskView
  isReplied(running:Active):boolean
}
/** service 的外部依赖里域会用到的那几样(opts 的子集,只读);按需加,不整个 opts 透传。 */
export interface ServiceDeps {
  /** 主人身份的唯一来源(材料作用域、微信投递、entry 校验都看它)。 */
  ownerChatId: () => string | null
  /** 执行者登记处:quota 的候选、admission 的准入、notices 的显示名都从这里查。 */
  registry: ProviderRegistry
  /** 订阅执行者的真实额度快照(subscription-usage.ts 的监视器缓存);可选,不传就只靠失败信息判耗尽。 */
  usage?: (providerId: string) => UsageSnapshot | null
}
export interface ServiceCtx {
  store: WorkbenchStore
  stateDir: string
  state: WorkbenchRuntimeState
  hub: ServiceHub
  deps: ServiceDeps
  /** 停机闸:stopping 后所有会开新工作的入口先过这一道(`workbench_stopping`)。只在 service.ts 定义一次。 */
  ensureAccepting: () => void
  log?: (tag:string,line:string)=>void
  now: () => number
  actions: Ref<ServiceActions>
}
