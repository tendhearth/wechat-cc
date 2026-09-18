import type {AgentExecutionChoice} from '../agent-provider'

/** Code-level adapter promise, not automatic detection or filesystem isolation. */
export interface WorkbenchExecutorCapabilities {
  version: 1
  permissions: 'task' | 'unattended'
  configuration: 'task-policy'
  completion: 'native'
  stop: 'confirmed'
  background: 'tracked' | 'disabled'
  features: {
    nativeResume: boolean
    managedResume?: boolean
    attachments: boolean
    executionSettings: boolean
    modelCatalog: boolean
  }
}

/** Only the specialized, separately validated workbench native adapters opt in. */
export const MANAGED_NATIVE_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'task',configuration:'task-policy',completion:'native',stop:'confirmed',background:'tracked',
  features:Object.freeze({nativeResume:true,attachments:true,executionSettings:true,modelCatalog:true}),
})

export const MANAGED_API_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'task',configuration:'task-policy',completion:'native',stop:'confirmed',background:'disabled',
  features:Object.freeze({nativeResume:false,managedResume:true,attachments:true,executionSettings:false,modelCatalog:false}),
})

/** 免审:执行者自己的旁路开关启动(agy --dangerously-skip-permissions / cursor --yolo),daemon 拦不到单步;附件与执行设置它们的 dispatch 不收。 */
export const UNATTENDED_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'unattended',configuration:'task-policy',completion:'native',stop:'confirmed',background:'disabled',
  features:Object.freeze({nativeResume:true,attachments:false,executionSettings:false,modelCatalog:false}),
})

/** 走 ACP 的执行者(cursor-agent acp):命令逐次进权限卡,但工作区内的文件编辑由 CLI 直接执行(spike 2026-09-17);
 *  按 session/load 恢复;不收附件、不认执行设置、无模型目录。 */
export const ACP_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'task',configuration:'task-policy',completion:'native',stop:'confirmed',background:'disabled',
  features:Object.freeze({nativeResume:true,attachments:false,executionSettings:false,modelCatalog:false}),
})

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/** A transport token; actual availability always comes from the registry contract. */
export const isWorkbenchProviderId=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9._-]{0,63}$/.test(value)
export function isWorkbenchExecutorCapabilities(value:unknown):value is WorkbenchExecutorCapabilities {
  if(!object(value)||value.version!==1||(value.permissions!=='task'&&value.permissions!=='unattended')||value.configuration!=='task-policy'||value.completion!=='native'||value.stop!=='confirmed'||
    (value.background!=='tracked'&&value.background!=='disabled')||!object(value.features))return false
  const features=value.features
  return ['nativeResume','attachments','executionSettings','modelCatalog'].every(key=>typeof features[key]==='boolean')&&
    (features.managedResume===undefined||typeof features.managedResume==='boolean')
}

export const isUnattendedExecutor=(capabilities:WorkbenchExecutorCapabilities):boolean=>capabilities.permissions==='unattended'

export const canResumeWorkbenchExecutor=(capabilities:WorkbenchExecutorCapabilities):boolean=>capabilities.features.nativeResume||capabilities.features.managedResume===true

export function requireWorkbenchInput(capabilities:WorkbenchExecutorCapabilities,input:{attachments:readonly unknown[];execution:AgentExecutionChoice;resume?:boolean}):void {
  if(!isWorkbenchExecutorCapabilities(capabilities))throw Error('unavailable_provider')
  if(input.attachments.length&&!capabilities.features.attachments)throw Error('workbench_attachments_unsupported')
  if((input.execution.defaults==='native'||input.execution.model!==null||input.execution.reasoningEffort!==null)&&!capabilities.features.executionSettings)throw Error('workbench_execution_unsupported')
  if(input.resume&&!canResumeWorkbenchExecutor(capabilities))throw Error('workbench_resume_unsupported')
}
