import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openTestDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentProvider,SpawnContext} from '../agent-provider'

let db:Db,root:string,project:string,service:WorkbenchService
const result:AgentEvent={kind:'result',sessionId:'native-one',numTurns:1,durationMs:1}
const call:AgentEvent={kind:'tool_call',tool:'Read',activity:{id:'item-1',type:'read',label:'读取文件',status:'running'}}
function setup(provider:AgentProvider){
  const registry=createProviderRegistry();registry.register('codex',provider,{displayName:'Codex',canResume:()=>true})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null})
}
const create=()=>service.create({path:project,providerId:'codex',text:'check local files'})
const settle=async(id:string)=>expect.poll(()=>service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)
beforeEach(()=>{db=openTestDb();root=realpathSync(mkdtempSync(join(tmpdir(),'cc-timeline-')));project=join(root,'project');mkdirSync(project)})
afterEach(async()=>{await service?.shutdown();db.close();rmSync(root,{recursive:true,force:true})})

describe('task execution timeline integration',()=>{
  it('opts in to workbench events and persists updates at first arrival with a common run ID',async()=>{
    let context:SpawnContext|undefined
    setup({async spawn(_project,ctx){context=ctx;return {async *dispatch(){
      yield {kind:'text',text:'先检查。'} as AgentEvent
      yield call
      yield {kind:'text',itemId:'reply',textMode:'append',text:'发现'} as AgentEvent
      yield {...call,activity:{...call.activity!,status:'completed'}} as AgentEvent
      yield {kind:'text',itemId:'reply',textMode:'replace',text:'发现原因。'} as AgentEvent
      yield result
    },async close(){}}}})
    const task=create();await settle(task.id)
    expect(context?.workbenchTimeline).toBe(true)
    const rows=service.detail(task.id).events
    expect(rows.map(e=>e.kind)).toEqual(['user','text','tool_call','text'])
    expect(rows.map(e=>e.text)).toEqual(['check local files','先检查。','读取文件','发现原因。'])
    expect(new Set(rows.map(e=>e.runId)).size).toBe(1)
    expect(rows[0]?.runId).toEqual(expect.any(String))
    expect(rows[2]?.activity?.status).toBe('completed')
  })

  it('does not label a missing tool completion successful even when the reply turn completes',async()=>{
    setup({async spawn(){return{async *dispatch(){yield call;yield result},async close(){}}}})
    const task=create();await settle(task.id)
    expect(service.detail(task.id).task.status).toBe('completed')
    expect(service.detail(task.id).events.find(e=>e.kind==='tool_call')?.activity?.status).toBe('interrupted')
  })

  it('marks an in-flight activity cancelled and preserves prior replies when stopped',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    setup({async spawn(){return{async *dispatch(){yield {kind:'text',text:'开始检查。'} as AgentEvent;yield call;await gate;yield result},async close(){release()}}}})
    const task=create();await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='tool_call')).toBe(true)
    await service.cancel(task.id);await settle(task.id)
    expect(service.detail(task.id).task.status).toBe('cancelled')
    expect(service.detail(task.id).events.find(e=>e.kind==='tool_call')?.activity?.status).toBe('cancelled')
    expect(service.detail(task.id).events.find(e=>e.kind==='text')?.text).toBe('开始检查。')
  })

  it.each(['cancelled','completed'] as const)('retains timeline run identity until delayed close ends a %s run without accepting more input',async ending=>{
    let releaseTurn!:()=>void,releaseClose!:()=>void,closing=false
    const turnGate=new Promise<void>(resolve=>{releaseTurn=resolve})
    const closeGate=new Promise<void>(resolve=>{releaseClose=resolve})
    setup({async spawn(){return{
      async *dispatch(){yield call;await turnGate;yield result},
      async close(){closing=true;await closeGate;releaseTurn()},
    }}})
    const task=create()
    try {
      await expect.poll(()=>service.detail(task.id).events.some(e=>e.kind==='tool_call')).toBe(true)
      const runId=service.detail(task.id).runId!
      expect(runId).toEqual(expect.any(String))
      expect(service.detail(task.id).inputMode).toBe('queue')
      if(ending==='cancelled')await service.cancel(task.id)
      else releaseTurn()
      await expect.poll(()=>closing).toBe(true)
      const closingDetail=service.detail(task.id)
      expect(closingDetail.task.status).toBe(ending==='cancelled'?'cancelling':'running')
      expect(closingDetail.runId).toBe(runId)
      expect(closingDetail.inputMode).toBeUndefined()
      await expect(service.submitInput(task.id,{runId,requestId:'00000000-0000-4000-8000-000000000000',text:'too late'})).rejects.toThrow('input_stale')
      releaseClose();await settle(task.id)
      expect(service.detail(task.id).task.status).toBe(ending)
      expect(service.detail(task.id).runId).toBeUndefined()
    } finally {releaseClose();releaseTurn()}
  })
})
