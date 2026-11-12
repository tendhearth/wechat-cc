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
function setup(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-ledger-'))),project=join(root,'project');mkdirSync(project)
  const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{encoding:'utf8'})
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test')
  writeFileSync(join(project,'seed.txt'),'before');git('add','.');git('commit','-m','seed')
  const db=openTestDb(),store=makeWorkbenchStore(db),matters=makeMatterStore(db),registry=createProviderRegistry()
  const starts:SpawnContext[]=[]
  let service:WorkbenchService
  for(const executor of ['codex','claude'])registry.register(executor,{async spawn(_p,ctx){
    starts.push(ctx)
    return {async *dispatch(){
      yield {kind:'init' as const,sessionId:`${executor}-session`}
      yield {kind:'text' as const,itemId:'raw',text:'RAW_TRANSCRIPT_CANARY private tool reasoning'}
      if(executor==='codex'){
        writeFileSync(join(project,'login-dark.webp'),'synthetic bytes')
        writeFileSync(join(project,'.cc-workbench',ctx.workbenchTaskId!,'portrait.txt'),'ARTIFACT_BODY_CANARY')
        git('add','.');git('commit','-m','image')
        service.matterNote(`workbench/${ctx.workbenchTaskId}`,'深色图在 login-dark.webp')
      }
      yield {kind:'text' as const,itemId:'final',text:`${executor} 最终交接回复`}
      yield {kind:'result' as const,sessionId:`${executor}-session`,numTurns:1,durationMs:1}
    },async close(){}}
  }},{displayName:executor,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>'owner',matters})
  cleanups.push(async()=>{await service.shutdown();db.close();removeTempDir(root)})
  return {root,project,git,db,store,service,starts,matters}
}

it('two fake executors share one matter and workspace; the second receives notes and metadata, never the first transcript',async()=>{
  const f=setup(),first=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  const notes=f.store.ledger.notes(first.id)
  expect(notes.filter(n=>n.kind==='note').map(n=>n.text)).toEqual(['深色图在 login-dark.webp'])
  expect(notes.find(n=>n.kind==='artifact')?.text).toContain('portrait.txt')
  expect(JSON.stringify(notes)).not.toContain('ARTIFACT_BODY_CANARY')
  expect(notes.find(n=>n.kind==='artifact')?.text).toContain(f.git('rev-parse','HEAD').trim())
  const next=await f.service.matterHandoff(first.id,'claude','把插图接进登录页')
  expect(next.id).toBe(first.id);expect(next.path).toBe(f.project)
  await expect.poll(()=>f.starts.length).toBe(2)
  expect(f.starts[1]!.resumeSessionId).toBeUndefined()
  expect(f.starts[1]!.appendInstructions).toContain('深色图在 login-dark.webp')
  expect(f.starts[1]!.appendInstructions).toContain('artifact')
  expect(f.starts[1]!.appendInstructions).toContain(f.project)
  expect(f.starts[1]!.appendInstructions).not.toContain('RAW_TRANSCRIPT_CANARY')
  await expect.poll(()=>f.service.detail(first.id).task.status).toBe('completed')
  expect(f.store.ledger.agents(first.id).map(a=>[a.executor,a.status])).toEqual([['codex','completed'],['claude','completed']])
  expect(f.store.ledger.notes(first.id).filter(n=>n.kind==='note').at(-1)?.text).toBe('claude 最终交接回复')
  expect(f.matters.list({kind:'task'})).toHaveLength(1)
  expect(f.matters.sessions(first.id).find(s=>s.providerId==='claude')?.role).toBe('handoff')
})

it('executor tools resolve the bound matter and reject another matter or forged author',async()=>{
  const f=setup(),a=f.service.create({path:f.project,providerId:'codex',text:'出图'})
  await expect.poll(()=>f.service.detail(a.id).task.status).toBe('completed')
  const b=f.store.create({title:'other',path:'/other',providerId:'claude',ownerChatId:'owner'})
  f.store.ledger.start(b.id,'other-run','claude','secret')
  expect(()=>f.service.matterNotes(`workbench/${a.id}`,b.id)).toThrow('matter_scope_mismatch')
  expect(f.service.matterNotes(`workbench/${a.id}`).every(n=>n.matterId===a.id)).toBe(true)
  expect(()=>f.service.matterNote('chat/owner','forged')).toThrow('forbidden')
})

it('retained idle baton records completion and closes before the next writer starts',async()=>{
  const f=setup();await f.service.shutdown()
  const registry=createProviderRegistry(),queue=new AsyncQueue<AgentEvent>(),order:string[]=[],starts:SpawnContext[]=[]
  let snapshot:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  let service:WorkbenchService
  const runtime:AgentWorkbenchRuntime={events:queue.iterable(),snapshot:()=>snapshot,start(){
    queue.push({kind:'init',sessionId:'retained-first'})
    service.matterNote(`workbench/${task.id}`,'接着用 retained.txt')
    writeFileSync(join(f.project,'retained.txt'),'ready')
    queue.push({kind:'text',itemId:'final',text:'第一棒完成'})
    snapshot={...snapshot,foreground:'idle'}
    queue.push({kind:'result',sessionId:'retained-first',numTurns:1,durationMs:1})
  },async submit(){}}
  registry.register('codex',{async spawn(){return {workbenchRuntime:runtime,async *dispatch(){},async close(){order.push('closed');queue.end()}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('claude',{async spawn(_p,ctx){order.push('next');starts.push(ctx);return {async *dispatch(){yield {kind:'result',sessionId:'second',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:f.store,registry,stateDir:f.root,ownerChatId:()=>'owner',matters:f.matters})
  cleanups.unshift(()=>service.shutdown())
  const task=service.create({path:f.project,providerId:'codex',text:'先做'})
  await expect.poll(()=>f.store.ledger.agents(task.id)[0]?.status).toBe('completed')
  expect(f.store.ledger.notes(task.id).find(n=>n.kind==='artifact')?.text).toContain('retained.txt')
  snapshot={...snapshot,foreground:'running'}
  queue.push({kind:'text',itemId:'second-start',text:'第二轮正在做'})
  await expect.poll(()=>f.store.ledger.agents(task.id)[0]?.status).toBe('running')
  snapshot={...snapshot,foreground:'idle'}
  queue.push({kind:'text',itemId:'second-final',text:'LATEST_RETAINED_TURN_HANDOFF'})
  queue.push({kind:'result',sessionId:'retained-first',numTurns:2,durationMs:1})
  await expect.poll(()=>f.store.ledger.notes(task.id).some(n=>n.text==='LATEST_RETAINED_TURN_HANDOFF')).toBe(true)
  await service.matterHandoff(task.id,'claude','接着做')
  await expect.poll(()=>order).toEqual(['closed','next'])
  expect(starts[0]!.appendInstructions).toContain('接着用 retained.txt')
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
