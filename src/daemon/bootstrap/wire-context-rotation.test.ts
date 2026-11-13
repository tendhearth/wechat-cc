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
it('owner continuity: companion full original and timestamp reach an ordinary resumed next turn',async()=>{
 const s=setup()
 await s.rotation.beforeTurn(key,'m',sessions)
 await row('p','陪伴全文不再带回'.repeat(100),'2026-11-12T20:00:00.000Z','out','speech:companion')
 s.rotation.noteCompanion('owner','提醒散步：已送达')
 expect((await s.rotation.continuation(key)).block).toContain('陪伴全文')
 expect(await s.rotation.eventsBlock(key)).toContain('陪伴全文')
 s.rotation.started(key)
 await row('next','你刚才说的那个','2026-11-12T21:00:00Z')
 expect(await s.rotation.eventsBlock(key)).toBe('')
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
it('owner continuity: proactive original with time and attachment names survives into the next input',async()=>{
 const s=setup();await s.rotation.beforeTurn(key,'m',sessions)
 await row('q','晚饭聊到哪里','2026-11-12T19:00:00Z')
 await row('speech','我刚才建议去河边散步，然后在桥边喝茶。','2026-11-12T20:00:00Z','out','speech:agenda')
 await makeMessagesStore(db).append({id:'file',chatId:'owner',ts:'2026-11-12T20:01:00Z',direction:'in',kind:'file',text:'',source:'live',extras:JSON.stringify({attachments:[{kind:'file',name:'河边.png',path:'/tmp/private.png'}]})})
 const carry=await s.rotation.continuation(key)
 expect(carry.block).toContain('我刚才建议去河边散步，然后在桥边喝茶。')
 expect(carry.block).toContain('2026-11-12T20:00:00Z');expect(carry.block).toContain('河边.png');expect(carry.block).not.toContain('/tmp/private.png')
 const events=await s.rotation.eventsBlock(key,{id:'owner:2',at:2})
 expect(events).toBe('') // the attachment was a new owner utterance
})
it('owner continuity: accounting carries only locally authorized owner work, and revocation is rechecked',async()=>{
 const {makeMatterStore}=await import('../../adapters/store/matters-store')
 const {makeMatterLog}=await import('../../adapters/store/matter-log')
 const matters=makeMatterStore(db),log=makeMatterLog(db)
 const add=(owner:string,text:string)=>{const m=matters.create({kind:'task',title:'相册',projectPath:'/projects/family',ownerChatId:owner});const t=log.startTurn({matterId:m.id,executor:'claude'});log.writeItem({matterId:m.id,turnId:t.id,kind:'agent_message',status:'completed',payload:{text}});log.finishTurn(t.id,{status:'completed',matterState:'done'});return m.id}
 const own=add('owner','OWNER_WORK 原文结论'),other=add('visitor','VISITOR_SECRET 不得进来')
 let prompt=''
 const s=setup(async p=>{prompt=p;db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor',own);return JSON.stringify({ops:[{op:'create_topic',title:'相册',summary:'OWNER_WORK',facets:['task'],tags:[],private:false,entries:[{kind:'conclusion',line:'OWNER_WORK',matter:own}]}]})})
 await s.rotation.beforeTurn(key,'m',sessions);s.rotation.delivered(key,'我决定整理相册',false);await s.jobs.shift()!()
 expect(prompt).toContain('OWNER_WORK');expect(prompt).not.toContain('VISITOR_SECRET')
 expect(await makeThreadsStore(db).list('owner')).toEqual([])
 expect(matters.get(other)?.ownerChatId).toBe('visitor')
})
it('owner continuity: all small proactive bubbles since the last owner turn reach the next prompt',async()=>{
 const s=setup();await s.rotation.beforeTurn(key,'m',sessions)
 await row('q','先聊这个','2026-11-12T19:00:00Z')
 for(let i=0;i<7;i++)await row(`speech${i}`,`主动原话${i}`,`2026-11-12T20:00:0${i}Z`,'out','speech:agenda')
 const events=await s.rotation.eventsBlock(key)
 expect(events).toContain('主动原话0');expect(events).toContain('主动原话6');expect(events).toContain('2026-11-12T20:00:00Z')
 expect(events.length).toBeLessThanOrEqual(12000)
})
it('owner continuity: previous chat tools carry names and honest result status without unrelated task tools',async()=>{
 const {makeMatterStore}=await import('../../adapters/store/matters-store'),{makeMatterLog}=await import('../../adapters/store/matter-log')
 const matters=makeMatterStore(db),log=makeMatterLog(db)
 const chat=matters.create({kind:'chat',title:'主人对话',ownerChatId:'owner'}),turn=log.startTurn({matterId:chat.id,executor:'claude'})
 log.writeItem({matterId:chat.id,turnId:turn.id,kind:'tool_call',status:'completed',payload:{tool:'Read'}});log.finishTurn(turn.id,{status:'completed'})
 const task=matters.create({kind:'task',title:'旁边的任务',ownerChatId:'owner'}),taskTurn=log.startTurn({matterId:task.id,executor:'claude'})
 log.writeItem({matterId:task.id,turnId:taskTurn.id,kind:'tool_call',status:'completed',payload:{tool:'UNRELATED_TOOL'}});log.finishTurn(taskTurn.id,{status:'completed'})
 const s=setup();await row('q','你刚才看的文件呢','2026-11-12T20:00:00Z')
 const carry=await s.rotation.continuation(key)
 expect(carry.block).toContain('工具 Read');expect(carry.block).toContain('结果未记录');expect(carry.block).not.toContain('UNRELATED_TOOL')
})
