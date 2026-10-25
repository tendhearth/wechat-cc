import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from '../../adapters/store/matters-store'
import {makeMattersService} from './service'

// 收敛清单 ⑥:执行者叫什么只由 daemon 定 —— 一件事带 agentNames(id → 正式名字),三端不存名字表。
let db:Db,store:MatterStore
beforeEach(()=>{db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000)})
afterEach(()=>db.close())

const ID='cafebabe'
const TASK={id:ID,title:'修登录页',status:'failed',providerId:'claude',path:'/work',error:'provider_quota_exhausted',updatedAt:5}
const NAMES:Record<string,string>={claude:'Claude',codex:'Codex',agy:'Gemini(账号)'}
const executorName=(id:string)=>NAMES[id]??id

describe('「一件事」· 执行者名字(agentNames)',()=>{
  it('列表:参与过的每家带上名字;没参与过谁的那件不带',()=>{
    store.create({id:ID,kind:'task',title:'t',projectPath:'/work',ownerChatId:'owner'})
    store.create({id:'deadbeef',kind:'task',title:'u',projectPath:'/work',ownerChatId:'owner'})
    store.addSession(ID,'agy','s1','main');store.addSession(ID,'codex','s2','review')
    const rows=makeMattersService({store,executorName}).list()
    const named=rows.find(m=>m.id===ID)!
    expect(named.agentNames).toEqual({agy:'Gemini(账号)',codex:'Codex'})
    expect(rows.find(m=>m.id==='deadbeef')!.agentNames).toBeUndefined()
  })
  it('详情:任务那一家、交接两头都带上名字',async()=>{
    store.create({id:ID,kind:'task',title:'t',projectPath:'/work',ownerChatId:'owner'})
    const workbench={detail:vi.fn(()=>({task:TASK,events:[]})),continueTask:vi.fn(),quotaHandoff:vi.fn(()=>({state:'offer',from:'claude',to:'codex',kind:'quota',resetAt:9}))}
    const d=await makeMattersService({store,workbench:workbench as never,executorName}).detail(ID)
    expect(d.matter.agentNames).toEqual({claude:'Claude',codex:'Codex'})
  })
  it('没接名字(老接线)⇒ 不带 agentNames,界面退回 id',async()=>{
    store.create({id:ID,kind:'task',title:'t',projectPath:'/work',ownerChatId:'owner'})
    store.addSession(ID,'codex','s2','main')
    const service=makeMattersService({store})
    expect(service.list()[0]!.agentNames).toBeUndefined()
    expect((await service.detail(ID)).matter.agentNames).toBeUndefined()
  })
})
