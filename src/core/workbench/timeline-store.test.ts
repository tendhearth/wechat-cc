import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openTestDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import type {AgentActivity} from '../agent-provider'

let db:Db,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{db=openTestDb();store=makeWorkbenchStore(db)})
afterEach(()=>db.close())
const activity:AgentActivity={id:'native-item',type:'read',label:'读取文件',status:'running'}
const create=()=>store.create({title:'timeline',path:'/tmp/timeline',providerId:'codex',ownerChatId:null}).id

describe('durable ordered execution timeline',()=>{
  it('updates an operation where it first arrived, between the original replies',()=>{
    const id=create()
    store.recordAgentEvent(id,'run-1',{kind:'text',text:'先检查输入。'})
    store.recordAgentEvent(id,'run-1',{kind:'tool_call',tool:'Read',activity})
    const first=store.events(id)[1]!
    store.recordAgentEvent(id,'run-1',{kind:'text',text:'找到原因。'})
    store.recordAgentEvent(id,'run-1',{kind:'tool_call',tool:'Read',activity:{...activity,status:'completed',detail:'README.md'}})
    const rows=store.events(id)
    expect(rows.map(row=>row.kind)).toEqual(['text','tool_call','text'])
    expect(rows[1]).toMatchObject({id:first.id,createdAt:first.createdAt,runId:'run-1',activity:{...activity,status:'completed',detail:'README.md'}})
  })

  it('appends streamed text but replaces it with authoritative final text, without duplicate replies',()=>{
    const id=create()
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'msg-1',textMode:'append',text:'正在'})
    const first=store.events(id)[0]!
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'msg-1',textMode:'append',text:'检查'})
    expect(store.events(id)[0]?.text).toBe('正在检查')
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'msg-1',textMode:'replace',text:'检查好了。'})
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'msg-1',textMode:'replace',text:'检查好了。'})
    expect(store.events(id)).toHaveLength(1)
    expect(store.events(id)[0]).toMatchObject({id:first.id,text:'检查好了。'})
  })

  it('separates identical native IDs across tasks, runs and event types',()=>{
    const a=create(),b=create()
    for(const [taskId,run] of [[a,'run-1'],[a,'run-2'],[b,'run-1']] as const)
      store.recordAgentEvent(taskId,run,{kind:'tool_call',tool:'Read',activity})
    store.recordAgentEvent(a,'run-1',{kind:'text',itemId:activity.id,textMode:'replace',text:'独立的回复'})
    store.recordAgentEvent(a,'run-1',{kind:'tool_call',tool:'Read',activity:{...activity,status:'failed'}})
    expect(store.events(a).map(row=>[row.kind,row.runId,row.activity?.status])).toEqual([
      ['tool_call','run-1','failed'],['tool_call','run-2','running'],['text','run-1',undefined],
    ])
    expect(store.events(b)[0]?.activity?.status).toBe('running')
  })

  it('settles only unfinished activities of the ended run, without inventing success',()=>{
    const id=create()
    for(const run of ['completed-run','cancelled-run','still-running']) {
      store.recordAgentEvent(id,run,{kind:'tool_call',tool:'Read',activity})
      store.recordAgentEvent(id,run,{kind:'tool_call',tool:'Bash',activity:{...activity,id:'done',status:'completed'}})
    }
    store.finishRunActivities(id,'completed-run','interrupted')
    store.finishRunActivities(id,'cancelled-run','cancelled')
    expect(store.events(id).map(row=>row.activity?.status)).toEqual(['interrupted','completed','cancelled','completed','running','completed'])
  })

  it('keeps legacy rows readable and clears unconfirmed running activity on restart',()=>{
    const id=create()
    store.addEvent(id,'tool_call','legacy Read')
    expect(store.events(id)[0]).not.toHaveProperty('activity')
    expect(store.events(id)[0]).not.toHaveProperty('runId')
    store.recordAgentEvent(id,'run-1',{kind:'tool_call',tool:'Read',activity})
    store.update(id,'running');store.recover()
    expect(store.get(id).status).toBe('interrupted')
    expect(store.events(id)[1]?.activity?.status).toBe('interrupted')
  })

  it('caps accumulated text and persists only declared bounded activity fields',()=>{
    const id=create()
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'long',textMode:'append',text:'x'.repeat(30_000)})
    store.recordAgentEvent(id,'run-1',{kind:'text',itemId:'long',textMode:'append',text:'x'.repeat(30_000)})
    store.recordAgentEvent(id,'run-1',{kind:'tool_call',tool:'Read',activity:{...activity,detail:'y'.repeat(3000),rawArguments:{password:'do-not-store'}} as AgentActivity})
    expect(store.events(id)[0]?.text).toHaveLength(40_000)
    expect(store.events(id)[1]?.activity?.detail?.length).toBeLessThanOrEqual(2000)
    expect(JSON.stringify(store.events(id))).not.toContain('do-not-store')
  })
})
