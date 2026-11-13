import {ledgerRoutes} from './ledger-routes'
import {makeMattersService} from '../../app/matters/service'
import {beforeLedgerInstructions} from '../../test-support/fixtures/workbench-before-ledger'
import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openTestDb} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {createProviderRegistry} from '../../app/provider-registry'
import {MANAGED_NATIVE_CAPABILITIES} from '../../domain/workbench/executor-capabilities'
import type {AgentEvent,AgentRuntimeSnapshot,AgentWorkbenchRuntime,SpawnContext} from '../../ports/agent-provider'
import {AsyncQueue} from '../../lib/async-queue'
import {makeWorkbenchService,type WorkbenchService} from './service'

const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
function setup(failure?:'spawn'|'dispatch'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-ledger-'))),project=join(root,'project');mkdirSync(project)
  const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{encoding:'utf8'})
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test')
  writeFileSync(join(project,'seed.txt'),'before');git('add','.');git('commit','-m','seed')
  const db=openTestDb(),store=makeWorkbenchStore(db),matters=makeMatterStore(db),registry=createProviderRegistry()
  const starts:SpawnContext[]=[],requests:string[]=[]
  let service:WorkbenchService,failed=false
  for(const executor of ['codex','claude'])registry.register(executor,{async spawn(_p,ctx){
    starts.push(ctx)
    if(executor==='claude'&&failure==='spawn'&&!failed){failed=true;throw Error('synthetic_spawn_failure')}
    const sessionId=ctx.resumeSessionId??`${executor}-session-${starts.length}`
    return {async *dispatch(text){
      requests.push(text)
      yield {kind:'init' as const,sessionId}
      if(executor==='claude'&&failure==='dispatch'&&!failed){failed=true;throw Error('synthetic_dispatch_failure')}
      yield {kind:'text' as const,itemId:'raw',text:'RAW_TRANSCRIPT_CANARY private tool reasoning'}
      if(executor==='codex'){
        writeFileSync(join(project,`codex-${starts.length}.txt`),'baton file')
        writeFileSync(join(project,'login-dark.webp'),'synthetic bytes')
        writeFileSync(join(project,'.cc-workbench',ctx.workbenchTaskId!,'portrait.txt'),'ARTIFACT_BODY_CANARY')
        git('add','.');git('commit','-m','image')
        if(ctx.matterLedger)service.matterNote(`workbench/${ctx.workbenchTaskId}`,'深色图在 login-dark.webp')
      }
      if(executor==='claude'&&!ctx.resumeSessionId)writeFileSync(join(project,'.cc-workbench',ctx.workbenchTaskId!,'baton-output.txt'),'baton output')
      yield {kind:'text' as const,itemId:'final',text:executor==='codex'?'深色图在 login-dark.webp':`${executor} 最终交接回复`}
      yield {kind:'result' as const,sessionId,numTurns:1,durationMs:1}
    },async close(){}}
  }},{displayName:executor,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>'owner',matters})
  cleanups.push(async()=>{await service.shutdown();db.close();removeTempDir(root)})
  return {root,project,git,db,store,service,starts,requests,matters}
}

it('two fake executors share one matter and workspace; the second receives notes and metadata, never the first transcript',async()=>{
  const f=setup(),first=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  expect(f.store.ledger.notes(first.id)).toEqual([])
  const next=await f.service.matterHandoff(first.id,'claude','把插图接进登录页')
  const notes=f.store.ledger.notes(first.id)
  expect(notes.filter(n=>n.kind==='note').map(n=>n.text)).toEqual(['深色图在 login-dark.webp'])
  expect(notes.find(n=>n.kind==='artifact')?.text).toContain('portrait.txt')
  expect(JSON.stringify(notes)).not.toContain('ARTIFACT_BODY_CANARY')
  expect(notes.find(n=>n.kind==='artifact')?.text).toContain(f.git('rev-parse','HEAD').trim())
  expect(next.id).toBe(first.id);expect(next.path).toBe(f.project)
  await expect.poll(()=>f.starts.length).toBe(2)
  expect(f.starts[1]!.resumeSessionId).toBeUndefined()
  expect(f.requests[1]!).toContain('深色图在 login-dark.webp')
  expect(f.requests[1]!).toContain('artifact')
  expect(f.requests[1]!).toContain(f.project)
  expect(f.requests[1]!).not.toContain('RAW_TRANSCRIPT_CANARY')
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  expect(f.store.ledger.agents(first.id).map(a=>[a.executor,a.status])).toEqual([['codex','completed'],['claude','completed']])
  expect(f.store.ledger.notes(first.id).filter(n=>n.kind==='note').at(-1)?.text).toBe('claude 最终交接回复')
  expect(f.store.ledger.notes(first.id).find(n=>n.kind==='artifact'&&n.author==='claude')?.text).toContain('baton-output.txt')
  const batons=f.store.ledger.agents(first.id)
  f.service.continueTask(first.id,'继续同一棒')
  await expect.poll(()=>f.starts.length).toBe(3)
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  expect(f.store.ledger.notes(first.id).find(n=>n.kind==='artifact'&&n.author==='claude')?.text).toContain('baton-output.txt')
  expect(f.requests[2]).toBe('继续同一棒')
  expect(f.starts[2]!.appendInstructions).not.toContain('matter_ledger_data')
  expect(f.store.ledger.agents(first.id).map(a=>a.runId)).toEqual(batons.map(a=>a.runId))
  // Losing a native session creates a confirmed restart of this same baton, not a new handoff.
  f.store.session(first.id,null)
  const continuation=f.service.detail(first.id).continuation!
  if(continuation.mode!=='restart_required')throw Error('missing restart preview')
  f.service.continueTask(first.id,'明确重开同一棒',{restartToken:continuation.restart.token})
  await expect.poll(()=>f.starts.length).toBe(4)
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  expect(f.requests[3]).not.toContain('matter_ledger_data')
  expect(f.matters.sessions(first.id).find(s=>s.sessionId==='claude-session-4')?.role).toBe('main')
  expect(f.store.ledger.agents(first.id)).toHaveLength(2)
  expect(f.matters.list({kind:'task'})).toHaveLength(1)
  expect(f.matters.sessions(first.id).find(s=>s.providerId==='claude')?.role).toBe('handoff')
})

it('executor tools resolve the bound matter and reject another matter or forged author',async()=>{
  const f=setup(),a=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(a.id).task.status).toBe('completed')
  const b=f.store.create({title:'other',path:'/other',providerId:'claude',ownerChatId:'owner'})
  f.store.ledger.start(b.id,'other-run','claude','secret')
  expect(()=>f.service.matterNotes(`workbench/${a.id}`,b.id)).toThrow('matter_scope_mismatch')
  expect(f.service.matterNotes(`workbench/${a.id}`).notes.every(n=>n.matterId===a.id)).toBe(true)
  expect(()=>f.service.matterNote('chat/owner','forged')).toThrow('matter_ledger_forbidden')
})

it('retained idle baton records completion and closes before the next writer starts',async()=>{
  const f=setup();await f.service.shutdown()
  const registry=createProviderRegistry(),queue=new AsyncQueue<AgentEvent>(),order:string[]=[],starts:SpawnContext[]=[]
  let snapshot:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  let service:WorkbenchService
  const runtime:AgentWorkbenchRuntime={events:queue.iterable(),snapshot:()=>snapshot,start(){
    queue.push({kind:'init',sessionId:'retained-first'})
    writeFileSync(join(f.project,'retained.txt'),'ready')
    queue.push({kind:'text',itemId:'final',text:'接着用 retained.txt'})
    snapshot={...snapshot,foreground:'idle'}
    queue.push({kind:'result',sessionId:'retained-first',numTurns:1,durationMs:1})
  },async submit(){}}
  registry.register('codex',{async spawn(){return {workbenchRuntime:runtime,async *dispatch(){},async close(){order.push('closed');queue.end()}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('claude',{async spawn(_p,ctx){order.push('next');starts.push(ctx);return {async *dispatch(text){starts[0]!.appendInstructions=text;yield {kind:'result',sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:f.store,registry,stateDir:f.root,ownerChatId:()=>'owner',matters:f.matters})
  cleanups.unshift(()=>service.shutdown())
  const task=service.create({path:f.project,providerId:'codex',text:'先做'})
  await expect.poll(()=>service.detail(task.id).runtime?.foreground).toBe('idle')
  expect(f.store.ledger.notes(task.id)).toEqual([])
  snapshot={...snapshot,foreground:'running'}
  queue.push({kind:'text',itemId:'second-start',text:'第二轮正在做'})
  await expect.poll(()=>service.detail(task.id).runtime?.foreground).toBe('running')
  snapshot={...snapshot,foreground:'idle'}
  queue.push({kind:'text',itemId:'second-final',text:'LATEST_RETAINED_TURN_HANDOFF'})
  queue.push({kind:'result',sessionId:'retained-first',numTurns:2,durationMs:1})
  await expect.poll(()=>service.detail(task.id).events.some(e=>e.text==='LATEST_RETAINED_TURN_HANDOFF')).toBe(true)
  await expect.poll(()=>service.detail(task.id).runtime?.foreground).toBe('idle')
  await service.matterHandoff(task.id,'claude','接着做')
  await expect.poll(()=>order).toEqual(['closed','next'])
  expect(f.store.ledger.notes(task.id).find(n=>n.kind==='artifact')?.text).toContain('retained.txt')
  expect(starts[0]!.appendInstructions).toContain('artifact')
  expect(starts[0]!.appendInstructions).toContain('LATEST_RETAINED_TURN_HANDOFF')
})

it('an acceptance failure rolls back executor, native session, choice and baton rows',async()=>{
  const f=setup(),task=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  const before=f.db.query('SELECT provider_id,session_id,execution_choice_json FROM workbench_tasks WHERE id=?').get(task.id)
  const batons=f.store.ledger.agents(task.id),notes=f.store.ledger.notes(task.id)
  f.db.exec("CREATE TRIGGER reject_test_baton BEFORE INSERT ON matter_agents WHEN NEW.executor='claude' BEGIN SELECT RAISE(ABORT,'test_acceptance_failure'); END")
  await expect(f.service.matterHandoff(task.id,'claude','接着做')).rejects.toThrow('test_acceptance_failure')
  expect(f.db.query('SELECT provider_id,session_id,execution_choice_json FROM workbench_tasks WHERE id=?').get(task.id)).toEqual(before)
  expect(f.store.ledger.agents(task.id)).toEqual(batons)
  expect(f.store.ledger.notes(task.id)).toEqual(notes)
  expect(f.starts).toHaveLength(1)
})

it('single executor create and resume retain origin/dev prompt, detail shape and main sessions',async()=>{
  const f=setup();await f.service.shutdown()
  const registry=createProviderRegistry(),starts:SpawnContext[]=[],requests:string[]=[],completedAt:string[]=[]
  registry.register('codex',{async spawn(_p,ctx){starts.push(ctx);return {async *dispatch(text){requests.push(text);yield {kind:'init',sessionId:'single-session'};yield {kind:'text',text:'EXACT_FINAL_REPLY'};yield {kind:'result',sessionId:'single-session',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const service=makeWorkbenchService({store:f.store,registry,stateDir:f.root,ownerChatId:()=>'owner',matters:f.matters,onTaskTurnCompleted:id=>{completedAt.push(f.store.get(id).status)}});cleanups.unshift(()=>service.shutdown())
  const task=service.create({path:f.project,providerId:'codex',text:'first'})
  await expect.poll(()=>service.detail(task.id).task.status).toBe('completed')
  expect(Object.keys(service.detail(task.id)).sort()).toMatchInlineSnapshot(`
    [
      "agentNames",
      "artifacts",
      "attachments",
      "continuation",
      "cursor",
      "events",
      "execution",
      "handoffs",
      "inputs",
      "lastExecution",
      "permissions",
      "questions",
      "quotaHandoff",
      "task",
      "version",
      "wechatNotifications",
    ]
  `)
  const matterDetail=await makeMattersService({store:f.matters,workbench:service,ownerChatId:()=>'owner'}).detail(task.id)
  expect(Object.keys(matterDetail).sort()).toMatchInlineSnapshot(`
    [
      "artifacts",
      "bindings",
      "events",
      "inputs",
      "matter",
      "permissions",
      "questions",
      "sessions",
      "task",
    ]
  `)
  const firstPrompt=starts[0]!.appendInstructions!
  expect(firstPrompt).toBe(beforeLedgerInstructions(task,{path:f.project},join(f.project,'.cc-workbench',task.id)))
  expect(firstPrompt).not.toContain('matter_note')
  expect(firstPrompt.endsWith('不要声称完成没有做过的检查。缺依赖、权限或信息时说明具体缺项。')).toBe(true)
  expect(service.detail(task.id)).not.toHaveProperty('agentRuns');expect(service.detail(task.id)).not.toHaveProperty('notes')
  expect(f.store.ledger.agents(task.id)).toEqual([]);expect(f.store.ledger.notes(task.id)).toEqual([])
  service.continueTask(task.id,'second')
  await expect.poll(()=>starts.length).toBe(2)
  await expect.poll(()=>service.detail(task.id).task.status).toBe('completed')
  expect(starts[1]!.appendInstructions).toBe(firstPrompt)
  expect(requests).toEqual(['first','second'])
  expect(completedAt).toEqual(['running','running'])
  expect(f.matters.sessions(task.id).every(s=>s.role==='main')).toBe(true)
  expect(service.detail(task.id)).not.toHaveProperty('agentRuns')
})

it('a provider with no notebook tools (AGY or a missing API port) is never promised them, even after truncation',async()=>{
  const f=setup(),task=f.service.create({path:f.project,providerId:'codex',text:'first'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  await f.service.matterHandoff(task.id,'claude','second')
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  const baton=f.store.ledger.agents(task.id).at(-1)!
  for(let i=0;i<25;i++)f.store.ledger.note(task.id,baton.runId,'claude',`${i}:`+'data '.repeat(150))
  await f.service.matterHandoff(task.id,'claude','third')
  await expect.poll(()=>f.requests.length).toBe(3)
  expect(f.requests[2]).toContain('[记录已截断]')
  expect(f.requests[2]).toContain('</matter_ledger_data>')
  expect(f.requests[2]).not.toMatch(/matter_notes|matter_note/)
  expect(f.starts[2]!.appendInstructions).not.toMatch(/matter_notes|matter_note/)
})


it('first handoff after several ordinary runs keeps all frozen file pointers and the latest commit',async()=>{
  const f=setup(),task=f.service.create({path:f.project,providerId:'codex',text:'first'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  const old=f.git('rev-parse','HEAD').trim()
  f.service.continueTask(task.id,'second ordinary run')
  await expect.poll(()=>f.starts.length).toBe(2)
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  const latest=f.git('rev-parse','HEAD').trim();expect(latest).not.toBe(old)
  expect(f.store.ledger.notes(task.id)).toEqual([])
  await f.service.matterHandoff(task.id,'claude','now relay')
  await expect.poll(()=>f.starts.length).toBe(3)
  const artifact=f.store.ledger.notes(task.id).find(n=>n.kind==='artifact'&&n.author==='codex')!.text
  expect(artifact).toContain(latest);expect(artifact).toContain('codex-1.txt');expect(artifact).toContain('codex-2.txt')
  expect(f.requests[2]).toContain(latest)
})


it.each(['spawn','dispatch'] as const)('an undelivered %s handoff injects the ledger on its next opening and only once',async failure=>{
  const f=setup(failure),task=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  await f.service.matterHandoff(task.id,'claude','接图')
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('failed')
  const continuation=f.service.detail(task.id).continuation!
  const options=continuation.mode==='restart_required'?{restartToken:continuation.restart.token}:undefined
  f.service.continueTask(task.id,'继续',options)
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  const received=f.requests.at(-1)!
  expect(received).toContain('深色图在 login-dark.webp')
  expect(received).toContain('artifact')
  expect(received).toContain('</matter_ledger_data>')
  expect(received).toContain('继续')
  if(failure==='spawn')expect(received).toContain('本任务此前记录')
  f.service.continueTask(task.id,'再次继续')
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  expect(f.requests.at(-1)).toBe('再次继续')
  expect(f.store.ledger.agents(task.id)).toHaveLength(2)
})

it('executor notebook reads default to a plan and recent records, page backwards by baton and bound serialized characters',()=>{
  const f=setup(),task=f.store.create({title:'paged',path:f.project,providerId:'codex',ownerChatId:'owner'}),l=f.store.ledger
  for(const [run,count]of [['r1',50],['r2',50],['r3',20]] as const){
    l.start(task.id,run,'codex',`PLAN_${run}`)
    for(let i=0;i<count;i++)l.note(task.id,run,'codex',`${run}/${i}`)
  }
  const key=`workbench/${task.id}`,page=f.service.matterNotes(key)
  expect(page.notesTotal).toBe(123)
  expect(page.notes.filter(n=>n.kind==='note')).toHaveLength(20)
  expect(page.notes.find(n=>n.kind==='plan')?.text).toContain('PLAN_r3')
  expect(page.truncated).toBe(true)
  const collected:string[]=[];let before:number|undefined
  do{
    const p=f.service.matterNotes(key,undefined,{runId:'r1',before,limit:7})
    expect(p.notesTotal).toBe(123)
    expect(p.matchedTotal).toBe(51)
    expect(p.notes.every(n=>n.runId==='r1')).toBe(true)
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(12000)
    collected.push(...p.notes.filter(n=>n.kind!=='plan').map(n=>n.text))
    before=p.nextBefore??undefined
  }while(before!==undefined)
  expect(collected).toHaveLength(50)
  expect(new Set(collected).size).toBe(50)
  expect(collected).toContain('r1/0');expect(collected).toContain('r1/49')
  l.start(task.id,'escaped','claude','PLAN_ESCAPED')
  for(let i=0;i<40;i++)l.note(task.id,'escaped','claude',`${i}:`+'"\\'.repeat(490))
  const bounded=f.service.matterNotes(key,undefined,{runId:'escaped',limit:50})
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(12000)
  expect(bounded.truncated).toBe(true)
  expect(bounded.nextBefore).not.toBeNull()
  expect(bounded.notes.some(n=>n.text.startsWith('39:'))).toBe(true)
  expect(()=>f.service.matterNotes(key,undefined,{limit:0})).toThrow('invalid_matter_notes_query')
})

it.each(['cancelled','interrupted'] as const)('first handoff preserves the prior %s baton ending',async status=>{
  const f=setup(),task=f.service.create({path:f.project,providerId:'codex',text:'先做'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  f.store.update(task.id,status)
  await f.service.matterHandoff(task.id,'claude','接着做')
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  expect(f.store.ledger.agents(task.id).map(a=>a.status)).toEqual([status,'completed'])
})


it('executor pagination crosses the real ledger route, service and store without widening scope',async()=>{
  const f=setup(),task=f.store.create({title:'routed',path:f.project,providerId:'codex',ownerChatId:'owner'})
  f.store.ledger.start(task.id,'one','codex','first')
  f.store.ledger.note(task.id,'one','codex','old')
  f.store.ledger.start(task.id,'two','claude','second')
  f.store.ledger.note(task.id,'two','claude','new')
  const handler=ledgerRoutes({workbench:f.service,resolveAdminChatId:()=>'owner'})['GET /v1/matter/notes']!
  const caller={tier:'trusted',origin:'session',sessionKey:`workbench/${task.id}`} as const
  const result=await handler(new URLSearchParams('runId=one&limit=1'),null,caller)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({notesTotal:4,matchedTotal:2,nextBefore:null,truncated:false})
  expect((result.body as {notes:Array<{text:string}>}).notes.map(n=>n.text)).toEqual(['codex: first','old'])
  expect(await handler(new URLSearchParams('runId=two&before=0'),null,caller)).toMatchObject({status:400})
  expect(await handler(new URLSearchParams('limit=1&limit=2'),null,caller)).toMatchObject({status:400})
  expect(await handler(new URLSearchParams('matter=87654321&runId=two'),null,caller)).toMatchObject({status:403})
})

it('ordinary single executor history restarts preserve the current request heading',async()=>{
  const f=setup(),task=f.service.create({path:f.project,providerId:'codex',text:'ordinary'})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  f.store.session(task.id,null)
  const continuation=f.service.detail(task.id).continuation!
  if(continuation.mode!=='restart_required')throw Error('missing restart preview')
  f.service.continueTask(task.id,'SINGLE_RESTART',{restartToken:continuation.restart.token})
  await expect.poll(()=>f.service.detail(task.id).task.status).toBe('completed')
  expect(f.requests.at(-1)?.endsWith('\n\n本轮要求：\nSINGLE_RESTART')).toBe(true)
  expect(f.requests.at(-1)).not.toContain('matter_ledger_data')
})
