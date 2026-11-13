import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it,vi } from 'vitest'
import { checkupModule } from './module'
import { createProviderRegistry } from '../../app/provider-registry'

it('estimates with configured endpoint capacity, preferring observed provider metadata and falling back when unknown',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'checkup-module-'))
  vi.stubEnv('WECHAT_STATE_DIR',stateDir)
  let observed:number|undefined,model='m',requestedModel='m',address='https://gateway.example/v1'
  const registry=createProviderRegistry()
  registry.register('openai',{spawn:async()=>{throw Error('no model call')},callTarget:()=>({provider:'openai',baseUrl:address,model}),contextWindowTokens:()=>observed,prepareContextWindow:async()=>{observed=131072}},{canResume:()=>false})
  writeFileSync(join(stateDir,'agent-config.json'),JSON.stringify({modelContextWindows:[{provider:'openai',address,model:'m',windowTokens:65536}]}))
  const values:any={'bootstrap':{registry,defaultProviderId:'openai',conversationStore:{get:()=>null},currentModelFor:()=>requestedModel,holdBusy:()=>()=>{}},memory:{promptReads:{personaFor:()=>({content:''})}},workbench:{availableExecutors:()=>[]},'internal-api':{mount:()=>{}}}
  const ctx:any={get:(key:string)=>values[key],interval:()=>{},own:()=>{}}
  try{
    const service=checkupModule({stateDir} as any).init(ctx) as any
    expect(service.view().target).toMatchObject({windowTokens:65536,windowKnown:true})
    requestedModel='stale-pin'
    expect(service.view().target.model).toBe('m')
    expect(service.view({model:'operator-pin'}).target.model).toBe('operator-pin')
    requestedModel='m'
    const configured=service.estimate()
    observed=32768
    expect(service.view().target).toMatchObject({windowTokens:32768,windowKnown:true})
    expect(service.estimate().inputTokens).toBeLessThan(configured.inputTokens)
    observed=undefined;address='https://other.example/v1'
    expect(service.view().target).toMatchObject({windowTokens:8192,windowKnown:false})
    address='https://gateway.example/v1';model='other';requestedModel='other'
    expect(service.view().target).toMatchObject({windowTokens:8192,windowKnown:false})
    const prepared=await service.prepareEstimate()
    expect(prepared.windowKnown).toBe(true)
    expect(service.view().target.windowTokens).toBe(131072)
  }finally{vi.unstubAllEnvs();rmSync(stateDir,{recursive:true,force:true})}
})

it('uses the workbench executor source when boot registry has no workbench capabilities',async()=>{
  const {makeWorkbenchService}=await import('../workbench/service')
  const {makeWorkbenchStore}=await import('../../adapters/store/workbench/store')
  const {MANAGED_NATIVE_CAPABILITIES}=await import('../../domain/workbench/executor-capabilities')
  const {interviewAnswer}=await import('../../test-support/checkup-model')
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  const stateDir=mkdtempSync(join(tmpdir(),'checkup-real-executors-'))
  vi.stubEnv('WECHAT_STATE_DIR',stateDir)
  const registry=createProviderRegistry(),workers=createProviderRegistry(),outbound:any[]=[]
  const samples=buildInterviewPlan({windowTokens:8192,full:false,executors:['codex']}).samples
  registry.register('openai',{supportsIsolatedEvaluation:true,callTarget:()=>({provider:'openai',model:'invented'}),async spawn(_project,ctx){
    outbound.push({instructions:ctx.appendInstructions,tools:ctx.evaluation!.tools.tools})
    return{async *dispatch(prompt){outbound.push(prompt);const sample=samples.find(s=>prompt.endsWith('用户：'+s.prompt.split('用户：').at(-1)))!;for(const c of interviewAnswer(sample).toolCalls)await ctx.evaluation!.tools.call(c.name,c.input);yield{kind:'result',sessionId:'invented',numTurns:1,durationMs:1}},close:async()=>{}}
  }},{canResume:()=>false})
  workers.register('codex',{spawn:async()=>{throw Error('must not run a real worker')}},{canResume:()=>false,workbench:MANAGED_NATIVE_CAPABILITIES})
  const {openDb}=await import('../../lib/db')
  const db=openDb({path:join(stateDir,'offline.db')})
  const wb=makeWorkbenchService({stateDir,store:makeWorkbenchStore(db),registry:workers,ownerChatId:()=>null})
  const values:any={bootstrap:{registry,defaultProviderId:'openai',conversationStore:{get:()=>null},holdBusy:()=>()=>{}},memory:{promptReads:{personaFor:()=>({content:''})}},workbench:wb,'internal-api':{mount:()=>{}}}
  const ctx:any={get:(key:string)=>values[key],interval:()=>{},own:()=>{}}
  try{
    expect(registry.get('openai')?.opts.workbench).toBeUndefined()
    const mod=checkupModule({stateDir} as any)
    expect(mod.needs).toContain('workbench')
    const service=mod.init(ctx) as any
    expect(service.estimate().requests).toBe(48)
    await service.start().done
    expect(service.view().profile?.interview?.qualities.privacy).toEqual({passed:4,total:4,ratio:1})
    expect(outbound.filter(o=>typeof o==='object')).toHaveLength(24)
    expect(JSON.stringify(outbound)).not.toContain('codex')
    expect(outbound[0].tools.find((t:any)=>t.name==='delegate').parameters.properties.executor.enum).toEqual(['阿禾'])
  }finally{await wb.shutdown();db.close();vi.unstubAllEnvs();rmSync(stateDir,{recursive:true,force:true})}
})
