import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeApiSessionStore} from './api-sessions'
import {createApiTaskProvider} from './api-task-provider'
import type {APIModel,ChatMessage} from './api-model'
import type {AgentEvent,SpawnContext} from '../agent-provider'
import {TIER_PROFILES} from '../user-tier'

let root:string,project:string,db:Db,taskId:string
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-api-task-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')});taskId=makeWorkbenchStore(db).create({title:'report',path:project,ownerChatId:'owner',providerId:'openai'}).id})
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true})})
const ctx=(extra:Partial<SpawnContext>={}):SpawnContext=>({tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owner',appendInstructions:'Work only on this task.',requestPermission:async()=>true,...extra})
const collect=async(events:AsyncIterable<AgentEvent>)=>{const all:AgentEvent[]=[];for await(const e of events)all.push(e);return all}
function scripted(turns:Array<{text?:string;call?:{id:string;name:string;input:unknown};finish?:string}>){
  const seen:ChatMessage[][]=[]
  const model:APIModel={stream(messages){seen.push(structuredClone(messages));const turn=turns.shift();if(!turn)throw Error('unexpected turn');const calls=turn.call?[turn.call]:[]
    const result={messages:[{role:'assistant',content:[...(turn.text?[{type:'text',text:turn.text}]:[]),...calls.map(c=>({type:'tool-call',toolCallId:c.id,toolName:c.name,input:c.input}))]}] as ChatMessage[],toolCalls:calls,finishReason:turn.finish??(calls.length?'tool-calls':'stop'),model:'fixture'}
    return{deltas:(async function*(){if(turn.text)yield{kind:'text' as const,text:turn.text};for(const c of calls)yield{kind:'tool_call' as const,...c}})(),finished:Promise.resolve(result)}
  }};return{model,seen}
}
const provider=(model:APIModel,extra={})=>createApiTaskProvider({sessions:makeApiSessionStore(db),model,configHash:'a'.repeat(64),configuredModel:'fixture',...extra})

it('streams progress, requests the exact artifact permission, delivers and resumes full tool context',async()=>{
  const fixture=scripted([{text:'I will save the report.',call:{id:'write-1',name:'SaveArtifact',input:{name:'report.md',content:'# Result\n42'}}},{text:'Saved report.md.'},{text:'The prior report contains 42.'}]),p=provider(fixture.model)
  const permit=vi.fn(async(_request:{tool:string;description:string})=>true),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx({requestPermission:permit}))
  const events=await collect(s.dispatch('Create the report'));await s.close()
  const id=events.find(e=>e.kind==='init')!;if(id.kind!=='init')throw Error('init')
  expect(events.map(e=>e.kind)).toEqual(['init','text','tool_call','tool_call','text','result'])
  expect(permit.mock.calls[0]?.[0]).toMatchObject({tool:'SaveArtifact',description:expect.stringContaining('report.md')})
  expect(readFileSync(join(project,'.cc-workbench',taskId,'report.md'),'utf8')).toBe('# Result\n42')
  expect(p.canResume(project,id.sessionId)).toBe(true)
  const resumed=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx({resumeSessionId:id.sessionId}))
  await collect(resumed.dispatch('What did you save?'));await resumed.close()
  expect(JSON.stringify(fixture.seen[2])).toContain('write-1');expect(JSON.stringify(fixture.seen[2])).toContain('tool-result')
  expect(fixture.seen[2]?.at(-1)).toMatchObject({role:'user',content:expect.stringContaining('What did you save?')})
})

it('denied artifact writes leave no file and return a denial to the model',async()=>{
  const f=scripted([{call:{id:'no',name:'SaveArtifact',input:{name:'no.txt',content:'no'}}},{text:'Permission was declined.'}]),p=provider(f.model)
  const s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx({requestPermission:async()=>false}));const events=await collect(s.dispatch('save'));await s.close()
  expect(existsSync(join(project,'.cc-workbench',taskId,'no.txt'))).toBe(false)
  expect(JSON.stringify(f.seen[1])).toContain('permission_denied');expect(events.at(-1)?.kind).toBe('result')
})

it.each(['length','unknown','content-filter','error'])('never marks %s finish as task completion',async(finish)=>{
  const f=scripted([{text:'partial',finish}]),p=provider(f.model),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx())
  const events=await collect(s.dispatch('write'));await s.close();expect(events.some(e=>e.kind==='result')).toBe(false)
  expect(events.at(-1)).toMatchObject({kind:'error',code:'api_task_incomplete'})
  const init=events[0]!;if(init.kind==='init')expect(p.canResume(project,init.sessionId)).toBe(false)
})

it('stopping while permission waits prevents writes even if the bridge later approves',async()=>{
  let approve!:(value:boolean)=>void;const permission=vi.fn(()=>new Promise<boolean>(r=>approve=r))
  const f=scripted([{call:{id:'later',name:'SaveArtifact',input:{name:'late.txt',content:'late'}}}]),p=provider(f.model),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx({requestPermission:permission}))
  const work=collect(s.dispatch('save'));await expect.poll(()=>permission.mock.calls.length).toBe(1)
  await s.close();approve(true);const events=await work
  expect(existsSync(join(project,'.cc-workbench',taskId,'late.txt'))).toBe(false);expect(events.some(e=>e.kind==='result')).toBe(false)
})

it('aborts the live request and blocks concurrent dispatch or calls after closure',async()=>{
  let signal!:AbortSignal
  const model:APIModel={stream(_m,_t,s){signal=s;return{deltas:(async function*(){await new Promise<void>(r=>s.addEventListener('abort',()=>r(),{once:true}));throw Error('aborted')})(),finished:new Promise(()=>{})}}}
  const p=provider(model),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx()),work=collect(s.dispatch('first'))
  expect(()=>s.dispatch('overlap')).toThrow('api_task_busy');await expect.poll(()=>!!signal).toBe(true)
  await s.close();expect(signal.aborted).toBe(true);await work;expect(()=>s.dispatch('closed')).toThrow('api_task_closed')
})

it('refuses restoring a session into another task, owner, project or configured connection',async()=>{
  const f=scripted([{text:'done'}]),p=provider(f.model),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx())
  const events=await collect(s.dispatch('one'));await s.close();const init=events[0]!;if(init.kind!=='init')throw Error('init')
  const other=makeWorkbenchStore(db).create({title:'other',path:project,ownerChatId:'owner',providerId:'openai'})
  await expect(p.spawn({alias:`workbench:${other.id}`,path:project},ctx({resumeSessionId:init.sessionId}))).rejects.toThrow()
  await expect(p.spawn({alias:`workbench:${taskId}`,path:project},ctx({resumeSessionId:init.sessionId,chatId:'other'}))).rejects.toThrow()
  expect(provider(f.model,{configHash:'b'.repeat(64)}).canResume(project,init.sessionId)).toBe(false)
})

it('rejects unsupported attachments before sending any model request and does not read prompt file markers',async()=>{
  const f=scripted([{text:'I cannot read that marker.'}]),p=provider(f.model),s=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx())
  const events=await collect(s.dispatch('read',[{name:'file.pdf',mime:'application/pdf',path:'/not-opened',sha256:'0'.repeat(64),data:'AA=='}]));await s.close()
  expect(f.seen).toHaveLength(0);expect(events.at(-1)).toMatchObject({kind:'error',code:'api_task_attachment_unsupported'})
  const next=await p.spawn({alias:`workbench:${taskId}`,path:project},ctx());writeFileSync(join(root,'private.txt'),'secret-sentinel')
  await collect(next.dispatch(`[image:${join(root,'private.txt')}]`));await next.close();expect(JSON.stringify(f.seen)).not.toContain('secret-sentinel')
})

it('does not claim completion for an empty answer or execute a call with a contradictory finish',async()=>{
  for(const turn of [{text:'',finish:'stop'},{call:{id:'bad',name:'SaveArtifact',input:{name:'bad.txt',content:'bad'}},finish:'stop'}]){
    const f=scripted([turn]),s=await provider(f.model).spawn({alias:`workbench:${taskId}`,path:project},ctx())
    const events=await collect(s.dispatch('work'));await s.close()
    expect(events.at(-1)).toMatchObject({kind:'error',code:'api_task_incomplete'})
    expect(existsSync(join(project,'.cc-workbench',taskId,'bad.txt'))).toBe(false)
  }
})

it('refuses a project overlapping private CC state, before saving a session',async()=>{
  const f=scripted([]),p=provider(f.model,{privateStateDir:root})
  await expect(p.spawn({alias:`workbench:${taskId}`,path:project},ctx())).rejects.toThrow('api_task_private_scope')
  expect(db.query('SELECT * FROM workbench_api_sessions').all()).toHaveLength(0)
})

it('refuses another task internal directory as the selected project root',async()=>{
  const other=join(project,'.cc-workbench','deadbeef');mkdirSync(other,{recursive:true})
  const task=makeWorkbenchStore(db).create({title:'bad root',path:other,ownerChatId:'owner',providerId:'openai'})
  await expect(provider(scripted([]).model).spawn({alias:`workbench:${task.id}`,path:other},ctx())).rejects.toThrow('api_task_private_scope')
  expect(db.query('SELECT * FROM workbench_api_sessions').all()).toHaveLength(0)
})

it('keeps closure unconfirmed until an uncooperative model stream ends, without accepting late effects',async()=>{
  let release!:()=>void;const stalled=new Promise<void>(r=>release=r)
  const model:APIModel={stream(){return{deltas:(async function*(){await stalled;yield{kind:'tool_call' as const,id:'late',name:'SaveArtifact',input:{name:'late.txt',content:'late'}}})(),finished:Promise.resolve({messages:[],toolCalls:[],finishReason:'stop',model:null})}}}
  const s=await provider(model,{closeTimeoutMs:15}).spawn({alias:`workbench:${taskId}`,path:project},ctx()),work=collect(s.dispatch('work'))
  await expect(s.close()).rejects.toThrow('api_task_close_unconfirmed')
  release();await work;await expect(s.close()).resolves.toBeUndefined()
  expect(existsSync(join(project,'.cc-workbench',taskId,'late.txt'))).toBe(false)
})

it('bounds public stream output even when an endpoint ignores its output token request',async()=>{
  const f=scripted([{text:'x'.repeat(2*1024*1024+1)}]),s=await provider(f.model).spawn({alias:`workbench:${taskId}`,path:project},ctx())
  const events=await collect(s.dispatch('bounded'));await s.close()
  expect(events.some(e=>e.kind==='text')).toBe(false)
  expect(events.at(-1)).toMatchObject({kind:'error',code:'api_task_output_limit'})
})
