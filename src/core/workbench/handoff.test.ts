import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {saveArtifactSnapshot} from './artifacts'
let dir:string,db:Db,service:WorkbenchService
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'cc-handoff-')));db=openDb({path:join(dir,'test.db')})})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(dir,{recursive:true,force:true})})
function fixture(){
 const store=makeWorkbenchStore(db),registry=createProviderRegistry(),calls:Array<{providerId:string;resume?:string;text:string}>=[]
 let resumable=true
 for(const providerId of ['claude','codex'])registry.register(providerId,{async spawn(_p,c){return{async *dispatch(text){calls.push({providerId,resume:c.resumeSessionId,text});const id=c.resumeSessionId??`${providerId}-new`;yield{kind:'init' as const,sessionId:id};yield{kind:'text' as const,text:providerId==='claude'?'第一条：改名。\n第二条：补空输入测试。':'已只补空输入测试。'};yield{kind:'result' as const,sessionId:id,numTurns:1,durationMs:1}},async close(){}}}},{displayName:providerId,canResume:()=>resumable})
 service=makeWorkbenchService({store,registry,stateDir:dir,ownerChatId:()=>null})
 const source=store.create({path:dir,providerId:'codex',title:'实现计算器',ownerChatId:null});store.update(source.id,'completed');store.session(source.id,'original-codex');store.addEvent(source.id,'user','保持接口不变，修复空输入。');store.addEvent(source.id,'text','实现已完成。')
 saveArtifactSnapshot(store,source.id,{name:'report.md',mime:'text/markdown',bytes:Buffer.from('旧版本的确切内容：v1')},dir)
 const old=store.artifacts(source.id)[0]!
 saveArtifactSnapshot(store,source.id,{name:'report.md',mime:'text/markdown',bytes:Buffer.from('新版本内容：v2')},dir)
 return{store,calls,source,old,selection:{taskId:source.id,artifactId:old.id,sha256:old.sha256},resume(v:boolean){resumable=v}}
}
async function done(id:string){await vi.waitFor(()=>expect(['queued','running','cancelling']).not.toContain(service.detail(id).task.status))}
it('previews the selected immutable version without execution, rejecting unrelated or unsupported assets',async()=>{
 const f=fixture(),input={sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review' as const,request:'检查边界',artifacts:[f.selection]}
 const preview=await service.previewHandoff(input)
 expect(preview.context).toContain('旧版本的确切内容：v1');expect(preview.context).not.toContain('新版本内容：v2');expect(preview.artifacts).toEqual([f.selection]);expect(f.calls).toEqual([])
 await expect(service.previewHandoff({...input,artifacts:[{...f.selection,taskId:'ffffffff'}]})).rejects.toThrow('invalid_handoff_artifact')
 await expect(service.previewHandoff({...input,artifacts:[{...f.selection,sha256:'0'.repeat(64)}]})).rejects.toThrow('artifact_changed')
 saveArtifactSnapshot(f.store,f.source.id,{name:'image.png',mime:'image/png',bytes:Buffer.from('png')},dir)
 const image=f.store.artifacts(f.source.id)[0]!
 await expect(service.previewHandoff({...input,artifacts:[{taskId:f.source.id,artifactId:image.id,sha256:image.sha256}]})).rejects.toThrow('handoff_artifact_unsupported')
})
it('records a review and a chosen revision, preserving original native identity and version, with idempotent submission',async()=>{
 const f=fixture(),preview=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查边界',artifacts:[f.selection]})
 const review=await service.handoff({token:preview.token}),repeat=await service.handoff({token:preview.token});expect(repeat.task.id).toBe(review.task.id);await done(review.task.id)
 expect(f.calls).toHaveLength(1);expect(f.calls[0]!.providerId).toBe('claude');expect(f.calls[0]!.text).toBe(preview.context)
 const event=service.detail(review.task.id).events.find(e=>e.kind==='text')!,quote={taskId:review.task.id,eventId:event.id,text:'第二条：补空输入测试。'}
 const revision=await service.previewHandoff({sourceTaskId:review.task.id,targetTaskId:f.source.id,targetProviderId:'codex',purpose:'revision',request:'只采纳这条',artifacts:[],quote})
 expect(revision.context).toContain(quote.text);expect(revision.context).not.toContain('第一条：改名。')
 await service.handoff({token:revision.token});await done(f.source.id)
 expect(f.calls).toHaveLength(2);expect(f.calls[1]!.resume).toBe('original-codex');expect(f.store.get(f.source.id).sessionId).toBe('original-codex')
 expect(f.store.artifact(f.source.id,f.old.id).sha256).toBe(f.old.sha256)
 expect(service.detail(f.source.id).handoffs).toHaveLength(2);expect(service.detail(review.task.id).handoffs).toHaveLength(2)
 expect(service.detail(f.source.id).handoffs[0]?.targetNativeId).toBe('claude-new')
})
it('rejects invented quotes, changed source previews, archived or busy revision targets without dispatch',async()=>{
 const f=fixture(),p=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[]})
 f.store.addEvent(f.source.id,'text','new output')
 await expect(service.handoff({token:p.token})).rejects.toThrow('handoff_changed');expect(f.calls).toEqual([])
 const valid=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[]}),b=await service.handoff({token:valid.token});await done(b.task.id)
 const event=service.detail(b.task.id).events.find(e=>e.kind==='text')!
 const input={sourceTaskId:b.task.id,targetTaskId:f.source.id,targetProviderId:'codex',purpose:'revision' as const,request:'修改',artifacts:[],quote:{taskId:b.task.id,eventId:event.id,text:'invented'}}
 await expect(service.previewHandoff(input)).rejects.toThrow('invalid_handoff_quote')
 f.store.setArchived(f.source.id,true)
 await expect(service.previewHandoff({...input,quote:{...input.quote,text:'第一条：改名。'}})).rejects.toThrow('workbench_archived')
})
it('requires a fresh-start decision before revision and records the actual new native ID',async()=>{
 const f=fixture(),review=await service.handoff({token:(await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[f.selection]})).token});await done(review.task.id)
 f.resume(false)
 const event=service.detail(review.task.id).events.find(e=>e.kind==='text')!,p=await service.previewHandoff({sourceTaskId:review.task.id,targetTaskId:f.source.id,targetProviderId:'codex',purpose:'revision',request:'修改',artifacts:[],quote:{taskId:review.task.id,eventId:event.id,text:'第二条：补空输入测试。'}})
 expect(p.targetContinuation?.mode).toBe('restart_required')
 const count=f.store.events(f.source.id).length
 await expect(service.handoff({token:p.token})).rejects.toThrow('restart_confirmation_required');expect(f.calls).toHaveLength(1);expect(f.store.events(f.source.id)).toHaveLength(count);expect(f.store.handoffs(f.source.id)).toHaveLength(1)
 if(p.targetContinuation?.mode!=='restart_required')throw Error('missing preview')
 const result=await service.handoff({token:p.token,restartToken:p.targetContinuation.restart.token});await done(f.source.id)
 expect(f.calls[1]?.resume).toBeUndefined();expect(f.calls[1]?.text).toContain(p.targetContinuation.restart.context)
 const record=service.detail(f.source.id).handoffs.find(h=>h.id===result.handoffId)!
 expect(record.targetNativeId).toBe('codex-new');expect(record.requestEventId).toEqual(expect.any(Number))
 const publicPacket=service.handoffRecord(f.source.id,result.handoffId)
 expect(publicPacket.packet.context).toBe(p.context)
 expect(()=>service.handoffRecord('ffffffff',result.handoffId)).toThrow('not_found')
})
it('expires previews and detects unreadable snapshots before creating a handoff',async()=>{
 const f=fixture(),p=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[f.selection]})
 const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+6*60_000)
 await expect(service.handoff({token:p.token})).rejects.toThrow('handoff_changed');now.mockRestore()
 const fresh=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[f.selection]})
 rmSync(f.old.storagePath)
 await expect(service.handoff({token:fresh.token})).rejects.toThrow();expect(f.calls).toHaveLength(0);expect(f.store.handoffs(f.source.id)).toHaveLength(0)
})
it('pins a bounded packet with an explicit truncation notice instead of implying a full-file review',async()=>{
 const f=fixture();saveArtifactSnapshot(f.store,f.source.id,{name:'long.txt',mime:'text/plain',bytes:Buffer.from('Z'.repeat(100000))},dir)
 const a=f.store.artifacts(f.source.id)[0]!,p=await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[{taskId:f.source.id,artifactId:a.id,sha256:a.sha256}]})
 expect(p.context.length).toBeLessThanOrEqual(24000);expect(p.truncated).toBe(true);expect(p.context).toContain('已截断')
 // Mutating a returned JSON object cannot change the server-bound packet.
 p.context='changed by client';p.artifacts=[]
 const b=await service.handoff({token:p.token});await done(b.task.id)
 expect(f.calls[0]?.text).not.toBe(p.context);expect(service.detail(b.task.id).handoffs[0]?.artifacts[0]?.sha256).toBe(a.sha256)
})
it('queues a review behind an active source and records no native ID for a cancelled unstarted review',async()=>{
 const store=makeWorkbenchStore(db),registry=createProviderRegistry(),calls:string[]=[]
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 for(const id of ['claude','codex'])registry.register(id,{async spawn(){return{async *dispatch(){calls.push(id);yield{kind:'text' as const,text:'阶段成果已准备'};if(id==='codex')await gate;yield{kind:'result' as const,sessionId:`owned-${id}`,numTurns:1,durationMs:1}},async close(){}}}},{displayName:id,canResume:()=>true})
 service=makeWorkbenchService({store,registry,stateDir:dir,ownerChatId:()=>null})
 const a=service.create({path:dir,providerId:'codex',text:'实现'})
 await vi.waitFor(()=>expect(calls).toEqual(['codex']))
 const p=await service.previewHandoff({sourceTaskId:a.id,targetProviderId:'claude',purpose:'review',request:'检查阶段成果',artifacts:[]}),b=await service.handoff({token:p.token})
 expect(service.detail(b.task.id).task.waitingFor?.taskId).toBe(a.id)
 await service.cancel(b.task.id);release();await done(a.id)
 expect(calls).toEqual(['codex']);expect(store.handoffs(a.id)[0]?.targetNativeId).toBeNull()
 // A later ordinary turn on the review task must not retroactively claim it executed the cancelled handoff.
 service.continueTask(b.task.id,'另一个明确的新要求',{restartToken:service.detail(b.task.id).continuation?.mode==='restart_required'?service.detail(b.task.id).continuation!.restart!.token:undefined});await done(b.task.id)
 expect(store.handoffs(a.id)[0]?.targetNativeId).toBeNull()
})
it('refuses to revise a busy original task and keeps the review record intact',async()=>{
 const f=fixture(),b=await service.handoff({token:(await service.previewHandoff({sourceTaskId:f.source.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[]})).token});await done(b.task.id)
 const event=service.detail(b.task.id).events.find(e=>e.kind==='text')!
 service.continueTask(f.source.id,'另一个正在执行的要求')
 await expect(service.previewHandoff({sourceTaskId:b.task.id,targetTaskId:f.source.id,targetProviderId:'codex',purpose:'revision',request:'修改',artifacts:[],quote:{taskId:b.task.id,eventId:event.id,text:'第二条：补空输入测试。'}})).rejects.toThrow('workbench_busy')
 expect(f.store.handoffs(f.source.id)).toHaveLength(1);await done(f.source.id)
})
