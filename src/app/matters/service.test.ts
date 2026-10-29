import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import { makeMatterStore } from '../../adapters/store/matters-store'
import type { MatterStore } from '../../ports/matters'
import {makeMattersService} from './service'
import {PHONE_API_SCHEMAS} from '@wechat-cc/protocol'

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
  it('the owner chat remembers the surface that first created it, and only that one (2026-10-19)',async()=>{
    const chat={ownerChatId:()=>'owner-chat',say:async()=>({reply:'x'})}
    // 没接 originOf:桌面首建 ⇒ desktop
    const d=await makeMattersService({store,chat}).ownerChat('desktop')
    expect(d?.matter.origin).toBe('desktop')
    // 之后从手机看,不改
    expect((await makeMattersService({store,chat,originOf:()=>'app'}).ownerChat('phone'))?.matter.origin).toBe('desktop')
    // 别的主人:手机首建,没接 originOf ⇒ 不知道;接了就按它
    const other={ownerChatId:()=>'owner-2',say:async()=>({reply:'x'})}
    expect((await makeMattersService({store,chat:other}).ownerChat('phone'))?.matter).not.toHaveProperty('origin')
    const third={ownerChatId:()=>'owner-3',say:async()=>({reply:'x'})}
    expect((await makeMattersService({store,chat:third,originOf:s=>s==='phone'?'web':'desktop'}).ownerChat('phone'))?.matter.origin).toBe('web')
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
  it('工具那一步只投影 type/status/label 给手机,不带命令输出与细节(2026-10-17)',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'任务',projectPath:'/work'})
    const activity={id:'a1',type:'command',status:'running',label:'npm test',detail:'cd /secret && npm test',output:'TOKEN=abc'}
    const workbench={detail:vi.fn(()=>({task:TASK,events:[{kind:'tool_call',text:'npm test',createdAt:3,activity},{kind:'text',text:'在跑',createdAt:4,activity}]})),continueTask:vi.fn()}
    const detail=await makeMattersService({store,workbench} as never).detail('deadbeef')
    expect(detail.events).toEqual([{kind:'tool_call',text:'npm test',createdAt:3,activity:{type:'command',status:'running',label:'npm test'}},{kind:'text',text:'在跑',createdAt:4}])
    PHONE_API_SCHEMAS['GET /m/api/matter']!.parse({ok:true,...detail})
  })
})

describe('撤掉这一轮(回退切片 4)',()=>{
  const PREVIEW={token:'f'.repeat(64),target:{artifactId:'a2',to:'start',round:2},discarded:[{artifactId:'a2',round:2}],
    files:{count:60,paths:Array.from({length:60},(_,i)=>({status:'M',path:`f${i}.ts`,extra:'x'}))},extraChanges:{count:1,paths:[{status:'A',path:'note.txt'}]},
    droppedCommits:{count:1,elsewhere:true},ignoredUntouched:true,rebuildHint:'先重新构建',refsNote:'refs/tendhearth/ 在 /Users/me/secret',session:'will_close',devServer:false,goal:{status:'passed',willStop:true}}
  function setup(over:Record<string,unknown>={}){
    store.create({id:'deadbeef',kind:'task',title:'回退',projectPath:'/work',ownerChatId:'owner'})
    const rounds=[{artifactId:'a1',createdAt:1},{artifactId:'a2',createdAt:2},{artifactId:'a3',createdAt:3,discarded:true}]
    const wb={detail:vi.fn(()=>({task:TASK,events:[]})),continueTask:vi.fn(),reviewList:vi.fn(()=>rounds),rewindPreview:vi.fn(async()=>PREVIEW),rewind:vi.fn(async()=>({rewindId:'r',backupRef:'refs/x',head:'h',discarded:['a2']})),...over}
    return {wb,service:makeMattersService({store,workbench:wb as never})}
  }
  it('只认最新那一轮没撤的、固定 to:start;预览只给手机要的几样(路径至多 50 个),过协议',async()=>{
    const {wb,service}=setup()
    const p=await service.rewindPreview('deadbeef','a2')
    expect(wb.rewindPreview).toHaveBeenCalledWith('deadbeef',{artifactId:'a2',to:'start'})
    expect(p).toMatchObject({token:'f'.repeat(64),round:2,rounds:[2],extraChanges:{count:1,paths:[{status:'A',path:'note.txt'}]},droppedCommits:{count:1,elsewhere:true},session:'will_close',goalWillStop:true})
    expect(p.files.count).toBe(60);expect(p.files.paths).toHaveLength(50);expect(p.files.paths[0]).toEqual({status:'M',path:'f0.ts'})
    expect(JSON.stringify(p)).not.toContain('/Users/me')
    PHONE_API_SCHEMAS['GET /m/api/matter/rewind']!.parse({ok:true,preview:p})
    await expect(service.rewindPreview('deadbeef','a1')).rejects.toThrow('rewind_not_latest')
    await expect(service.rewindPreview('deadbeef','a3')).rejects.toThrow('rewind_not_latest')
    await expect(service.rewind('deadbeef','a2','f'.repeat(64))).resolves.toEqual({discarded:['a2']})
    expect(wb.rewind).toHaveBeenCalledWith('deadbeef',{artifactId:'a2',to:'start',token:'f'.repeat(64)})
    await expect(service.rewind('deadbeef','a1','f'.repeat(64))).rejects.toThrow('rewind_not_latest')
    expect(wb.rewind).toHaveBeenCalledTimes(1)
  })
  it('没接 ⇒ workbench_not_wired;聊天那件 ⇒ matter_task_required',async()=>{
    const {service}=setup({rewind:undefined})
    await expect(service.rewindPreview('deadbeef','a2')).rejects.toThrow('workbench_not_wired')
    const chat=store.ensureChat('owner-chat')
    await expect(service.rewindPreview(chat.id,'a2')).rejects.toThrow('matter_task_required')
  })
  it('停住等主人拍板 ⇒ 详情的 task.rewind.blocked(手机只读一句);没停住不带',async()=>{
    const {wb,service}=setup()
    expect((await service.detail('deadbeef')).task).not.toHaveProperty('rewind')
    wb.detail.mockReturnValue({task:TASK,events:[],rewind:{undo:null,blocked:{rewindId:'r',backupRef:'refs/tendhearth/rewind/x',reason:'停住了'}}} as never)
    const d=await service.detail('deadbeef')
    expect(d.task?.rewind).toEqual({blocked:true});expect(JSON.stringify(d)).not.toContain('refs/tendhearth')
    PHONE_API_SCHEMAS['GET /m/api/matter']!.parse({ok:true,...d})
  })
})

describe('工作区脚本到手机(2026-10-20)',()=>{
  it('详情:状态 + 端口 + 批没批 + 最后几行;脚本原文、路径、hash 不到手机;run / stop 转给 scriptAction',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'并行',projectPath:'/work',ownerChatId:'owner'})
    const scripts={configured:true,approved:true,hash:'f'.repeat(64),config:{setup:'bun i',run:'PORT=$TENDHEARTH_PORT bun dev --secret',archive:null},setup:'done',run:'running',archiving:false}
    const task={...TASK,path:'/Users/me/.wt/abc',worktree:{branch:'cc/abcd1234',projectPath:'/Users/me/secret',removed:false,merged:false,port:47100,scripts}}
    const events=[{kind:'tool_call',text:'run',createdAt:3,activity:{id:'script-1',type:'command',status:'running',label:'run',output:'listening on http://localhost:47100\nbuilt /Users/me/.wt/abc/dist/app.js'}}]
    const scriptAction=vi.fn(async()=>({branch:'cc/abcd1234',scripts,port:47100}))
    const service=makeMattersService({store,workbench:{detail:()=>({task,events}),continueTask:vi.fn(),scriptAction} as never})
    const d=await service.detail('deadbeef')
    expect(d.task?.worktree).toEqual({branch:'cc/abcd1234',removed:false,port:47100,setup:'done',run:'running',approved:true,lastLines:['listening on http://localhost:47100','built ./dist/app.js']})
    const json=JSON.stringify(d.task?.worktree);expect(json).not.toContain('--secret');expect(json).not.toContain('/Users/me');expect(json).not.toContain('fff')
    PHONE_API_SCHEMAS['GET /m/api/matter']!.parse({ok:true,...d})
    expect(await service.worktreeScript('deadbeef','stop')).toEqual({branch:'cc/abcd1234',port:47100,setup:'done',run:'running',approved:true})
    expect(scriptAction).toHaveBeenCalledWith('deadbeef','stop')
    // 工作区删了 ⇒ 不再带脚本状态
    task.worktree={...task.worktree,removed:true}
    expect((await service.detail('deadbeef')).task?.worktree).toEqual({branch:'cc/abcd1234',removed:true})
  })
  it('没接 scriptAction ⇒ workbench_not_wired',async()=>{
    store.create({id:'deadbeef',kind:'task',title:'并行',projectPath:'/work'})
    const service=makeMattersService({store,workbench:{detail:()=>({task:TASK,events:[]}),continueTask:vi.fn()} as never})
    await expect(service.worktreeScript('deadbeef','run')).rejects.toThrow('workbench_not_wired')
  })
})


it('owner history preserves durable attachment-only replies through the public service projection',async()=>{
  const event={kind:'text',text:'',createdAt:1,messageId:'saved',replyExtras:{attachments:[{kind:'file' as const,name:'photo.png'}],narration:['checked']}}
  const file=vi.fn(async()=>({status:200,body:{ok:true}}))
  const service=makeMattersService({store,chat:{ownerChatId:()=>'owner',say:async()=>({reply:''}),recent:async()=>[event],file}})
  expect((await service.ownerChat('desktop'))?.events).toEqual([event])
  expect(await service.ownerChatFile({id:'saved',i:0,offset:0})).toEqual({status:200,body:{ok:true}})
  expect(file).toHaveBeenCalledWith({id:'saved',i:0,offset:0})
})
