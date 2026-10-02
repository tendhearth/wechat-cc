import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from './store'
import {makeMattersService} from './service'

// spec 2026-10-01-tendhearth-continue-sessions §7-3:额度用完 ⇒ 手机问「交给 X 继续?」。
let db:Db,store:MatterStore
beforeEach(()=>{db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000)})
afterEach(()=>db.close())

const ID='cafebabe',NEW='deadbeef',REQ='5a7e0000-0000-4000-8000-000000000001'
const TASK={id:ID,title:'修登录页',status:'failed',providerId:'claude',path:'/work',error:'provider_quota_exhausted',updatedAt:5}

function setup(view:unknown={state:'offer',from:'claude',to:'codex',kind:'quota',resetAt:9_000}){
  store.create({id:ID,kind:'task',title:'修登录页',projectPath:'/work',ownerChatId:'owner'})
  const handOff=vi.fn((_id:string,_input:{requestId:string;providerId:string})=>{
    if(!store.get(NEW))store.create({id:NEW,kind:'task',title:'修登录页',projectPath:'/work',ownerChatId:'owner'})
    return {taskId:NEW,created:true}
  })
  const workbench={detail:vi.fn(()=>({task:TASK,events:[]})),continueTask:vi.fn(),quotaHandoff:vi.fn(()=>view),handOff}
  return {workbench,handOff,service:makeMattersService({store,workbench:workbench as never})}
}

describe('「一件事」· 额度用完交给另一位',()=>{
  it('详情带 quotaHandoff(工作台说有才有)',async()=>{
    const {service}=setup()
    expect((await service.detail(ID)).quotaHandoff).toEqual({state:'offer',from:'claude',to:'codex',kind:'quota',resetAt:9_000})
  })
  it('工作台说没有 / 没接这一块 / 抛了 ⇒ 详情不带(详情本身照旧)',async()=>{
    expect((await setup(null).service.detail(ID)).quotaHandoff).toBeUndefined()
    db.close();db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000)
    store.create({id:ID,kind:'task',title:'t',projectPath:'/work',ownerChatId:'owner'})
    const plain=makeMattersService({store,workbench:{detail:()=>({task:TASK,events:[]}),continueTask:vi.fn()} as never})
    expect((await plain.detail(ID)).quotaHandoff).toBeUndefined()
    const throwing=makeMattersService({store,workbench:{detail:()=>({task:TASK,events:[]}),continueTask:vi.fn(),quotaHandoff:()=>{throw Error('x')}} as never})
    const d=await throwing.detail(ID)
    expect(d.quotaHandoff).toBeUndefined();expect(d.task).toEqual(TASK)
  })
  it('handoff:转给工作台(requestId 小写、providerId 原样),回新那件的 matterId;从手机来 ⇒ 新那件记手机露面',async()=>{
    const {service,handOff}=setup()
    expect(await service.handoff(ID,{requestId:REQ.toUpperCase(),providerId:'codex'},'phone')).toEqual({matterId:NEW,created:true})
    expect(handOff).toHaveBeenCalledWith(ID,{requestId:REQ,providerId:'codex'})
    expect(store.bindings(NEW).map(b=>b.surface)).toContain('phone')
  })
  it('handoff:不是任务 / 工作台没接 / 坏 requestId ⇒ 对应错误码',async()=>{
    const {service}=setup()
    store.create({id:'abcdef01',kind:'chat',title:'聊天',ownerChatId:'owner'})
    await expect(service.handoff('abcdef01',{requestId:REQ,providerId:'codex'})).rejects.toThrow('matter_task_required')
    await expect(service.handoff(ID,{requestId:'nope',providerId:'codex'})).rejects.toThrow('invalid_request')
    const bare=makeMattersService({store,workbench:{detail:()=>({task:TASK,events:[]}),continueTask:vi.fn()} as never})
    await expect(bare.handoff(ID,{requestId:REQ,providerId:'codex'})).rejects.toThrow('workbench_not_wired')
  })
})
