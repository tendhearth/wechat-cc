import { describe, expect, it } from 'vitest'
import { canResumeWorkbenchExecutor, isWorkbenchExecutorCapabilities, isWorkbenchProviderId, MANAGED_API_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES, requireWorkbenchInput, UNATTENDED_CAPABILITIES, isUnattendedExecutor } from './executor-capabilities'

const declared = () => ({version:1,permissions:'task',configuration:'task-policy',completion:'native',stop:'confirmed',background:'tracked',
  features:{nativeResume:true,attachments:true,executionSettings:true,modelCatalog:true}})
const input = {attachments:[],execution:{defaults:'provider' as const,model:null,reasoningEffort:null}}

describe('workbench executor admission', () => {
  it('accepts bounded provider identifiers without a brand list and rejects ambiguous command tokens',()=>{
    for(const id of ['claude','codex','fixture.review-v2','native_cursor'])expect(isWorkbenchProviderId(id)).toBe(true)
    for(const id of [null,{},'', 'a'.repeat(65),'x y','x\ny','../executor','@cursor','-option'])expect(isWorkbenchProviderId(id)).toBe(false)
  })
  it('does not infer task guarantees from a name, truthy flag or incomplete declaration', () => {
    for(const value of [null,undefined,true,'claude',[],{}, {id:'claude'}, {workbench:true}])expect(isWorkbenchExecutorCapabilities(value)).toBe(false)
    for(const key of ['version','permissions','configuration','completion','stop','background','features']) {
      const value:Record<string,unknown>=declared();delete value[key]
      expect(isWorkbenchExecutorCapabilities(value),key).toBe(false)
    }
    for(const [key,value] of [['version',2],['permissions','auto'],['configuration','global'],['completion','eof'],['stop','best-effort'],['background','ignored']]) {
      expect(isWorkbenchExecutorCapabilities({...declared(),[key as string]:value})).toBe(false)
    }
  })

  it('requires explicit boolean feature values and permits deliberately absent optional capabilities', () => {
    for(const key of ['nativeResume','attachments','executionSettings','modelCatalog']) {
      for(const value of [undefined,'true',1,null])expect(isWorkbenchExecutorCapabilities({...declared(),features:{...declared().features,[key]:value}})).toBe(false)
    }
    expect(isWorkbenchExecutorCapabilities({...declared(),background:'disabled',features:{nativeResume:false,attachments:false,executionSettings:false,modelCatalog:false}})).toBe(true)
    expect(isWorkbenchExecutorCapabilities(declared())).toBe(true)
  })

  it('rejects malformed declarations even when called outside the service gate', () => {
    expect(()=>requireWorkbenchInput({} as never,input)).toThrow('unavailable_provider')
  })

  it('accepts default text while refusing unsupported attachments before dispatch', () => {
    const capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,attachments:false}}
    expect(()=>requireWorkbenchInput(capabilities,input)).not.toThrow()
    expect(()=>requireWorkbenchInput(capabilities,{...input,attachments:[{}]})).toThrow('workbench_attachments_unsupported')
  })

  it('does not silently discard model, effort or native defaults for a simpler executor', () => {
    const capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,executionSettings:false}}
    expect(()=>requireWorkbenchInput(capabilities,input)).not.toThrow()
    for(const execution of [{...input.execution,model:'selected-model'},{...input.execution,reasoningEffort:'high'},{...input.execution,defaults:'native' as const}]) {
      expect(()=>requireWorkbenchInput(capabilities,{...input,execution})).toThrow('workbench_execution_unsupported')
    }
  })

  it('requires native resume separately from fresh text execution', () => {
    const capabilities={...MANAGED_NATIVE_CAPABILITIES,features:{...MANAGED_NATIVE_CAPABILITIES.features,nativeResume:false}}
    expect(()=>requireWorkbenchInput(capabilities,{...input,resume:false})).not.toThrow()
    expect(()=>requireWorkbenchInput(capabilities,{...input,resume:true})).toThrow('workbench_resume_unsupported')
  })

  it('admits managed transcripts for continuation without claiming native history',()=>{
    expect(MANAGED_API_CAPABILITIES).toMatchObject({background:'disabled',features:{nativeResume:false,managedResume:true,attachments:true,executionSettings:false,modelCatalog:false}})
    expect(canResumeWorkbenchExecutor(MANAGED_API_CAPABILITIES)).toBe(true)
    expect(canResumeWorkbenchExecutor({...MANAGED_API_CAPABILITIES,features:{...MANAGED_API_CAPABILITIES.features,managedResume:false}})).toBe(false)
    expect(()=>requireWorkbenchInput(MANAGED_API_CAPABILITIES,{...input,resume:true})).not.toThrow()
    expect(isWorkbenchExecutorCapabilities({...declared(),features:{...declared().features,managedResume:'yes'}})).toBe(false)
  })

  it('shared native registration cannot be changed by one consumer', () => {
    expect(Reflect.set(MANAGED_NATIVE_CAPABILITIES,'stop','best-effort')).toBe(false)
    expect(Reflect.set(MANAGED_NATIVE_CAPABILITIES.features,'attachments',false)).toBe(false)
    expect(()=>requireWorkbenchInput(MANAGED_NATIVE_CAPABILITIES,{attachments:[{}],execution:{defaults:'native',model:'selected',reasoningEffort:'high'},resume:true})).not.toThrow()
  })
})

describe('免审执行者能力', () => {
  it('permissions 认 task 与 unattended,拒绝别的值', () => {
    expect(isWorkbenchExecutorCapabilities(UNATTENDED_CAPABILITIES)).toBe(true)
    expect(isWorkbenchExecutorCapabilities(MANAGED_NATIVE_CAPABILITIES)).toBe(true)
    expect(isWorkbenchExecutorCapabilities({ ...UNATTENDED_CAPABILITIES, permissions: 'none' })).toBe(false)
    expect(isUnattendedExecutor(UNATTENDED_CAPABILITIES)).toBe(true); expect(isUnattendedExecutor(MANAGED_NATIVE_CAPABILITIES)).toBe(false)
  })
  it('免审执行者不收附件、不认执行设置,但能恢复原会话', () => {
    const execution = { defaults: 'provider' as const, model: null, reasoningEffort: null }
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [{}], execution })).toThrow('workbench_attachments_unsupported')
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [], execution: { ...execution, model: 'x' } })).toThrow('workbench_execution_unsupported')
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [], execution, resume: true })).not.toThrow()
  })
})
