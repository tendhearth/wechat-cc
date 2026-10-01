import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore,type MatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {encodeNativeHistoryKey,historyPreview,type NativeHistoryItem,type NativeHistoryMessage,type NativeHistoryProvider,type NativeHistoryReader} from './native-history'
import {selectNativeImportMessages} from './native-adoption'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'
import {nativeImportMessages} from '../../../apps/desktop/src/modules/workbench-history.js'

// spec 2026-10-01-tendhearth-continue-sessions §4.1:手机「接着做」的核心。真工作台 + 真 matters + 假原生历史读取器。
let dir:string,db:Db,matters:MatterStore,service:WorkbenchService|undefined
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'cc-native-continue-')));db=openDb({path:join(dir,'test.db')});matters=makeMatterStore(db);service=undefined})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(dir)})

const MESSAGES:NativeHistoryMessage[]=[{id:'u',role:'user',text:'original request',truncated:false},{id:'a',role:'assistant',text:'original answer',truncated:false}]

function fixture(o:{provider?:NativeHistoryProvider;messages?:NativeHistoryMessage[];matters?:boolean;seek?:boolean;readClockMs?:number}={}){
  const providerId=o.provider??'claude'
  const project=join(dir,'proj');mkdirSync(project,{recursive:true})
  const store=makeWorkbenchStore(db),registry=createProviderRegistry()
  let version=1,reads=0,active=false,folderBusy=false,sessionBusy=false,resumable=true,quotaOut=false
  const changeOn=new Set<number>()
  // gate:不放行 ⇒ 执行者一直起不来(还没派发),用来模拟「在跑的时候 daemon 重启」。
  let gate:Promise<void>|null=null
  const spawn=vi.fn(async(_p:any,context:any)=>{if(gate)await gate;return{async *dispatch(){const id=context.resumeSessionId??'fresh-native';yield{kind:'init' as const,sessionId:id};yield{kind:'text' as const,text:'continued'};yield{kind:'result' as const,sessionId:id,numTurns:1,durationMs:1}},async close(){}}})
  // 只登记 claude:codex 的会话用来测「电脑上没装」。
  registry.register('claude',{spawn},{displayName:'Claude',canResume:()=>resumable,workbench:MANAGED_NATIVE_CAPABILITIES})
  const item:NativeHistoryItem={key:encodeNativeHistoryKey(providerId,'original'),providerId,nativeId:'original',title:'Original task',titleSource:'native_custom',cwd:project,updatedAt:1,remote:false,observedState:'unknown'}
  // 按 cursor 分页(cursor = `c<起点>`),与真读取器一样从最早往新翻;两条消息的默认会话只有一页。
  let readGate:Promise<void>|null=null
  const read=vi.fn(async(_key:string,page:any)=>{
    if(readGate)await readGate
    if(o.readClockMs)vi.setSystemTime(Date.now()+o.readClockMs)
    reads++;if(changeOn.has(reads))version++
    const all=o.messages??MESSAGES,from=page.cursor?Number(String(page.cursor).slice(1)):0,to=from+page.limit
    return historyPreview({...item,observedState:active?'active':'unknown'},{version},all.slice(from,to),to<all.length?`c${to}`:null,page)
  })
  // seek:像 Claude 读取器一样能直接给出离结尾 rows 条处的 cursor。
  const tailCursor=vi.fn(async(_key:string,rows:number)=>{const start=(o.messages??MESSAGES).length-rows;return start>0?`c${start}`:null})
  const reader:NativeHistoryReader={list:async()=>({items:[item],nextCursor:null,coverage:'native_supported_history'}),read,currentFingerprint:async(key,page={limit:100})=>(await read(key,page)).sourceFingerprint,...(o.seek?{tailCursor}:{})}
  const make=(st=store)=>makeWorkbenchService({store:st,registry,stateDir:dir,ownerChatId:()=>'owner',
    nativeHistory:providerId==='codex'?{codex:reader}:{claude:reader},
    ...(o.matters===false?{}:{matters}),
    // nativeId 为 null 问的是「这个文件夹有没有人在用」;带 nativeId 问的是「这个会话有没有人在用」。
    executionConflict:(_path,_provider,nativeId)=>nativeId===null?folderBusy:(folderBusy||sessionBusy),
    usage:id=>quotaOut&&id==='claude'?({providerId:'claude',plan:null,windows:[],exhausted:true,fetchedAt:Date.now()} as never):null})
  service=make()
  return {store,spawn,item,project,read,tailCursor,
    holdReads:()=>{let open!:()=>void;readGate=new Promise<void>(r=>{open=r});return ()=>{readGate=null;open()}},
    hold:()=>{let open!:()=>void;gate=new Promise<void>(r=>{open=r});return ()=>open()},unhold:()=>{gate=null},
    /** 模拟 daemon 重启:同一个库上起一个新服务(构造时 recover);旧服务原样留着,不 shutdown(进程是被杀的)。 */
    restart:()=>{const old=service!;service=make(makeWorkbenchStore(db));return old},
    active:(v:boolean)=>{active=v},folderBusy:(v:boolean)=>{folderBusy=v},sessionBusy:(v:boolean)=>{sessionBusy=v},
    resumable:(v:boolean)=>{resumable=v},quotaOut:(v:boolean)=>{quotaOut=v},changeOnRead:(...n:number[])=>{for(const x of n)changeOn.add(x)}}
}

describe('selectNativeImportMessages(与桌面 nativeImportMessages 同一条规则)',()=>{
  const m=(id:string,len:number):NativeHistoryMessage=>({id,role:'user',text:'x'.repeat(len),truncated:false})
  it('从最新往前挑,合计不超过 24 000 字;放不下的单条跳过、继续往前看;顺序不变',()=>{
    expect(selectNativeImportMessages([m('a',100),m('b',30_000),m('c',23_000),m('d',900)]).map(x=>x.id)).toEqual(['a','c','d'])
  })
  it('至多 200 条(最新的 200 条)',()=>{
    const out=selectNativeImportMessages(Array.from({length:250},(_,i)=>m(`m${i}`,1)))
    expect(out).toHaveLength(200);expect(out[0]!.id).toBe('m50');expect(out.at(-1)!.id).toBe('m249')
  })
  it('一条都放不下 ⇒ 空',()=>{expect(selectNativeImportMessages([m('big',24_001)])).toEqual([])})
})

describe('previewNativeContinue:只看能不能接,什么都不建',()=>{
  it('能恢复 ⇒ ready / native_resume;只给目录名;不建任务、不起执行者、不建 matter',async()=>{
    const f=fixture()
    expect(await service!.previewNativeContinue(f.item.key)).toEqual({state:'ready',providerId:'claude',project:'proj',mode:'native_resume',taskId:null})
    expect(service!.list().tasks).toEqual([]);expect(f.spawn).not.toHaveBeenCalled();expect(matters.list()).toEqual([])
  })
  it('原会话恢复不了 ⇒ ready / fresh_context',async()=>{
    const f=fixture();f.resumable(false)
    expect((await service!.previewNativeContinue(f.item.key)).mode).toBe('fresh_context')
  })
  it('看得见的在跑 ⇒ busy_session;CC 在这个文件夹做别的事 ⇒ busy_folder;CC 占着这个会话 ⇒ busy_session',async()=>{
    const f=fixture()
    f.active(true);expect((await service!.previewNativeContinue(f.item.key)).state).toBe('busy_session');f.active(false)
    f.folderBusy(true);expect((await service!.previewNativeContinue(f.item.key)).state).toBe('busy_folder');f.folderBusy(false)
    f.sessionBusy(true);expect((await service!.previewNativeContinue(f.item.key)).state).toBe('busy_session')
  })
  it('文件夹不在了 ⇒ folder_missing(仍给目录名,mode 为 null)',async()=>{
    const f=fixture();rmSync(f.project,{recursive:true})
    expect(await service!.previewNativeContinue(f.item.key)).toMatchObject({state:'folder_missing',project:'proj',mode:null})
  })
  it('执行者没准入(电脑上没装)⇒ provider_missing',async()=>{
    const f=fixture({provider:'codex'})
    expect(await service!.previewNativeContinue(f.item.key)).toMatchObject({state:'provider_missing',providerId:'codex'})
  })
  it('额度耗尽 ⇒ quota',async()=>{
    const f=fixture();f.quotaOut(true)
    expect((await service!.previewNativeContinue(f.item.key)).state).toBe('quota')
  })
  it('没有能带过来的消息 ⇒ empty',async()=>{
    const f=fixture({messages:[]})
    expect((await service!.previewNativeContinue(f.item.key)).state).toBe('empty')
  })
  it('坏 key ⇒ invalid_native_history_key;这类历史没接 ⇒ native_history_unsupported',async()=>{
    fixture()
    await expect(service!.previewNativeContinue('bad key')).rejects.toThrow('invalid_native_history_key')
    await expect(service!.previewNativeContinue(encodeNativeHistoryKey('codex','x'))).rejects.toThrow('native_history_unsupported')
  })
})

describe('adoptNativeSession:接成一件事',()=>{
  it('导入(不起执行者)+ matter 行(id = 任务 id,绑主人);再接回同一件;之后预览是 managed',async()=>{
    const f=fixture()
    const one=await service!.adoptNativeSession(f.item.key)
    expect(one.created).toBe(true);expect(f.spawn).not.toHaveBeenCalled()
    const task=f.store.get(one.taskId)
    expect(task.sessionId).toBe('original');expect(task.status).toBe('interrupted');expect(f.store.source(one.taskId)?.firstDispatchedAt).toBeNull()
    expect(matters.get(one.taskId)).toMatchObject({id:one.taskId,kind:'task',title:'Original task',projectPath:f.project,ownerChatId:'owner',status:'open'})
    expect(matters.bindings(one.taskId).map(b=>[b.surface,b.surfaceKey])).toEqual([['wechat','owner']])
    expect(service!.detail(one.taskId).events.map(e=>e.text)).toEqual(['original request','original answer'])
    expect(await service!.adoptNativeSession(f.item.key)).toEqual({taskId:one.taskId,created:false})
    expect(service!.list().tasks).toHaveLength(1)
    expect(await service!.previewNativeContinue(f.item.key)).toEqual({state:'managed',providerId:'claude',project:'proj',mode:null,taskId:one.taskId})
  })
  it('桌面早先导入过、没有 matter 行 ⇒ 不再导入,只补 matter 行',async()=>{
    const f=fixture()
    const p=await f.read(f.item.key,{limit:100})
    const desk=await service!.importNativeHistory({key:f.item.key,pages:[{...p.page,sourceFingerprint:p.sourceFingerprint}],messageIds:['u','a']})
    expect(matters.get(desk.task.id)).toBeNull()
    expect(await service!.adoptNativeSession(f.item.key)).toEqual({taskId:desk.task.id,created:false})
    expect(matters.get(desk.task.id)?.kind).toBe('task');expect(service!.list().tasks).toHaveLength(1)
  })
  it('读与导入之间会话变了一次 ⇒ 重读重导成功',async()=>{
    const f=fixture();f.changeOnRead(2)
    expect((await service!.adoptNativeSession(f.item.key)).created).toBe(true)
    expect(service!.list().tasks).toHaveLength(1)
  })
  it('一直在变 ⇒ native_history_changed,什么都不建',async()=>{
    const f=fixture();f.changeOnRead(2,4)
    await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('native_history_changed')
    expect(service!.list().tasks).toEqual([]);expect(matters.list()).toEqual([])
  })
  it('拒绝的状态 ⇒ 对应错误码,什么都不建',async()=>{
    const f=fixture()
    f.active(true);await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('native_session_busy');f.active(false)
    f.folderBusy(true);await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('native_folder_busy');f.folderBusy(false)
    f.quotaOut(true);await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('provider_quota_exhausted');f.quotaOut(false)
    rmSync(f.project,{recursive:true});await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('invalid_path')
    expect(service!.list().tasks).toEqual([]);expect(matters.list()).toEqual([])
  })
  it('没接 matters ⇒ matters_not_wired(任务留着;接上之后再点走 managed 补上)',async()=>{
    fixture({matters:false})
    await expect(service!.adoptNativeSession(encodeNativeHistoryKey('claude','original'))).rejects.toThrow('matters_not_wired')
    expect(service!.list().tasks).toHaveLength(1)
  })
})

describe('幂等与无副作用(补充)',()=>{
  it('预览不写库:前后各表行数不变',async()=>{
    const f=fixture()
    const count=()=>['workbench_tasks','workbench_sources','workbench_events','workbench_projects','matters','matter_bindings'].map(t=>db.query<{n:number},[]>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n)
    const before=count()
    await service!.previewNativeContinue(f.item.key)
    f.resumable(false);await service!.previewNativeContinue(f.item.key)
    expect(count()).toEqual(before)
  })
  it('两次接同时来 ⇒ 同一件事,只导入一次,只有一行 matter',async()=>{
    const f=fixture()
    const [a,b]=await Promise.all([service!.adoptNativeSession(f.item.key),service!.adoptNativeSession(f.item.key)])
    expect(a.taskId).toBe(b.taskId);expect([a.created,b.created].sort()).toEqual([false,true])
    expect(service!.list().tasks).toHaveLength(1);expect(matters.list().filter(m=>m.kind==='task')).toHaveLength(1)
    expect(service!.detail(a.taskId).events.map(e=>e.text)).toEqual(['original request','original answer'])
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('CC 占着这个会话 ⇒ native_session_busy,不接管、什么都不建',async()=>{
    const f=fixture();f.sessionBusy(true)
    await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('native_session_busy')
    expect(service!.list().tasks).toEqual([]);expect(matters.list()).toEqual([]);expect(f.spawn).not.toHaveBeenCalled()
  })
  it('桌面导入路径不变:importNativeHistory 仍然不建 matter 行',async()=>{
    const f=fixture()
    const p=await f.read(f.item.key,{limit:100})
    const desk=await service!.importNativeHistory({key:f.item.key,pages:[{...p.page,sourceFingerprint:p.sourceFingerprint}],messageIds:['u','a']})
    expect(desk.created).toBe(true);expect(matters.list()).toEqual([])
  })
})

describe('fix round 1:补建自愈、状态映射、挑法确定',()=>{
  it('matter 行建好了、bind 中途抛 ⇒ 整笔回滚;再点一次补齐(create + linkTask + bind)',async()=>{
    const f=fixture()
    const bind=vi.spyOn(matters,'bind').mockImplementationOnce(()=>{throw new Error('boom')})
    await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('boom')
    const id=service!.list().tasks[0]!.id
    expect(matters.get(id)).toBeNull()
    expect(await service!.adoptNativeSession(f.item.key)).toEqual({taskId:id,created:false})
    expect(matters.get(id)?.kind).toBe('task');expect(f.store.taskMatterId(id)).toBe(id)
    expect(matters.bindings(id).map(b=>[b.surface,b.surfaceKey])).toEqual([['wechat','owner']])
    bind.mockRestore()
  })
  it('matter 行已在、但 linkTask / bind 缺 ⇒ 下次照样补上(只有 create 看「已有」)',async()=>{
    const f=fixture()
    const p=await f.read(f.item.key,{limit:100})
    const desk=await service!.importNativeHistory({key:f.item.key,pages:[{...p.page,sourceFingerprint:p.sourceFingerprint}],messageIds:['u','a']})
    matters.create({id:desk.task.id,kind:'task',title:'half',projectPath:f.project,ownerChatId:'owner'})
    await service!.adoptNativeSession(f.item.key)
    expect(f.store.taskMatterId(desk.task.id)).toBe(desk.task.id)
    expect(matters.bindings(desk.task.id).map(b=>[b.surface,b.surfaceKey])).toEqual([['wechat','owner']])
  })
  it('补建的状态跟任务走:completed / failed / cancelled ⇒ done;interrupted ⇒ open',async()=>{
    const f=fixture()
    const p=await f.read(f.item.key,{limit:100})
    const desk=await service!.importNativeHistory({key:f.item.key,pages:[{...p.page,sourceFingerprint:p.sourceFingerprint}],messageIds:['u','a']})
    f.store.update(desk.task.id,'completed')
    await service!.adoptNativeSession(f.item.key)
    expect(matters.get(desk.task.id)?.status).toBe('done')
  })
  it('同一 nativeId 有两个工作台任务 ⇒ taskByNativeIdentity 取最近更新的那个(确定)',()=>{
    const f=fixture()
    const a=f.store.create({title:'a',path:f.project,providerId:'claude',ownerChatId:'owner'})
    const b=f.store.create({title:'b',path:f.project,providerId:'claude',ownerChatId:'owner'})
    f.store.session(a.id,'shared');f.store.session(b.id,'shared')
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(1,b.id)
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(2,a.id)
    expect(f.store.taskByNativeIdentity('claude','shared')?.id).toBe(a.id)
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(3,b.id)
    expect(f.store.taskByNativeIdentity('claude','shared')?.id).toBe(b.id)
  })
})

async function settled(id:string){await vi.waitFor(()=>expect(['running','queued','cancelling']).not.toContain(service!.detail(id).task.status))}

describe('continueImported:手机说的第一句',()=>{
  const R='5a7e0000-0000-4000-8000-000000000001'
  it('能恢复 ⇒ 接着原会话跑(resumeSessionId = 原 id),记下声明;回执按 requestId',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(1);expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBe('original')
    expect(f.store.source(taskId)?.firstDispatchedAt).not.toBeNull()
    const d=service!.detail(taskId)
    expect(d.events.some(e=>e.kind==='system'&&e.text.includes('恢复原会话'))).toBe(true)
    expect(d.events.some(e=>e.kind==='user'&&e.text==='接着改')).toBe(true)
    expect(f.store.liveInputs.get(R)?.taskId).toBe(taskId)
  })
  it('原会话恢复不了 ⇒ 带记录新开一轮(没有 resumeSessionId)',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key);f.resumable(false)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBeUndefined()
    expect(service!.detail(taskId).events.some(e=>e.kind==='system'&&e.text.includes('带已确认的记录新开一轮'))).toBe(true)
  })
  it('同一 requestId 重发 ⇒ 不起第二轮;同一 id 换了正文 ⇒ input_conflict',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    expect(f.spawn).toHaveBeenCalledTimes(1)
    await expect(service!.continueImported(taskId,'别的话',{inputRequestId:R})).rejects.toThrow('input_conflict')
  })
  it('接过来之后会话又在电脑上跑了 ⇒ native_session_busy,什么都不记、不起执行者',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key),before=service!.detail(taskId).events.length
    f.active(true)
    await expect(service!.continueImported(taskId,'接着改',{inputRequestId:R})).rejects.toThrow('native_session_busy')
    expect(f.spawn).not.toHaveBeenCalled();expect(service!.detail(taskId).events).toHaveLength(before)
    expect(f.store.liveInputs.get(R)).toBeNull()
  })
  it('不是「导入了还没发过第一句」的任务 ⇒ invalid_request',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    await service!.continueImported(taskId,'接着改');await settled(taskId)
    await expect(service!.continueImported(taskId,'再来')).rejects.toThrow('invalid_request')
  })
  it('内部 API 那条路不变:continueNativeTask 不带尾参照旧接着原会话',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const p=await service!.prepareNativeResume(taskId);await service!.continueNativeTask(taskId,'go',p.token);await settled(taskId)
    expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBe('original')
  })
})

describe('Task 2 裁决补充(R2 / R7 / R10)',()=>{
  const R='5a7e0000-0000-4000-8000-000000000002'
  const many=(n:number,len=1):NativeHistoryMessage[]=>Array.from({length:n},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',text:`${i}`.padEnd(len,'x'),truncated:false}))
  it('R2:超过 100 条的会话 ⇒ 翻到最后一页再挑,带过来的是最新的 200 条;第一句照样接着原会话',async()=>{
    const f=fixture({messages:many(250)})
    const {taskId}=await service!.adoptNativeSession(f.item.key)
    const texts=service!.detail(taskId).events.map(e=>e.text)
    expect(texts).toHaveLength(200);expect(texts[0]).toBe('50');expect(texts.at(-1)).toBe('249')
    expect(f.store.source(taskId)?.truncated).toBe(true)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(1);expect(f.spawn.mock.calls[0]?.[1].resumeSessionId).toBe('original')
  })
  it('R2:超过 500 条 ⇒ 翻五页以上照样到尾,最新的那条一定在',async()=>{
    const f=fixture({messages:many(730,150)})
    const {taskId}=await service!.adoptNativeSession(f.item.key)
    const texts=service!.detail(taskId).events.map(e=>e.text)
    expect(texts.at(-1)?.startsWith('729')).toBe(true)
    expect(texts.length).toBe(160) // 24 000 / 150
    expect(texts[0]?.startsWith('570')).toBe(true)
  })
  it('R7:selectNativeImportMessages 与桌面 nativeImportMessages 逐条一致',()=>{
    let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648
    for(let run=0;run<200;run++){
      const n=Math.floor(rnd()*320),msgs=Array.from({length:n},(_,i)=>({id:`r${run}-${i}`,role:'user' as const,text:'x'.repeat(Math.floor(rnd()**3*30_000)),truncated:false}))
      expect(selectNativeImportMessages(msgs).map(m=>m.id)).toEqual(nativeImportMessages({messages:msgs} as never).map((m:NativeHistoryMessage)=>m.id))
    }
    expect(selectNativeImportMessages([])).toEqual(nativeImportMessages(null))
  })
  it('不接管活着的会话:恢复不了(带记录新开一轮)也在第一句时重查「在跑」⇒ native_session_busy,不起执行者',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key);f.resumable(false);f.active(true)
    await expect(service!.continueImported(taskId,'接着改',{inputRequestId:R})).rejects.toThrow('native_session_busy')
    f.active(false);f.sessionBusy(true)
    await expect(service!.continueImported(taskId,'接着改',{inputRequestId:R})).rejects.toThrow('native_session_busy')
    expect(f.spawn).not.toHaveBeenCalled();expect(f.store.liveInputs.get(R)).toBeNull()
  })
  it('R10:同一 requestId 两次同时来 ⇒ 只起一次执行者,两边都拿到同一个结果',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const [a,b]=await Promise.all([service!.continueImported(taskId,'接着改',{inputRequestId:R}),service!.continueImported(taskId,'接着改',{inputRequestId:R})])
    expect(a.id).toBe(taskId);expect(b.id).toBe(taskId)
    await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(service!.detail(taskId).events.filter(e=>e.kind==='user'&&e.text==='接着改')).toHaveLength(1)
  })
  it('R10:同时来、正文不同 ⇒ 后来的 input_conflict,只起一次',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const results=await Promise.allSettled([service!.continueImported(taskId,'接着改',{inputRequestId:R}),service!.continueImported(taskId,'别的话',{inputRequestId:R})])
    expect(results[0].status).toBe('fulfilled');expect(results[1].status==='rejected'&&String(results[1].reason)).toContain('input_conflict')
    await settled(taskId);expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('R10:第一次失败(会话又在跑)⇒ 同一 requestId 停了之后再发可以接着发',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    f.active(true);await expect(service!.continueImported(taskId,'接着改',{inputRequestId:R})).rejects.toThrow('native_session_busy')
    f.active(false);await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('R10:还没派发 daemon 就重启 ⇒ 那一轮记成 interrupted;同一 requestId 重发 ⇒ 重新派发一次(不是两轮)',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const release=f.hold()
    await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    await vi.waitFor(()=>expect(f.spawn).toHaveBeenCalledTimes(1))
    expect(f.store.source(taskId)?.firstDispatchedAt).toBeNull()
    const old=f.restart()
    // 重启后:在跑的那一轮记成中断,回执 held;新进程里没有在跑的轮次。
    expect(f.store.get(taskId)).toMatchObject({status:'interrupted',error:'daemon_restarted'})
    expect(f.store.liveInputs.get(R)?.status).toBe('held')
    // 旧进程那次 spawn 永远不回来(进程已死);新进程的 spawn 照常。
    const releaseOld=release;f.unhold()
    await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    await service!.continueImported(taskId,'接着改',{inputRequestId:R}) // 同一进程里再重发 ⇒ 不再派发
    await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(2) // 旧进程那次(被杀)+ 新进程这一次
    expect(f.spawn.mock.calls[1]?.[1].resumeSessionId).toBe('original')
    expect(f.store.source(taskId)?.firstDispatchedAt).not.toBeNull()
    expect(service!.detail(taskId).events.filter(e=>e.kind==='user'&&e.text==='接着改')).toHaveLength(2)
    expect(service!.detail(taskId).events.filter(e=>e.kind==='system'&&e.text==='CC 重启后按同一请求重发了一次。')).toHaveLength(1)
    expect(f.store.liveInputs.get(R)?.status).toBe('delivered')
    await service!.shutdown();service=undefined;const closing=old.shutdown();releaseOld();await closing
  })
  it('R10:已经派发过、daemon 才重启 ⇒ 同一 requestId 重发不再派发(那句话执行者已经收到)',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    await service!.continueImported(taskId,'接着改',{inputRequestId:R});await settled(taskId)
    const old=f.restart();await old.shutdown()
    const view=await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    expect(view.id).toBe(taskId);expect(f.spawn).toHaveBeenCalledTimes(1)
    await expect(service!.continueImported(taskId,'别的话',{inputRequestId:R})).rejects.toThrow('input_conflict')
  })
})

describe('Task 2 fix round 1',()=>{
  const R='5a7e0000-0000-4000-8000-000000000003'
  const many=(n:number,len=1):NativeHistoryMessage[]=>Array.from({length:n},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',text:`${i}`.padEnd(len,'x'),truncated:false}))
  afterEach(()=>{vi.useRealTimers()})
  it('能 seek 的读取器 ⇒ 直接读尾部 5 页(不一页页翻),挑出来的与一页页翻的一样',async()=>{
    const walk=fixture({messages:many(730,150)})
    const before=walk.read.mock.calls.length
    const a=await service!.adoptNativeSession(walk.item.key)
    expect(walk.read.mock.calls.length-before).toBe(13) // 第一页 + 再翻 7 页 + 导入时重读窗口 5 页
    const walked=service!.detail(a.taskId).events.map(e=>e.text)
    await service!.shutdown();service=undefined;db.close();removeTempDir(dir)
    dir=realpathSync(mkdtempSync(join(tmpdir(),'cc-native-continue-')));db=openDb({path:join(dir,'test.db')});matters=makeMatterStore(db)
    const seek=fixture({messages:many(730,150),seek:true})
    const b=await service!.adoptNativeSession(seek.item.key)
    expect(seek.tailCursor).toHaveBeenCalledWith(seek.item.key,499)
    const tail=['c231','c331','c431','c531','c631'] // 730 − 499 = 231;最后一页 99 条,不多一次空读
    expect(seek.read.mock.calls.map(c=>c[1].cursor??null)).toEqual([null,...tail,...tail]) // 第一页 + 尾部 5 页 + 导入时重读
    expect(service!.detail(b.taskId).events.map(e=>e.text)).toEqual(walked)
    // 第一句照样能接着原会话(prepare 重读这 5 页,指纹对得上)。
    await service!.continueImported(b.taskId,'接着改',{inputRequestId:R});await settled(b.taskId)
    expect(seek.spawn.mock.calls[0]?.[1].resumeSessionId).toBe('original')
  })
  it('能 seek 但会话只有一页 ⇒ 不问 tailCursor,也不多读',async()=>{
    const f=fixture({seek:true})
    await service!.adoptNativeSession(f.item.key)
    expect(f.tailCursor).not.toHaveBeenCalled();expect(f.read).toHaveBeenCalledTimes(2) // inspect + importNativeHistory 重读
  })
  it('不能 seek ⇒ 一页页翻,每页各有单次时限、不共用那 15 秒:每页 2.5 秒、翻 9 页(22.5 秒)照样成功',async()=>{
    vi.useFakeTimers({toFake:['Date']})
    const f=fixture({messages:many(1000),readClockMs:2_500})
    const {taskId}=await service!.adoptNativeSession(f.item.key)
    expect(service!.detail(taskId).events).toHaveLength(200)
  })
  it('不能 seek、翻到尾超过 60 秒总预算(每页 12 秒)⇒ native_history_unavailable,什么都不建',async()=>{
    vi.useFakeTimers({toFake:['Date']})
    const f=fixture({messages:many(900),readClockMs:12_000})
    await expect(service!.adoptNativeSession(f.item.key)).rejects.toThrow('native_history_unavailable')
    expect(service!.list().tasks).toEqual([])
  })
  it('去重表满了只淘汰已落定的:在途的同一 requestId 再来 ⇒ 仍等那一次,不重新开始',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const id=(i:number)=>`5a7e0000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`
    const before=f.read.mock.calls.length,release=f.holdReads()
    const calls=Array.from({length:501},(_,i)=>service!.continueImported(taskId,'接着改',{inputRequestId:id(i)}))
    await vi.waitFor(()=>expect(f.read.mock.calls.length).toBe(before+501))
    const retry=service!.continueImported(taskId,'接着改',{inputRequestId:id(0)})
    await new Promise(r=>setTimeout(r,20))
    expect(f.read.mock.calls.length).toBe(before+501)
    release()
    await Promise.allSettled([...calls,retry])
    await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('同一进程里晚来的重发 ⇒ 给此刻的任务视图,不是第一次那份过期的',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const first=await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    expect(first.status).toBe('queued')
    await settled(taskId)
    const late=await service!.continueImported(taskId,'接着改',{inputRequestId:R})
    expect(late.status).toBe(service!.detail(taskId).task.status);expect(late.status).not.toBe('queued')
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('带附件、还没派发 daemon 就重启 ⇒ 同一 requestId 重发保留同一份附件,不报 invalid_attachment_changed',async()=>{
    const f=fixture(),{taskId}=await service!.adoptNativeSession(f.item.key)
    const draftId=randomUUID(),aid=randomUUID()
    service!.uploadAttachment({id:aid,draftId,taskId,name:'brief.txt',mime:'text/plain',base64:Buffer.from('看这个').toString('base64')})
    f.hold()
    await service!.continueImported(taskId,'看附件',{inputRequestId:R,draftId,attachmentIds:[aid]},'owner')
    await vi.waitFor(()=>expect(f.spawn).toHaveBeenCalledTimes(1))
    const old=f.restart();f.unhold()
    await service!.continueImported(taskId,'看附件',{inputRequestId:R,draftId,attachmentIds:[aid]},'owner')
    await settled(taskId)
    expect(f.spawn).toHaveBeenCalledTimes(2);expect(service!.detail(taskId).task.status).toBe('completed')
    expect(f.store.liveInputs.get(R)?.attachments?.map(a=>a.id)).toEqual([aid])
    const users=service!.detail(taskId).events.filter(e=>e.kind==='user'&&e.text==='看附件')
    expect(users).toHaveLength(2);expect(users[1]?.attachments?.map(a=>a.id)).toEqual([aid])
    await expect(service!.continueImported(taskId,'看附件',{inputRequestId:R,draftId,attachmentIds:[]},'owner')).rejects.toThrow('input_conflict')
    await service!.shutdown();service=undefined;void old.shutdown()
  })
})
