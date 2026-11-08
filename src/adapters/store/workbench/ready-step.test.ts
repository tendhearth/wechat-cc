import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openTestDb,type Db} from '../../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeMatterLog} from '../matter-log'
import {makeMatterStore,LEGACY_STATUS_INPUTS_SQL} from '../matters-store'
import {isReadyStep,latestTurnReady,readyStepKey} from '../../../domain/matters/ready-step'

/**
 * M6e 前半:settleQuiet 写 replied 时同时在最近一轮上落一步 ready:<turnId>(store.markReady)。
 * 幂等、主人看不见(时间线投影 / 步列表都滤掉)、新一轮开始自然不算;TS 与 SQL 两份「最近一轮有没有」一致。
 */
let db:Db,store:ReturnType<typeof makeWorkbenchStore>,log:ReturnType<typeof makeMatterLog>
beforeEach(()=>{db=openTestDb();store=makeWorkbenchStore(db);log=makeMatterLog(db)})
afterEach(()=>db.close())
const create=()=>store.create({title:'ready',path:'/tmp/ready',providerId:'claude',ownerChatId:null}).id
const readyRows=(id:string)=>db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM matter_items WHERE matter_id=? AND item_key LIKE 'ready:%'").get(id)!.n
const sqlReady=(id:string)=>!!db.query<{latest_ready:number},[string]>(`SELECT latest_ready FROM (${LEGACY_STATUS_INPUTS_SQL}) WHERE id=?`).get(id)!.latest_ready
const tsReady=(id:string)=>latestTurnReady(log.turns(id),log.items(id))

describe('ready 步(M6e 前半)',()=>{
  it('最近一轮已收 ⇒ 写一步 system / ready:<turnId> / {ready:true};再调不写第二行、不推进游标、不动版本号',()=>{
    const id=create()
    store.addEvent(id,'user','做一下')
    const turn=log.startTurn({matterId:id,executor:'claude'})
    log.finishTurn(turn.id,{status:'completed'})
    const version=store.version(id)
    expect(store.markReady(id)).toBe(true)
    const step=log.item(id,readyStepKey(turn.id))!
    expect(step).toMatchObject({kind:'system',status:'completed',turnId:turn.id,payload:{ready:true}})
    expect(isReadyStep(step)).toBe(true)
    const cursor=store.feed.cursor(id)
    expect(store.markReady(id)).toBe(false)
    expect(store.markReady(id)).toBe(false)
    expect(readyRows(id)).toBe(1)
    expect(store.feed.cursor(id)).toBe(cursor)
    expect(store.version(id)).toBe(version)
    expect(tsReady(id)).toBe(true)
    expect(sqlReady(id)).toBe(true)
  })
  it('一轮都没有 / 最近一轮还在跑 / 没收成 ⇒ 不写',()=>{
    const id=create()
    expect(store.markReady(id)).toBe(false)
    const running=log.startTurn({matterId:id,executor:'claude'})
    expect(store.markReady(id)).toBe(false)
    log.finishTurn(running.id,{status:'failed'})
    expect(store.markReady(id)).toBe(false)
    expect(readyRows(id)).toBe(0)
    expect(tsReady(id)).toBe(false)
    expect(sqlReady(id)).toBe(false)
  })
  it('新一轮开始 ⇒ 不算 ready(最近一轮换了),旧那一步留着;新一轮收了再写一步',()=>{
    const id=create()
    const first=log.startTurn({matterId:id,executor:'claude'});log.finishTurn(first.id,{status:'completed'})
    store.markReady(id)
    const second=log.startTurn({matterId:id,executor:'claude'})
    expect(tsReady(id)).toBe(false)
    expect(sqlReady(id)).toBe(false)
    log.finishTurn(second.id,{status:'completed'})
    expect(tsReady(id)).toBe(false)
    expect(sqlReady(id)).toBe(false)
    expect(store.markReady(id)).toBe(true)
    expect(readyRows(id)).toBe(2)
    expect(tsReady(id)).toBe(true)
    expect(sqlReady(id)).toBe(true)
  })
  it('主人看不见:WorkbenchTaskEvent 投影(含 ?since= 与 since_cursor)、步列表都滤掉;统一状态不动',()=>{
    const id=create()
    store.addEvent(id,'user','做一下')
    const turn=log.startTurn({matterId:id,executor:'claude'})
    store.recordAgentEvent(id,'run-1',{kind:'text',text:'好了'})
    log.finishTurn(turn.id,{status:'completed'})
    const before={events:store.events(id),steps:store.steps(id),since:store.events(id,0),state:log.state(id)}
    const cursor=store.feed.cursor(id)
    store.markReady(id)
    expect(store.events(id)).toEqual(before.events)
    expect(store.events(id,0)).toEqual(before.since)
    expect(store.events(id,undefined,cursor)).toEqual([])
    expect(store.steps(id)).toEqual(before.steps)
    expect(store.detail(id).events).toEqual(before.events)
    expect(log.state(id)).toEqual(before.state)
    // 步本身在库里(MatterLog.items 原样给,出口负责滤)
    expect(log.items(id).filter(isReadyStep)).toHaveLength(1)
  })
  it('线上旧 status 的 replied 读 ready 步(M6e,v102 删列):最近一轮已收、没有 ready 步 ⇒ open;markReady 之后 ⇒ replied',()=>{
    const id=create()
    db.query("UPDATE workbench_tasks SET status='running' WHERE id=?").run(id)
    const turn=log.startTurn({matterId:id,executor:'claude'});log.finishTurn(turn.id,{status:'completed'})
    const matters=makeMatterStore(db)
    expect(matters.legacyStatuses([id]).get(id)).toBe('open')
    expect(matters.list({legacy:['replied']})).toEqual([])
    store.markReady(id)
    expect(matters.legacyStatuses([id]).get(id)).toBe('replied')
    expect(matters.list({legacy:['replied']}).map(m=>m.id)).toEqual([id])
  })
})
