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

describe('matters service — search the owner chat (2026-10-06)',()=>{
  it('searches only the owner chat, newest first as the store returns them, clamps limit, and refuses empty / huge queries',async()=>{
    const search=vi.fn(async(_c:string,_q:string,_l:number)=>[{id:'m2',kind:'text' as const,text:'报告写好了',createdAt:2,source:'wechat'}])
    const service=makeMattersService({store,chat:{ownerChatId:()=>'owner-chat',say:async()=>({reply:''}),search}})
    expect(await service.searchOwnerChat(' 报告 ',500)).toEqual({hits:[{id:'m2',kind:'text',text:'报告写好了',createdAt:2,source:'wechat'}]})
    expect(search).toHaveBeenCalledWith('owner-chat','报告',50)
    await expect(service.searchOwnerChat('  ')).rejects.toThrow('invalid_query')
    await expect(service.searchOwnerChat('x'.repeat(201))).rejects.toThrow('invalid_query')
    const none=makeMattersService({store,chat:{ownerChatId:()=>null,say:async()=>({reply:''}),search}})
    expect(await none.searchOwnerChat('报告')).toBeNull()
  })
})

describe('matters service — stop from the phone (2026-10-06)',()=>{
  it('cancels only the run the phone saw; a changed or missing run is input_stale',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'整理周报',projectPath:'/work',ownerChatId:'owner'})
    let runId:string|undefined='run-1'
    const cancel=vi.fn(async()=>({}))
    const workbench={detail:vi.fn(()=>({task:TASK,events:[],...(runId?{runId}:{})})),continueTask:vi.fn(),cancel}
    const service=makeMattersService({store,workbench:workbench as never})
    await service.stop('deadbeef','run-1')
    expect(cancel).toHaveBeenCalledWith('deadbeef','run-1')
    runId='run-2'
    await expect(service.stop('deadbeef','run-1')).rejects.toThrow('input_stale')
    runId=undefined
    await expect(service.stop('deadbeef','run-2')).rejects.toThrow('input_stale')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('worktree on the phone (2026-10-07)',()=>{
  it('detail carries only branch + removed (never the source path); worktree() passes through',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'并行',projectPath:'/work',ownerChatId:'owner'})
    const task={...TASK,worktree:{branch:'cc/abcd1234',projectPath:'/Users/me/secret',removed:false}}
    const worktreeAction=vi.fn(()=>({branch:'cc/abcd1234',committed:true,sha:'s',mergeHint:'cd /Users/me/secret && git merge cc/abcd1234'}))
    const service=makeMattersService({store,workbench:{detail:()=>({task,events:[]}),continueTask:vi.fn(),worktreeAction} as never})
    expect((await service.detail('deadbeef')).task?.worktree).toEqual({branch:'cc/abcd1234',removed:false})
    expect(service.worktree('deadbeef','commit')).toEqual({branch:'cc/abcd1234',committed:true})
    expect(worktreeAction).toHaveBeenCalledWith('deadbeef','commit')
    worktreeAction.mockReturnValueOnce({branch:'cc/abcd1234',merged:true,into:'main'} as never)
    expect(service.worktree('deadbeef','merge')).toEqual({branch:'cc/abcd1234',merged:true})
    task.worktree={...task.worktree,merged:true} as never
    expect((await service.detail('deadbeef')).task?.worktree).toEqual({branch:'cc/abcd1234',removed:false,merged:true})
    // 另做一份(10-08):源项目只给编号
    const withProjects=makeMattersService({store,workbench:{detail:()=>({task,events:[]}),continueTask:vi.fn(),worktreeAction,projects:()=>[{id:'p-1',path:'/Users/me/secret'}]} as never})
    const shown=(await withProjects.detail('deadbeef')).task?.worktree
    expect(shown).toEqual({branch:'cc/abcd1234',removed:false,merged:true,projectId:'p-1'});expect(JSON.stringify(shown)).not.toContain('/Users/me')
  })
})

it('projects a completed asynchronous managed worktree result without exposing private fields',async()=>{
 store.create({id:'deadbeef',kind:'task',title:'managed',projectPath:'/work',ownerChatId:'owner'})
 const worktreeAction=async()=>({branch:'cc/new',committed:true,sha:'private',mergeHint:'/private'})
 const service=makeMattersService({store,workbench:{detail:()=>({task:TASK,events:[]}),continueTask:vi.fn(),worktreeAction} as never})
 expect(await service.worktree('deadbeef','commit')).toEqual({branch:'cc/new',committed:true})
})


it.each([
 {sourcePath:'/legacy',workspace:{id:'cc730ffd-1192-4a75-b99e-b6fc3e23d105',mode:'isolated' as const,sourcePath:'/source',executionPath:'/copies/project',branch:'codex/cc-task-cc730ffd-1192-4a75-b99e-b6fc3e23d105',baseCommit:'a'.repeat(40)},worktree:{branch:'codex/cc-task-cc730ffd-1192-4a75-b99e-b6fc3e23d105',removed:false,projectPath:'/legacy'}},
 {sourcePath:'/source',worktree:{branch:'cc/abcd1234',removed:false,projectPath:'/legacy'}},
 {worktree:{branch:'cc/abcd1234',removed:false,projectPath:'/source'}},
])('fork project identity follows source projection, never execution path: %j',async projection=>{
 store.create({id:'deadbeef',kind:'task',title:'fork',projectPath:'/source',ownerChatId:'owner'})
 const task={...TASK,path:'/copies/project',...projection}
 const service=makeMattersService({store,workbench:{detail:()=>({task,events:[]}),continueTask:()=>task,projects:()=>[{id:'source-project',path:'/source'},{id:'wrong-execution',path:'/copies/project'},{id:'wrong-legacy',path:'/legacy'}]}})
 const detail=await service.detail('deadbeef')
 expect(detail.task?.worktree?.projectId).toBe('source-project')
 expect(detail.task?.path).toBe('/copies/project')
 if('workspace' in projection)expect(detail.task).toMatchObject({workspace:projection.workspace,sourcePath:projection.sourcePath})
})

it('missing source project never substitutes the execution folder project',async()=>{
 store.create({id:'deadbeef',kind:'task',title:'fork',projectPath:'/source',ownerChatId:'owner'})
 const task={...TASK,path:'/copies/project',sourcePath:'/missing',worktree:{branch:'cc/abcd1234',removed:false,projectPath:'/copies/project'}}
 const service=makeMattersService({store,workbench:{detail:()=>({task,events:[]}),continueTask:()=>task,projects:()=>[{id:'wrong-execution',path:'/copies/project'}]}})
 expect((await service.detail('deadbeef')).task?.worktree?.projectId).toBeUndefined()
})
