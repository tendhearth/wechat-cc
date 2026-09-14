import type {AgentExecutionChoice} from '../agent-provider'

/** Code-level adapter promise, not automatic detection or filesystem isolation. */
export interface WorkbenchExecutorCapabilities {
  version: 1
  permissions: 'task'
  configuration: 'task-policy'
  completion: 'native'
  stop: 'confirmed'
  background: 'tracked' | 'disabled'
  features: {
    nativeResume: boolean
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

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/** A transport token; actual availability always comes from the registry contract. */
export const isWorkbenchProviderId=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9._-]{0,63}$/.test(value)
export function isWorkbenchExecutorCapabilities(value:unknown):value is WorkbenchExecutorCapabilities {
  if(!object(value)||value.version!==1||value.permissions!=='task'||value.configuration!=='task-policy'||value.completion!=='native'||value.stop!=='confirmed'||
    (value.background!=='tracked'&&value.background!=='disabled')||!object(value.features))return false
  const features=value.features
  return ['nativeResume','attachments','executionSettings','modelCatalog'].every(key=>typeof features[key]==='boolean')
}

export function requireWorkbenchInput(capabilities:WorkbenchExecutorCapabilities,input:{attachments:readonly unknown[];execution:AgentExecutionChoice;resume?:boolean}):void {
  if(!isWorkbenchExecutorCapabilities(capabilities))throw Error('unavailable_provider')
  if(input.attachments.length&&!capabilities.features.attachments)throw Error('workbench_attachments_unsupported')
  if((input.execution.defaults==='native'||input.execution.model!==null||input.execution.reasoningEffort!==null)&&!capabilities.features.executionSettings)throw Error('workbench_execution_unsupported')
  if(input.resume&&!capabilities.features.nativeResume)throw Error('workbench_resume_unsupported')
}
