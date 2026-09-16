import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {encodeNativeHistoryKey,historyPreview,type NativeHistoryItem,type NativeHistoryReader} from './native-history'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'
let dir:string,db:Db,service:WorkbenchService
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'cc-native-adopt-')));db=openDb({path:join(dir,'test.db')})})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(dir)})
function fixture(){
 const store=makeWorkbenchStore(db),registry=createProviderRegistry(),mint=vi.fn(()=> 'token')
 let version=1,active=false,block=false,resumable=true,resultId:string|undefined,gate:Promise<void>|null=null,release:undefined|(()=>void)
 const spawn=vi.fn(async(_p:any,context:any)=>({async *dispatch(){const id=resultId??context.resumeSessionId??'new-native';yield{kind:'init' as const,sessionId:id};if(gate)await gate;;yield{kind:'text' as const,text:'continued'};yield{kind:'result' as const,sessionId:resultId??context.resumeSessionId??'new-native',numTurns:1,durationMs:1}},async close(){}}))
 registry.register('claude',{spawn},{displayName:'Claude',canResume:()=>resumable,workbench:MANAGED_NATIVE_CAPABILITIES})
 const item:NativeHistoryItem={key:encodeNativeHistoryKey('claude','original'),providerId:'claude',nativeId:'original',title:'Original task',titleSource:'native_custom',cwd:dir,updatedAt:1,remote:false,observedState:'unknown'}
 const read=vi.fn(async(_key:string,page:any)=>historyPreview({...item,observedState:active?'active':'unknown'},{version},[{id:'u',role:'user',text:'original request',truncated:false},{id:'a',role:'assistant',text:'original answer',truncated:false}],null,page))
 const reader:NativeHistoryReader={list:async()=>({items:[item],nextCursor:null,coverage:'native_supported_history'}),read,currentFingerprint:async(key,page={limit:100})=>(await read(key,page)).sourceFingerprint}
 service=makeWorkbenchService({store,registry,stateDir:dir,ownerChatId:()=>null,mintSessionToken:mint,nativeHistory:{claude:reader},executionConflict:()=>block})
 const input=async()=>{const p=await read(item.key,{limit:100});return{key:item.key,pages:[{...p.page,sourceFingerprint:p.sourceFingerprint}],messageIds:['u','a']}}
 return{store,spawn,mint,item,read,input,hold(){gate=new Promise<void>(r=>release=r)},release(){gate=null;release?.()},change(){version++},active(v:boolean){active=v},block(v:boolean){block=v},resumable(v:boolean){resumable=v},wrong(){resultId='wrong'}}
}
async function settled(id:string){await vi.waitFor(()=>expect(['running','queued','cancelling']).not.toContain(service.detail(id).task.status))}
it('imports an immutable source once without spawning, queueing or minting credentials',async()=>{
 const f=fixture(),input=await f.input(),one=await service.importNativeHistory(input),two=await service.importNativeHistory(input)
 expect(one.created).toBe(true);expect(two.created).toBe(false);expect(two.task.id).toBe(one.task.id)
 expect(one.task.status).toBe('interrupted');expect(one.source.firstDispatchedAt).toBeNull()
 expect(f.store.get(one.task.id).sessionId).toBe('original');expect(service.detail(one.task.id).events.map(e=>e.sourceId)).toEqual([one.source.id,one.source.id])
 expect(f.spawn).not.toHaveBeenCalled();expect(f.mint).not.toHaveBeenCalled()
 expect(()=>service.continueTask(one.task.id,'go')).toThrow('external_close_confirmation_required')
 expect(service.detail(one.task.id).events).toHaveLength(2)
})
it('rejects a changed preview and unshown message IDs before creating anything',async()=>{
 const f=fixture(),input=await f.input();f.change()
 await expect(service.importNativeHistory(input)).rejects.toThrow('native_history_changed')
 await expect(service.importNativeHistory({...await f.input(),messageIds:['not-shown']})).rejects.toThrow('invalid_request')
 expect(service.list().tasks).toEqual([]);expect(f.spawn).not.toHaveBeenCalled()
})
it('requires a fresh source-bound explicit declaration and resumes the original identity',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input()),prepared=await service.prepareNativeResume(task.id)
 f.change();await expect(service.continueNativeTask(task.id,'continue',prepared.token)).rejects.toThrow('external_close_confirmation_stale')
 expect(service.detail(task.id).events).toHaveLength(2);expect(f.spawn).not.toHaveBeenCalled()
 const fresh=await service.prepareNativeResume(task.id);await service.continueNativeTask(task.id,'continue',fresh.token);await settled(task.id)
 expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBe('original');expect(f.store.get(task.id).sessionId).toBe('original')
 expect(service.detail(task.id).source?.firstDispatchedAt).not.toBeNull();expect(service.detail(task.id).source?.nativeId).toBe('original')
})
it('blocks active histories and competing daemon work; refuses mismatched native IDs',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input());f.active(true)
 await expect(service.prepareNativeResume(task.id)).rejects.toThrow('native_session_busy');f.active(false);f.block(true)
 await expect(service.prepareNativeResume(task.id)).rejects.toThrow('native_session_busy');f.block(false)
 const p=await service.prepareNativeResume(task.id);f.wrong();await service.continueNativeTask(task.id,'continue',p.token);await settled(task.id)
 expect(service.detail(task.id).task.error).toBe('native_session_identity_mismatch');expect(f.store.get(task.id).sessionId).toBe('original')
 expect(service.detail(task.id).events.some(e=>e.text==='continued')).toBe(false)
})
it('keeps unavailable native sessions imported and requires a separate explicit restart',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input());f.resumable(false)
 await expect(service.prepareNativeResume(task.id)).rejects.toThrow('restart_confirmation_required')
 expect(f.spawn).not.toHaveBeenCalled();expect(f.store.get(task.id).sessionId).toBe('original')
})

it('does not leave a phantom queued task when another daemon session owns its directory',()=>{
 const f=fixture();f.block(true)
 expect(()=>service.create({path:dir,providerId:'claude',text:'new task'})).toThrow('native_session_busy')
 expect(service.list().tasks).toEqual([]);expect(f.spawn).not.toHaveBeenCalled()
})
it('keeps the source snapshot unchanged after explicit fresh-context restart',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input()),source=f.store.source(task.id)!;f.resumable(false)
 const p=await service.prepareNativeResume(task.id,'fresh_context'),restart=service.detail(task.id).continuation!
 expect(p.context).toContain('original answer')
 await expect(service.continueNativeTask(task.id,'continue',p.token)).rejects.toThrow('restart_confirmation_stale')
 expect(f.spawn).not.toHaveBeenCalled()
 await service.continueNativeTask(task.id,'continue',p.token,restart.restart!.token);await settled(task.id)
 expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBeUndefined()
 expect(f.store.source(task.id)?.snapshotJson).toBe(source.snapshotJson);expect(f.store.source(task.id)?.snapshotSha256).toBe(source.snapshotSha256)
})
it('rejects an expired declaration before recording a follow-up',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input()),p=await service.prepareNativeResume(task.id),real=Date.now
 const clock=vi.spyOn(Date,'now').mockReturnValue(real()+6*60_000)
 try {await expect(service.continueNativeTask(task.id,'continue',p.token)).rejects.toThrow('external_close_confirmation_stale');expect(service.detail(task.id).events).toHaveLength(2);expect(f.spawn).not.toHaveBeenCalled()}finally{clock.mockRestore()}
})

it('rechecks an accepted native source after waiting for another task in the project',async()=>{
 const f=fixture();f.hold()
 const first=service.create({path:dir,providerId:'claude',text:'first'})
 await vi.waitFor(()=>expect(f.spawn).toHaveBeenCalledTimes(1))
 const {task}=await service.importNativeHistory(await f.input()),p=await service.prepareNativeResume(task.id)
 await service.continueNativeTask(task.id,'continue original',p.token)
 expect(service.detail(task.id).task.status).toBe('queued');f.change();f.release()
 await settled(first.id);await settled(task.id)
 expect(f.spawn).toHaveBeenCalledTimes(1);expect(f.mint).toHaveBeenCalledTimes(1)
 expect(service.detail(task.id).task.error).toBe('external_close_confirmation_stale');expect(f.store.get(task.id).sessionId).toBe('original')
})

it('retains native defaults on imported continuation and records only observed model evidence',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input())
 const choice={defaults:'native',model:null,reasoningEffort:null}
 expect(service.detail(task.id).execution).toEqual(choice)
 const p=await service.prepareNativeResume(task.id)
 await service.continueNativeTask(task.id,'continue',p.token);await settled(task.id)
 expect(f.spawn.mock.calls[0]?.[1]).toMatchObject({resumeSessionId:'original',execution:choice})
 expect(service.detail(task.id).lastExecution?.effective).toBeNull()
 service.continueTask(task.id,'again');await settled(task.id)
 expect(f.spawn.mock.calls[1]?.[1].execution).toEqual(choice)
})

it('binds the native preparation to an immutable choice and rejects a changed submission',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input())
 const choice={defaults:'native' as const,model:'selected',reasoningEffort:'high'}
 const p=await service.prepareNativeResume(task.id,'native_resume',choice)
 // The returned preview is client-owned; editing it cannot rewrite the server decision.
 ;(p as typeof p&{execution:typeof choice}).execution.model='changed'
 await expect(service.continueNativeTask(task.id,'continue',p.token,undefined,{execution:{...choice,model:'changed'}})).rejects.toThrow('external_close_confirmation_stale')
 expect(f.spawn).not.toHaveBeenCalled();expect(service.detail(task.id).events).toHaveLength(2)
 await service.continueNativeTask(task.id,'continue',p.token,undefined,{execution:choice});await settled(task.id)
 expect(f.spawn.mock.calls[0]?.[1].execution).toEqual(choice)
})

it('preserves the selected native configuration through an explicit fresh-context restart',async()=>{
 const f=fixture(),{task}=await service.importNativeHistory(await f.input());f.resumable(false)
 const choice={defaults:'native' as const,model:'selected',reasoningEffort:'high'}
 const p=await service.prepareNativeResume(task.id,'fresh_context',choice),restart=service.detail(task.id).continuation!.restart!
 await service.continueNativeTask(task.id,'restart',p.token,restart.token,{execution:choice});await settled(task.id)
 expect(f.spawn.mock.calls[0]?.[1].execution).toEqual(choice)
 expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBeUndefined()
})
