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
  const values:any={'bootstrap':{registry,defaultProviderId:'openai',conversationStore:{get:()=>null},currentModelFor:()=>requestedModel,holdBusy:()=>()=>{}},memory:{promptReads:{personaFor:()=>({content:''})}},'internal-api':{mount:()=>{}}}
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
