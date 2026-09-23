import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore,type MatterStore} from './store'
import {makeMattersService} from './service'

let db:Db,store:MatterStore
beforeEach(()=>{db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000)})
afterEach(()=>db.close())

const TASK={id:'deadbeef',title:'整理周报',status:'running',phase:'replied',providerId:'codex',path:'/work',error:null,updatedAt:5}

describe('matters service',()=>{
  it('details a task matter with its workbench view and recent events, and says into it via continueTask',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',ownerChatId:'owner'});store.bind('deadbeef','wechat','owner');store.setStatus('deadbeef','replied')
    let task=TASK
    const workbench={detail:vi.fn(()=>({task,events:[{kind:'text',text:'做好了',createdAt:3}]})),continueTask:vi.fn(()=>(task={...TASK,phase:'working'}))}
    const service=makeMattersService({store,workbench})
    const detail=await service.detail('deadbeef')
    expect(detail.matter.id).toBe('deadbeef');expect(detail.task).toEqual(TASK);expect(detail.events).toEqual([{kind:'text',text:'做好了',createdAt:3}])
    expect(detail.bindings.map(b=>b.surface)).toEqual(['wechat']);expect(detail.sessions).toEqual([])
    await expect(service.say('deadbeef','再改一版')).resolves.toEqual({kind:'task',task:{...TASK,phase:'working'}})
    expect(workbench.continueTask).toHaveBeenCalledWith('deadbeef','再改一版')
    expect(store.get('deadbeef')?.status).toBe('open')
  })

  it('says into the owner chat matter through the app conversation channel (with the surface), shows the shared message stream, and refuses other chats',async()=>{
    const mine=store.ensureChat('owner-chat'),other=store.ensureChat('guest-chat')
    const say=vi.fn(async()=>({reply:'在呢'}))
    const recent=vi.fn(async(chatId:string)=>chatId==='owner-chat'?[{kind:'text',text:'晚点回',createdAt:5,source:'live'},{kind:'user',text:'在吗',createdAt:4,source:'phone'}]:[])
    const service=makeMattersService({store,chat:{ownerChatId:()=>'owner-chat',say,recent}})
    await expect(service.say(mine.id,'在吗','phone')).resolves.toEqual({kind:'chat',reply:'在呢'})
    expect(say).toHaveBeenCalledWith('在吗','phone')
    // 微信 / 桌面 / 手机三处的话进同一条流,详情按时间升序给回来
    const detail=await service.detail(mine.id)
    expect(detail.events.map(e=>[e.kind,e.text,e.source])).toEqual([['user','在吗','phone'],['text','晚点回','live']])
    expect(recent).toHaveBeenCalledWith('owner-chat',50)
    await expect(service.say(other.id,'在吗')).rejects.toThrow('matter_say_unsupported')
  })

  it('fails closed on bad ids, empty text and missing wiring',async()=>{
    const service=makeMattersService({store})
    await expect(service.detail('nope')).rejects.toThrow('invalid_matter_id')
    await expect(service.detail('00000000')).rejects.toThrow('matter_not_found')
    store.create({id:'00000001',kind:'task',title:'t'})
    await expect(service.say('00000001','  ')).rejects.toThrow('invalid_text')
    await expect(service.say('00000001','x')).rejects.toThrow('workbench_not_wired')
    const chat=store.ensureChat('c');await expect(service.say(chat.id,'x')).rejects.toThrow('chat_not_wired')
    store.create({id:'00000002',kind:'companion',title:'心愿'})
    await expect(service.say('00000002','x')).rejects.toThrow('matter_say_unsupported')
  })

  it('keeps a task matter readable when its workbench record is gone',async()=>{
    store.create({id:'00000003',kind:'task',title:'t'})
    const service=makeMattersService({store,workbench:{detail:()=>{throw new Error('not_found')},continueTask:()=>TASK}})
    await expect(service.detail('00000003')).resolves.toMatchObject({task:null,events:[]})
  })
})

describe('ownerChat (三个入口看同一段对话)',()=>{
  it('ensures the owner chat matter, binds the calling surface and returns its detail; null without an owner',async()=>{
    const recent=vi.fn(async()=>[{kind:'user',text:'在吗',createdAt:1,source:'live'}])
    const service=makeMattersService({store,chat:{ownerChatId:()=>'owner-chat',say:async()=>({reply:'x'}),recent}})
    const d=await service.ownerChat('desktop')
    expect(d?.matter.kind).toBe('chat');expect(d?.bindings.map(b=>b.surface).sort()).toEqual(['desktop','wechat']);expect(d?.events).toHaveLength(1)
    expect((await service.ownerChat('phone'))?.matter.id).toBe(d?.matter.id)
    expect(await makeMattersService({store,chat:{ownerChatId:()=>null,say:async()=>({reply:'x'})}}).ownerChat('desktop')).toBeNull()
  })
})
