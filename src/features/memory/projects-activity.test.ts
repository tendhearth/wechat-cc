import { afterEach, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { readProjectsActivity } from './projects-activity'
const dbs:Db[]=[]
afterEach(()=>{for(const db of dbs.splice(0))db.close()})
const at=Date.parse('2026-11-10T12:00:00-08:00'), now=at+86400000
async function fixture(){
 const db=openTestDb();dbs.push(db)
 let clock=at
 const threads=makeThreadsStore(db),matters=makeMatterStore(db,()=>clock),log=makeMatterLog(db,()=>clock),turns=makeTerminalTurnLog({db,matters,log})
 const ids:Record<string,string>={}
 for(const title of ['bx','rici','private'])ids[title]=await threads.create({chatId:'owner',title,summary:'',facets:[],tags:[],episodes:[],private:title==='private'})
 const identify=async(path:string)=>({key:path+'/.git',roots:[path],names:[path.split('/').pop()!]})
 const read=(q={})=>readProjectsActivity({db,owner:'owner',now:()=>now,identify},q)
 return {db,threads,matters,log,turns,ids,read,tick:()=>{clock++},setClock:(value:number)=>{clock=value}}
}
it('reads archived historical turns by their own cwd, not a later repository, and never reads bodies',async()=>{
 const f=await fixture()
 f.turns.event({session_id:'abcdef123',source:'claude',cwd:'/projects/bx',kind:'prompt'},at)
 f.turns.event({session_id:'abcdef123',source:'claude',cwd:'/projects/bx',kind:'stop',text:'PRIVATE_REPLY'},at+1)
 f.setClock(now+1)
 f.turns.event({session_id:'abcdef123',source:'claude',cwd:'/projects/rici',kind:'prompt'},now+1)
 const m=f.matters.findBySurface('cli','abcdef123')!
 f.db.query('UPDATE matters SET archived_at=? WHERE id=?').run(now,m.id)
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:'已完成离线校验',body:'PRIVATE_ENTRY_BODY',ts:new Date(at).toISOString()})
 const r=await f.read({since:'2026-11-10T00:00:00-08:00',until:'2026-11-11T00:00:00-08:00'})
 expect(r.projects.map(p=>p.project)).toEqual(['bx'])
 expect(r.projects[0]!.history[0]).toMatchObject({code:'abcdef',step:'答完了'})
 expect(r.projects[0]!.entries[0]!.line).toBe('已完成离线校验')
 expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|\/projects\//)
})
it('reuses actual pending attention and filters owner, private, remote and temporary facts without writes',async()=>{
 const f=await fixture()
 for(const [sid,cwd,machine] of [['abcdef','/projects/bx',undefined],['111111','/projects/private',undefined],['222222','/projects/rici','remote'],['333333','/tmp/selftest',undefined]] as const){
  f.turns.event({session_id:sid,source:'claude',cwd,kind:'prompt',...(machine?{machine}:{})},at)
  f.turns.permissionAsked({session_id:sid,source:'claude',cwd,tool_name:'Bash',summary:'curl --password=PRIVATE_ARGS'},at)
 }
 const other=f.matters.create({kind:'task',title:'PRIVATE_OTHER_OWNER',projectPath:'/projects/rici',ownerChatId:'guest'})
 f.log.startTurn({matterId:other.id,executor:'codex'})
 const before=f.db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n
 const r=await f.read()
 expect(r.projects.map(p=>p.project)).toEqual(['bx'])
 expect(r.projects[0]!.current.waiting).toBe(1)
 expect(r.projects[0]!.current.sessions[0]).toMatchObject({code:'abcdef',latestStep:'等你批准 · Bash'})
 expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|remote|selftest|private/)
 expect(f.db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n).toBe(before)
})

it('a turn spanning yesterday uses in-window event times and does not claim its later completion',async()=>{
 const f=await fixture()
 f.turns.event({session_id:'444444',source:'claude',cwd:'/projects/bx',kind:'prompt'},at-86400000)
 const m=f.matters.findBySurface('cli','444444')!,turn=f.log.turns(m.id)[0]!
 f.log.writeItem({matterId:m.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'PRIVATE_PARTIAL_REPLY'}})
 f.log.finishTurn(turn.id,{status:'completed',endedAt:now+1000})
 const r=await f.read({since:'2026-11-10T00:00:00-08:00',until:'2026-11-11T00:00:00-08:00'})
 expect(r.projects.map(p=>p.project)).toEqual(['bx'])
 expect(r.projects[0]!.history[0]).toMatchObject({at,step:'有执行记录'})
 expect(JSON.stringify(r)).not.toContain('PRIVATE_PARTIAL_REPLY')
})

it('rechecks topic privacy after asynchronous project identity reads',async()=>{
 const f=await fixture()
 f.turns.event({session_id:'555555',source:'claude',cwd:'/projects/bx',kind:'prompt'},at)
 let changed=false
 const r=await readProjectsActivity({db:f.db,owner:'owner',now:()=>now,identify:async(path)=>{
  if(!changed){changed=true;await f.threads.update(f.ids.bx!,{private:true})}
  return {key:path+'/.git',roots:[path],names:['bx']}
 }},{})
 expect(r.projects).toEqual([])
 expect(JSON.stringify(r)).not.toContain('bx')
})

it('a named older project is not hidden by another project filling a global source limit',async()=>{
 const f=await fixture()
 await f.threads.addEntry({threadId:f.ids.rici!,kind:'progress',line:'rici 上次的进展',ts:new Date(at).toISOString()})
 for(let i=0;i<1002;i++)await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:`bx 新记录 ${i}`,ts:new Date(at+i+1).toISOString()})
 const r=await f.read({projects:['rici']})
 expect(r.projects.map(p=>p.project)).toEqual(['rici'])
 expect(r.projects[0]!.entries[0]!.line).toBe('rici 上次的进展')
 expect(r.noData).toEqual([])
})

it.each(['owner','provenance'] as const)('rechecks matter %s after asynchronous historical mapping',async(change)=>{
 const f=await fixture(),m=f.matters.create({kind:'task',title:'不能泄漏的任务',projectPath:'/projects/bx',ownerChatId:'owner'})
 const turn=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.finishTurn(turn.id,{status:'completed',endedAt:at+1})
 let calls=0
 const result=await readProjectsActivity({db:f.db,owner:'owner',now:()=>now,identify:async(path)=>{
  if(++calls===2){
   if(change==='owner')f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor',m.id)
   else {
    // Use terminal provenance for this branch, with the same owner-scoped matter.
    f.db.query("UPDATE matters SET kind='terminal' WHERE id=?").run(m.id)
    f.db.query('UPDATE matter_turns SET policy_json=? WHERE id=?').run(JSON.stringify({cwd:'/projects/bx',machine:'remote'}),turn.id)
   }
  }
  return {key:path+'/.git',roots:[path],names:['bx']}
 }},{})
 expect(calls).toBeGreaterThanOrEqual(2)
 expect(result.projects).toEqual([])
})

it('retains historical work provenance for a renamed public topic after it is done',async()=>{
 const f=await fixture()
 await f.threads.update(f.ids.bx!,{title:'网络工具'})
 const m=f.matters.create({kind:'task',title:'检查',projectPath:'/projects/bx',ownerChatId:'owner'})
 const turn=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.finishTurn(turn.id,{status:'completed',endedAt:at+1})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'conclusion',line:'检查已完成',source:'work',matterId:m.id,ts:new Date(at).toISOString()})
 await f.threads.update(f.ids.bx!,{status:'done'})
 const result=await f.read({projects:['网络工具']})
 expect(result.projects[0]!.history).toHaveLength(1)
 expect(result.projects[0]!.current.sessions).toEqual([])
})

it('filters linked work index lines by the original matter owner, local provenance and temporary path',async()=>{
 const f=await fixture()
 for(const shape of ['foreign','remote','temporary','allowed']){
  const m=f.matters.create({kind:shape==='remote'?'terminal':'task',title:shape,projectPath:shape==='temporary'?'/tmp/selftest':'/projects/bx',ownerChatId:shape==='foreign'?'visitor':'owner'})
  f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:m.projectPath,...(shape==='remote'?{machine:'remote'}:{})}})
  await f.threads.addEntry({threadId:f.ids.bx!,kind:'conclusion',line:shape==='allowed'?'已完成合法检查':`FORBIDDEN_${shape}`,source:'work',matterId:m.id,ts:new Date(at).toISOString()})
 }
 // Restricted cached names are hidden; stable ids still address authorized entries.
 const r=await f.read({projects:[f.ids.bx!]})
 expect(r.projects[0]!.entries.map(e=>e.line)).toEqual(['已完成合法检查'])
 expect(JSON.stringify(r)).not.toContain('FORBIDDEN_')
})

it('rechecks derived project names after an awaited source revocation',async()=>{
 const f=await fixture()
 await f.threads.update(f.ids.bx!,{title:'SECRET_PROJECT_TITLE',aliases:['bx']})
 const matter=f.matters.create({kind:'task',title:'检查',projectPath:'/projects/bx',ownerChatId:'owner'})
 const turn=f.log.startTurn({matterId:matter.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.finishTurn(turn.id,{status:'completed'})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'conclusion',line:'SECRET_RESULT',source:'work',matterId:matter.id,ts:new Date(at).toISOString()})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:'可读聊天进展',ts:new Date(at).toISOString()})
 const result=await readProjectsActivity({db:f.db,owner:'owner',now:()=>now,identify:async path=>{f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor',matter.id);return {key:path+'/.git',roots:[path],names:['bx']}}},{projects:[f.ids.bx!]})
 expect(JSON.stringify(result)).not.toContain('SECRET_')
 expect(result.projects[0]!.entries.map(e=>e.line)).toEqual(['可读聊天进展'])
})

it.each(['project-path','old-turn','selftest'] as const)('historical tasks obey the complete %s source boundary',async shape=>{
 const f=await fixture(),m=f.matters.create({kind:'task',title:shape==='selftest'?'selftest':'检查',projectPath:shape==='project-path'?'/tmp/restricted':'/projects/bx',ownerChatId:'owner'})
 if(shape==='old-turn'){
  const old=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/tmp/old'}})
  f.log.finishTurn(old.id,{status:'completed'})
 }
 const t=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.writeItem({matterId:m.id,turnId:t.id,kind:'tool_call',status:'completed',payload:{verb:'read',target:'CANARY_RESTRICTED_FILE.txt',tool:'Read'}})
 f.log.finishTurn(t.id,{status:'completed'})
 f.db.query('UPDATE matters SET archived_at=? WHERE id=?').run(now,m.id)
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:'安全进展',ts:new Date(at).toISOString()})
 const result=await f.read({projects:[f.ids.bx!]})
 expect(JSON.stringify(result)).not.toContain('CANARY_RESTRICTED_FILE.txt')
 expect(result.projects[0]!.history).toEqual([])
})

it('project history cannot map through a delegated ancestor excluded by its reader',async()=>{
 const f=await fixture()
 await f.threads.update(f.ids.bx!,{title:'个人账务',aliases:[]})
 const m=f.matters.create({kind:'task',title:'检查',projectPath:'/projects/bx',ownerChatId:'owner'})
 const t=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.writeItem({matterId:m.id,turnId:t.id,kind:'tool_call',status:'completed',payload:{verb:'read',target:'CANARY_DELEGATED_FILE.txt',tool:'Read'}})
 f.log.finishTurn(t.id,{status:'completed'})
 f.db.query('UPDATE matters SET archived_at=? WHERE id=?').run(now,m.id)
 const delegated=await f.threads.addEntry({threadId:f.ids.bx!,kind:'fact',line:'咨询来源',source:'delegate',ts:new Date(at).toISOString()})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'conclusion',line:'来源映射',source:'work',matterId:m.id,derivedFrom:[delegated],ts:new Date(at).toISOString()})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:'安全进展',ts:new Date(at).toISOString()})
 const result=await f.read({projects:[f.ids.bx!]})
 expect(JSON.stringify(result)).not.toContain('CANARY_DELEGATED_FILE.txt')
 expect(result.projects[0]!.history).toEqual([])
})

it('current task activity is rechecked after later historical identity work',async()=>{
 const f=await fixture(),m=f.matters.create({kind:'task',title:'检查',projectPath:'/projects/bx',ownerChatId:'owner'})
 const t=f.log.startTurn({matterId:m.id,executor:'codex',policy:{cwd:'/projects/bx'}})
 f.log.writeItem({matterId:m.id,turnId:t.id,kind:'tool_call',status:'started',payload:{verb:'read',target:'CANARY_CURRENT_FILE.txt',tool:'Read'}})
 await f.threads.addEntry({threadId:f.ids.bx!,kind:'progress',line:'安全进展',ts:new Date(at).toISOString()})
 let calls=0
 const result=await readProjectsActivity({db:f.db,owner:'owner',now:()=>now,identify:async path=>{if(++calls===2)f.db.query('UPDATE matters SET project_path=? WHERE id=?').run('/tmp/revoked',m.id);return {key:path+'/.git',roots:[path],names:['bx']}}},{projects:[f.ids.bx!]})
 expect(calls).toBeGreaterThanOrEqual(2)
 expect(JSON.stringify(result)).not.toContain('CANARY_CURRENT_FILE.txt')
 expect(result.projects[0]!.current.sessions).toEqual([])
})
