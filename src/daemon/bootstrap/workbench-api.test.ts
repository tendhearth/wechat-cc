import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb} from '../../lib/db'
import {createProviderRegistry} from '../../core/provider-registry'
import {MANAGED_API_CAPABILITIES} from '../../core/workbench/executor-capabilities'
import {registerWorkbenchApi} from './workbench-api'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {TIER_PROFILES} from '../../core/user-tier'
import {removeTempDir} from '../../lib/test-temp'

const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))removeTempDir(root)})

it('registers the isolated API task adapter without making a network call',()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-register-api-'));roots.push(root);const db=openDb({path:join(root,'state.db')}),registry=createProviderRegistry(),fetchSpy=vi.spyOn(globalThis,'fetch')
  try{
    expect(registerWorkbenchApi(registry,db,root,{openaiBaseUrl:'https://gateway.example/v1',openaiModel:'report-model'},{WECHAT_OPENAI_API_KEY:'secret'})).toBe(true)
    const entry=registry.get('openai')!
    expect(entry.opts).toMatchObject({displayName:expect.stringContaining('report-model'),workbench:MANAGED_API_CAPABILITIES})
    expect(entry.opts.canResume('/missing','missing')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workbench_api_sessions'").get()).not.toBeNull()
  }finally{fetchSpy.mockRestore();db.close()}
})

it('silently excludes missing configuration and fails closed on malformed endpoints',()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-register-api-'));roots.push(root);mkdirSync(join(root,'project'))
  const cases=[
    [{openaiBaseUrl:'https://gateway.example/v1',openaiModel:'model'},{}],
    [{openaiBaseUrl:'https://gateway.example/v1'}, {WECHAT_OPENAI_API_KEY:'secret'}],
    [{openaiModel:'model'}, {WECHAT_OPENAI_API_KEY:'secret'}],
    [{openaiBaseUrl:'file:///tmp/model',openaiModel:'model'}, {WECHAT_OPENAI_API_KEY:'secret'}],
    [{openaiBaseUrl:'https://user:pass@gateway.example/v1',openaiModel:'model'}, {WECHAT_OPENAI_API_KEY:'secret'}],
  ] as const
  for(const [config,env] of cases){const db=openDb({path:join(root,crypto.randomUUID()+'.db')}),registry=createProviderRegistry();try{expect(registerWorkbenchApi(registry,db,root,config,env)).toBe(false);expect(registry.has('openai')).toBe(false)}finally{db.close()}}
})

it('protects the actual daemon state tree before creating a session or API request',async()=>{
  const sandbox=realpathSync(mkdtempSync(join(tmpdir(),'cc-register-api-scope-')));roots.push(sandbox)
  const stateDir=join(sandbox,'state'),internalProject=join(stateDir,'workbench-artifacts'),externalProject=join(sandbox,'external-project')
  mkdirSync(internalProject,{recursive:true});mkdirSync(externalProject);writeFileSync(join(internalProject,'sentinel.txt'),'private')
  const db=openDb({path:join(stateDir,'state.db')}),registry=createProviderRegistry(),tasks=makeWorkbenchStore(db),fetchSpy=vi.spyOn(globalThis,'fetch')
  try{
    expect(registerWorkbenchApi(registry,db,stateDir,{openaiBaseUrl:'https://gateway.example/v1',openaiModel:'model'},{WECHAT_OPENAI_API_KEY:'secret'})).toBe(true)
    const provider=registry.get('openai')!.provider,context={tierProfile:TIER_PROFILES.trusted,permissionMode:'strict' as const,chatId:'owner'}
    const internal=tasks.create({title:'private',path:internalProject,providerId:'openai',ownerChatId:'owner'})
    await expect(provider.spawn({alias:`workbench:${internal.id}`,path:internalProject},context)).rejects.toThrow('api_task_private_scope')
    expect(db.query<{count:number},[]>(`SELECT count(*) AS count FROM workbench_api_sessions`).get()!.count).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    const external=tasks.create({title:'external',path:externalProject,providerId:'openai',ownerChatId:'owner'})
    const session=await provider.spawn({alias:`workbench:${external.id}`,path:externalProject},context)
    expect(db.query<{count:number},[]>(`SELECT count(*) AS count FROM workbench_api_sessions`).get()!.count).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled();await session.close()
  }finally{fetchSpy.mockRestore();db.close()}
})
