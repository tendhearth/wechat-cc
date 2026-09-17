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
    const workbench={detail:vi.fn(()=>({task:TASK,events:[{kind:'text',text:'做好了',createdAt:3}]})),continueTask:vi.fn(()=>({...TASK,phase:'working'}))}
    const service=makeMattersService({store,workbench})
    const detail=service.detail('deadbeef')
    expect(detail.matter.id).toBe('deadbeef');expect(detail.task).toEqual(TASK);expect(detail.events).toEqual([{kind:'text',text:'做好了',createdAt:3}])
    expect(detail.bindings.map(b=>b.surface)).toEqual(['wechat']);expect(detail.sessions).toEqual([])
    await expect(service.say('deadbeef','再改一版')).resolves.toEqual({kind:'task',task:{...TASK,phase:'working'}})
    expect(workbench.continueTask).toHaveBeenCalledWith('deadbeef','再改一版')
    expect(store.get('deadbeef')?.status).toBe('open')
  })

  it('says into the owner chat matter through the app conversation channel, and refuses other chats',async()=>{
    const mine=store.ensureChat('owner-chat'),other=store.ensureChat('guest-chat')
    const say=vi.fn(async()=>({reply:'在呢'}))
    const service=makeMattersService({store,chat:{ownerChatId:()=>'owner-chat',say}})
    await expect(service.say(mine.id,'在吗')).resolves.toEqual({kind:'chat',reply:'在呢'})
    expect(say).toHaveBeenCalledWith('在吗')
    await expect(service.say(other.id,'在吗')).rejects.toThrow('matter_say_unsupported')
  })

  it('fails closed on bad ids, empty text and missing wiring',async()=>{
    const service=makeMattersService({store})
    expect(()=>service.detail('nope')).toThrow('invalid_matter_id')
    expect(()=>service.detail('00000000')).toThrow('matter_not_found')
    store.create({id:'00000001',kind:'task',title:'t'})
    await expect(service.say('00000001','  ')).rejects.toThrow('invalid_text')
    await expect(service.say('00000001','x')).rejects.toThrow('workbench_not_wired')
    const chat=store.ensureChat('c');await expect(service.say(chat.id,'x')).rejects.toThrow('chat_not_wired')
    store.create({id:'00000002',kind:'companion',title:'心愿'})
    await expect(service.say('00000002','x')).rejects.toThrow('matter_say_unsupported')
  })

  it('keeps a task matter readable when its workbench record is gone',()=>{
    store.create({id:'00000003',kind:'task',title:'t'})
    const service=makeMattersService({store,workbench:{detail:()=>{throw new Error('not_found')},continueTask:()=>TASK}})
    expect(service.detail('00000003')).toMatchObject({task:null,events:[]})
  })
})
