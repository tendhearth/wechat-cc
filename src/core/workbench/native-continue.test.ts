import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
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

// spec 2026-10-01-tendhearth-continue-sessions §4.1:手机「接着做」的核心。真工作台 + 真 matters + 假原生历史读取器。
let dir:string,db:Db,matters:MatterStore,service:WorkbenchService|undefined
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'cc-native-continue-')));db=openDb({path:join(dir,'test.db')});matters=makeMatterStore(db);service=undefined})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(dir)})

const MESSAGES:NativeHistoryMessage[]=[{id:'u',role:'user',text:'original request',truncated:false},{id:'a',role:'assistant',text:'original answer',truncated:false}]

function fixture(o:{provider?:NativeHistoryProvider;messages?:NativeHistoryMessage[];matters?:boolean}={}){
  const providerId=o.provider??'claude'
  const project=join(dir,'proj');mkdirSync(project,{recursive:true})
  const store=makeWorkbenchStore(db),registry=createProviderRegistry()
  let version=1,reads=0,active=false,folderBusy=false,sessionBusy=false,resumable=true,quotaOut=false
  const changeOn=new Set<number>()
  const spawn=vi.fn(async(_p:any,context:any)=>({async *dispatch(){const id=context.resumeSessionId??'fresh-native';yield{kind:'init' as const,sessionId:id};yield{kind:'text' as const,text:'continued'};yield{kind:'result' as const,sessionId:id,numTurns:1,durationMs:1}},async close(){}}))
  // 只登记 claude:codex 的会话用来测「电脑上没装」。
  registry.register('claude',{spawn},{displayName:'Claude',canResume:()=>resumable,workbench:MANAGED_NATIVE_CAPABILITIES})
  const item:NativeHistoryItem={key:encodeNativeHistoryKey(providerId,'original'),providerId,nativeId:'original',title:'Original task',titleSource:'native_custom',cwd:project,updatedAt:1,remote:false,observedState:'unknown'}
  const read=vi.fn(async(_key:string,page:any)=>{reads++;if(changeOn.has(reads))version++;return historyPreview({...item,observedState:active?'active':'unknown'},{version},o.messages??MESSAGES,null,page)})
  const reader:NativeHistoryReader={list:async()=>({items:[item],nextCursor:null,coverage:'native_supported_history'}),read,currentFingerprint:async(key,page={limit:100})=>(await read(key,page)).sourceFingerprint}
  service=makeWorkbenchService({store,registry,stateDir:dir,ownerChatId:()=>'owner',
    nativeHistory:providerId==='codex'?{codex:reader}:{claude:reader},
    ...(o.matters===false?{}:{matters}),
    // nativeId 为 null 问的是「这个文件夹有没有人在用」;带 nativeId 问的是「这个会话有没有人在用」。
    executionConflict:(_path,_provider,nativeId)=>nativeId===null?folderBusy:(folderBusy||sessionBusy),
    usage:id=>quotaOut&&id==='claude'?({providerId:'claude',plan:null,windows:[],exhausted:true,fetchedAt:Date.now()} as never):null})
  return {store,spawn,item,project,read,
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
    const count=()=>['workbench_tasks','workbench_sources','workbench_events','matters'].map(t=>db.query<{n:number},[]>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n)
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
