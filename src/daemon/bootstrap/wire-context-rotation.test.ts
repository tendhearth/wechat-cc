import {afterEach,beforeEach,it,expect} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openTestDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeMessagesStore} from '../../lib/messages-store'
import {makeThreadsStore} from '../../lib/threads-store'
import {createProviderRegistry} from '../../app/provider-registry'
import {wireContextRotation,CONTEXT_CARE} from './wire-context-rotation'

let db:Db,dir:string
beforeEach(()=>{db=openTestDb();dir=mkdtempSync(join(tmpdir(),'rotation-wire-'))})
afterEach(()=>{db.close();removeTempDir(dir)})
const key={chatId:'owner',providerId:'claude',alias:'proj'}
const sessions={isInFlight:()=>false,rotate:async()=>true}
const row=(id:string,text:string,ts:string,direction:'in'|'out'='in',source='live')=>makeMessagesStore(db).append({id,chatId:'owner',ts,direction,kind:'text',text,source})
function setup(evalFn?: (prompt:string)=>Promise<string>){
 const jobs:(()=>Promise<void>)[]=[],registry=createProviderRegistry()
 registry.register('claude',{spawn:async()=>{throw Error('must not spawn')},...(evalFn?{cheapEval:evalFn}:{})},{displayName:'Claude',canResume:()=>false})
 const rotation=wireContextRotation({db,stateDir:dir,registry,owner:()=> 'owner',getMode:()=>({kind:'solo',provider:'claude'}),budgetFor:()=>({windowTokens:20_000,reliableFillRatio:.25}),defer:job=>jobs.push(job),log:()=>{}})
 return{rotation,jobs}
}
it('post-delivery App persistence precedes the small extraction; entries and the continuous watermark advance',async()=>{
 let prompt=''
 const s=setup(async p=>{prompt=p;return JSON.stringify({ops:[{op:'create_topic',title:'茶',summary:'饮茶偏好',facets:['life'],tags:[],private:true,entries:[{kind:'decision',line:'以后喝热茶'}]}]})})
 await s.rotation.beforeTurn(key,'m',sessions)
 s.rotation.delivered(key,'我决定以后只喝热茶',false)
 expect(prompt).toBe('')
 await row('app:phone:123:in','我决定以后只喝热茶','2026-11-12T20:00:00.000Z')
 await row('app:phone:123:out','记下了','2026-11-12T20:00:00.001Z','out')
 s.rotation.persisted('owner','2026-11-12T20:00:00.001Z')
 await s.jobs.shift()!()
 expect(prompt).toContain('我决定以后只喝热茶')
 expect((await makeThreadsStore(db).list('owner'))[0]?.title).toBe('茶')
 expect((await makeThreadsStore(db).getExtractState('owner')).entriesToTs).toBe('2026-11-12T20:00:00.001Z')
 const reopened=setup(async()=>{throw Error('cooldown must survive restart')})
 reopened.rotation.delivered(key,'我决定以后喝热茶',false)
 await expect(reopened.jobs.shift()!()).resolves.toBeUndefined()
})
it('queued current inbound is excluded by identity while the previous late answer remains verbatim',async()=>{
 const s=setup()
 await row('owner:1000','前一个问题','2026-11-12T20:00:00.000Z')
 await row('owner:2000','刚才那个呢','2026-11-12T20:00:01.000Z')
 await row('late-reply','上轮较晚送达的原文','2026-11-12T20:00:02.000Z','out')
 const block=await s.rotation.continuation(key,{id:'owner:2000',at:Date.parse('2026-11-12T20:00:01.000Z')})
 expect(block.block).toContain('上轮较晚送达的原文')
 expect(block.block).not.toContain('刚才那个呢')
})
it('companion full text is excluded, and the one-line result is available for an ordinary resumed next turn',async()=>{
 const s=setup()
 await s.rotation.beforeTurn(key,'m',sessions)
 await row('p','陪伴全文不再带回'.repeat(100),'2026-11-12T20:00:00.000Z','out','speech:companion')
 s.rotation.noteCompanion('owner','提醒散步：已送达')
 expect((await s.rotation.continuation(key)).block).not.toContain('陪伴全文')
 expect(s.rotation.eventsBlock(key)).toContain('提醒散步：已送达')
 s.rotation.started(key)
 expect(s.rotation.eventsBlock(key)).toBe('')
 expect(CONTEXT_CARE.discretion).toEqual({policy:'ask.lower-threshold',enabled:false})
})
it('without a cheap model the watermark and source history are left intact',async()=>{
 const s=setup();await s.rotation.beforeTurn(key,'m',sessions)
 await row('in','我决定以后只喝热茶','2026-11-12T20:00:00.000Z')
 s.rotation.delivered(key,'我决定以后只喝热茶',false)
 await s.jobs.shift()!()
 expect((await makeThreadsStore(db).getExtractState('owner')).entriesToTs).toBeNull()
 expect((await makeMessagesStore(db).get('owner','in'))?.text).toBe('我决定以后只喝热茶')
})
