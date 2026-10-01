import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from './store'
import {makeMattersService} from './service'

// spec 2026-10-01-tendhearth-continue-sessions D5 / D12:手机接过来的电脑会话,第一句与详情。
let db:Db,store:MatterStore
beforeEach(()=>{db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000)})
afterEach(()=>db.close())

const ID='cafebabe',REQ='5a7e0000-0000-4000-8000-000000000001',RUN='5a7e0000-0000-4000-8000-0000000000aa'
const TASK={id:ID,title:'原会话',status:'interrupted',providerId:'codex',path:'/work',error:null,updatedAt:5}

function imported(mode:'resume'|'restart_required'='resume'){
  store.create({id:ID,kind:'task',title:'原会话',projectPath:'/work',ownerChatId:'owner'})
  let detail:any={task:TASK,events:[],requiresExternalClose:true,continuation:{mode},inputs:[]}
  const continueImported=vi.fn(async(_id:string,text:string,options:{inputRequestId?:string})=>{
    detail={task:{...TASK,status:'queued'},events:[],runId:RUN,inputs:options.inputRequestId?[{id:options.inputRequestId,taskId:ID,runId:RUN,text,status:'sending'}]:[]}
    return detail.task
  })
  const workbench={detail:vi.fn(()=>detail),continueTask:vi.fn(()=>{throw new Error('external_close_confirmation_required')}),continueImported}
  return {workbench,continueImported,service:makeMattersService({store,workbench})}
}

describe('「一件事」· 接过来的电脑会话',()=>{
  it('手机说第一句 ⇒ continueImported(带 requestId 与 owner 策略),回执照旧;不走 continueTask',async()=>{
    const {workbench,continueImported,service}=imported()
    const r=await service.say(ID,'接着改','phone',{requestId:REQ})
    expect(continueImported).toHaveBeenCalledWith(ID,'接着改',{inputRequestId:REQ},'owner')
    expect(workbench.continueTask).not.toHaveBeenCalled()
    expect(r).toEqual({kind:'task',task:{...TASK,status:'queued'},input:{id:REQ,taskId:ID,runId:RUN,text:'接着改',status:'sending'}})
    expect(store.get(ID)?.status).toBe('open')
  })
  it('桌面 / 没有 surface ⇒ 照旧 continueTask(409 external_close_confirmation_required 不被绕过)',async()=>{
    const {continueImported,service}=imported()
    await expect(service.say(ID,'接着改','desktop')).rejects.toThrow('external_close_confirmation_required')
    await expect(service.say(ID,'接着改')).rejects.toThrow('external_close_confirmation_required')
    expect(continueImported).not.toHaveBeenCalled()
  })
  it('手机但工作台没接 continueImported ⇒ 落回原路径(仍是 409)',async()=>{
    const {workbench}=imported()
    const service=makeMattersService({store,workbench:{detail:workbench.detail,continueTask:workbench.continueTask}})
    await expect(service.say(ID,'接着改','phone',{requestId:REQ})).rejects.toThrow('external_close_confirmation_required')
  })
  it('详情:还没发第一句 ⇒ nativeStart(能恢复 ⇒ native_resume);发过之后没有',async()=>{
    const {service}=imported('resume')
    expect((await service.detail(ID)).nativeStart).toEqual({mode:'native_resume',providerId:'codex'})
    await service.say(ID,'接着改','phone',{requestId:REQ})
    expect((await service.detail(ID)).nativeStart).toBeUndefined()
  })
  it('详情:原会话恢复不了 ⇒ nativeStart.mode = fresh_context',async()=>{
    const {service}=imported('restart_required')
    expect((await service.detail(ID)).nativeStart).toEqual({mode:'fresh_context',providerId:'codex'})
  })
})
