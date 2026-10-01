# Tendhearth 手机接着做电脑上的会话 Implementation Plan(plan 7b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机「电脑上的会话」读页多一个「接着做」:确认卡说清在哪台电脑、用谁、哪个文件夹、接原会话还是带记录新开、会用额度、先让原来那个停下;确认后这条 Claude Code / Codex 会话变成「一起做」里的一件事,手机进这件事、输入框已聚焦,第一句话在电脑上接着跑;接过的直接「打开这件事」,正在跑的只给灰字。

**Architecture:** 核心工作台原生域新增 `previewNativeContinue` / `adoptNativeSession` / `continueImported`(导入由 daemon 自己挑消息、补建 matter 行;5 分钟决定令牌只在 daemon 内存里一闪而过),「一件事」服务的 `say` 对手机碰到「导入了还没发第一句」的任务改走 `continueImported`,详情多一个 `nativeStart`。daemon 在 `mobile-workbench.ts` 加 `GET|POST /m/api/session/continue`,登记手机路由与协议 schema。手机后端加两个调用与五个细分错误码,纯视图模块决定读页底部、确认卡与失败句,三个页面薄接线。

**Tech Stack:** TypeScript、Bun + vitest(根目录 bun / node 两遍)、zod v4(`@wechat-cc/protocol`)、Expo SDK 57 / Expo Router / React Native 0.86、Maestro(iOS 模拟器 `th-push`)。

**Spec:** `docs/superpowers/specs/2026-10-01-tendhearth-continue-sessions-design.md`(下称 spec)。控制者裁决 1–9 与 spec §2 的补充决定 D1–D14 都有约束力。

## Global Constraints

- 工作树 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc/.claude/worktrees/deploy-dev`,分支 `continue-sessions`(基于 `origin/dev` 7757748d),PR 进 `dev`(squash)。不切分支、不碰兄弟工作树、不用裸 `git stash`、不暂存 `.superpowers/`。提交信息用中文,末尾空一行加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **绝不提交机密**:令牌、`.p8`、`google-services.json`、任何密钥。`git add` 只加本任务列出的文件。
- **绝不劫持正在跑的终端会话**:任何代码路径都不去停、杀、接管电脑上的原生会话;看得见在跑(`active` / `remote` / `executionConflict`)⇒ 拒绝并说明;看不见的靠确认卡上的主人声明(spec D3)。
- **决定令牌不出 daemon**:`prepareNativeResume` 的 token 与 `restartToken` 不进任何手机响应、不进日志、不持久化;手机只传会话 key 与 matterId。
- **说真话**:daemon 没回成功之前,手机不画「在跑」、不画按钮(预览还在问 ⇒ 底部什么都不画);每种拒绝有自己的一句(spec §4.5)。
- **手机路由守卫**:新路由写在 `src/daemon/mobile-workbench.ts`,路径只用 `url.pathname === '/m/api/session/continue'` 字面量(守卫只抓 `===`),同时登记 `src/daemon/phone-routes.ts` 的 `PHONE_ROUTES` 与 `packages/protocol/src/api.ts` 的 `PHONE_API_SCHEMAS`;`scripts/phone-routes.guard.test.ts` 与 `src/daemon/phone-api-schema.test.ts` 双向核对。
- **不加 `/v1/*` 路由、不改桌面**(`apps/desktop/**` 一行不动);桌面 / 内部 API 的 `say` 对导入任务照旧 409 `external_close_confirmation_required`(spec D5)。
- **设计原则**:只留 CC + 功能;全衬线(文字只走 `Txt` / `TextField`);一个强调色只给动作(读页每屏至多一个 `kind="primary"`;确认卡的主按钮是卡里唯一的强调);状态色只上点(`Dot`);无深色;不写字面色值、不设 `fontWeight`(`apps/app/src/ui/style.guard.test.ts` 钉住)。
- **文案 zh + en**:进 `apps/app/src/i18n/{en,zh-Hans}.ts`,键一致;中文全角标点(,。?:「」()),英文弯引号与 ’、破折号 —;以 spec §5 表为准,一字不改。
- 手机里被根目录测试 import 的文件(`apps/app/src/backend/*.ts`、`apps/app/src/net/*.ts`、`apps/app/src/view/*.ts`)必须纯 TS:不 import `react` / `react-native` / `expo-*`。
- 回路(看退出码,别 grep 输出):
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
  - 手机:`cd apps/app && bun run test && bun run typecheck && bun run export:check`
  - 单个根测试文件:`bun --bun vitest run <path>`
  - Maestro(Task 7):模拟器 `th-push`(`UDID=$(cat /tmp/th-push-udid)`;没有就按 `docs/superpowers/plans/2026-09-30-tendhearth-app-push.md` 建一台,不碰别的模拟器),`cd apps/app && bunx expo run:ios --device "$UDID"` 装开发构建后 `maestro --device "$UDID" test .maestro/<flow>.yaml`

## Review Focus

- **「接着做」点了两次 / 超时后再点**:只导入一次、回同一个 matterId(POST 幂等)。Task 1 的「再接回同一件」用例与 Task 5 的 `continueSession` 幂等用例钉住;Task 7 端到端再点一次钉住。
- **第一句话超时后用同一个 requestId 重发**:不起第二轮(spec D6)。Task 2 的「同一 requestId 重发」用例钉住(`spawn` 只被调一次)。
- **确认之后、发第一句之前,会话又在电脑上跑起来了**:第一句被拒(`native_session_busy` ⇒ 手机「这个会话正在电脑上跑…」),什么都不记、不起执行者。Task 2 的「又在跑」用例 + Task 4 的 `mobileMatterError` 409 用例 + Task 6 的 `composeOutcome('session_busy')` 钉住。
- **桌面早先导入过、没有 matter 行的会话**:手机「打开这件事」不再导入、只补 matter 行,进得去。Task 1 的「桌面早先导入过」用例钉住。
- **桌面在同一件导入任务上说话**:仍然要桌面自己的「原程序已关闭」声明,不被手机这条新分支绕过。Task 3 的「桌面 / 没有 surface」用例钉住。

---

### Task 1: 核心 · 能不能接(预览)与接成一件事(导入 + 补 matter 行)

**Files:**
- Modify: `src/core/workbench/native-adoption.ts`(在文件末尾追加)
- Modify: `src/core/workbench/service/native.ts`(新增 `inspectNativeSession` / `previewNativeContinue` / `ensureTaskMatter` / `adoptNativeSession`,并加进 return)
- Modify: `src/core/workbench/service.ts:133-137`(门面暴露两个新函数)
- Create: `src/core/workbench/native-continue.test.ts`

**Interfaces:**
- Consumes: 现有 `importNativeHistory(raw: NativeImportInput)`、`nativeReader(id)`、`historyDeadline()`、`canonicalProject(path)`、`act().provider / quotaExhausted / canResume`、`ctx.deps.executionConflict`、`ctx.deps.matters`(`MatterStore`)。
- Produces(后续任务按这些名字用):
  - `native-adoption.ts`:`selectNativeImportMessages(messages: readonly NativeHistoryMessage[]): NativeHistoryMessage[]`;`NATIVE_IMPORT_MAX_MESSAGES = 200`;`NATIVE_IMPORT_MAX_CHARS = 24_000`;`type NativeContinueState = 'ready'|'managed'|'busy_session'|'busy_folder'|'provider_missing'|'folder_missing'|'quota'|'empty'`;`interface NativeContinuePreview { state: NativeContinueState; providerId: NativeHistoryProvider; project: string|null; mode: 'native_resume'|'fresh_context'|null; taskId: string|null }`;`NATIVE_CONTINUE_REFUSAL: Record<Exclude<NativeContinueState,'ready'|'managed'>, string>`。
  - `WorkbenchService.previewNativeContinue(key: string): Promise<NativeContinuePreview>`;`WorkbenchService.adoptNativeSession(key: string): Promise<{ taskId: string; created: boolean }>`。
  - 错误码:`native_session_busy`、`native_folder_busy`、`unavailable_provider`、`invalid_path`、`provider_quota_exhausted`、`native_history_empty`、`native_history_changed`、`matters_not_wired`、`native_history_unsupported`、`invalid_native_history_key`。

- [ ] **Step 1: 写失败的测试** `src/core/workbench/native-continue.test.ts`

```ts
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
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/native-continue.test.ts`
Expected: FAIL —— `selectNativeImportMessages` 不是导出 / `service.previewNativeContinue is not a function`。

- [ ] **Step 3: `native-adoption.ts` 末尾追加**

```ts
/**
 * 手机「接着做」由 daemon 自己挑要带过来的消息(spec 2026-10-01-tendhearth-continue-sessions D1),与桌面
 * apps/desktop/src/modules/workbench-history.js 的 nativeImportMessages 同一条规则:从最新往前,至多 200 条、
 * 合计 ≤ 24 000 字(readNativeImport 的上限),单条放不下就跳过。桌面那份不动。
 */
export const NATIVE_IMPORT_MAX_MESSAGES=200
export const NATIVE_IMPORT_MAX_CHARS=24_000
export function selectNativeImportMessages(messages:readonly NativeHistoryMessage[]):NativeHistoryMessage[] {
  let budget=NATIVE_IMPORT_MAX_CHARS
  const out:NativeHistoryMessage[]=[]
  for(const m of [...messages].reverse()){
    if(out.length===NATIVE_IMPORT_MAX_MESSAGES)break
    if(m.text.length>budget)continue
    out.unshift(m);budget-=m.text.length
  }
  return out
}
/** 手机「接着做」的预览(spec §4.1、§4.5)。project 只给目录名;taskId 只在 managed 有。 */
export type NativeContinueState='ready'|'managed'|'busy_session'|'busy_folder'|'provider_missing'|'folder_missing'|'quota'|'empty'
export interface NativeContinuePreview {state:NativeContinueState;providerId:NativeHistoryProvider;project:string|null;mode:'native_resume'|'fresh_context'|null;taskId:string|null}
/** 不能接的状态 ⇒ adoptNativeSession 抛的错误码(与工作台其它入口同一套)。 */
export const NATIVE_CONTINUE_REFUSAL:Readonly<Record<Exclude<NativeContinueState,'ready'|'managed'>,string>>={
  busy_session:'native_session_busy',busy_folder:'native_folder_busy',provider_missing:'unavailable_provider',
  folder_missing:'invalid_path',quota:'provider_quota_exhausted',empty:'native_history_empty',
}
```

- [ ] **Step 4: `service/native.ts` —— 导入与四个函数**

文件顶部 import 改成(新增 `basename`、`NativeHistoryPreview`、三个 native-adoption 导出):

```ts
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
```

```ts
import { decodeNativeHistoryKey, historyDeadline, normalizeHistoryList, normalizeHistoryRead, type NativeHistoryListInput, type NativeHistoryPreview, type NativeHistoryProvider, type NativeHistoryReadInput } from '../native-history'
import { NATIVE_CONTINUE_REFUSAL, nativeImportInput, nativeResumeToken, pageInput, publicSource, readNativeImport, selectNativeImportMessages, snapshotHash, type AcceptedNativeResume, type ImportPage, type NativeContinuePreview, type NativeContinueState, type NativeImportInput, type NativeResumeDecision } from '../native-adoption'
```

在 `readNativeHistory` 之后、`return` 之前加:

```ts
  /**
   * 手机「接着做」:这条电脑上的会话现在能不能接、接的话是哪种(spec 2026-10-01-tendhearth-continue-sessions §4.1)。
   * 只读;page 留给 adoptNativeSession 用(省一次读)。判定顺序就是 spec 里的 1–9,别调换:
   * 「已有任务管着」先于一切(接过的永远能打开),「忙」先于「额度」(先说能不能碰,再说碰了会怎样)。
   */
  async function inspectNativeSession(key:string):Promise<{preview:NativeContinuePreview;page:NativeHistoryPreview|null}> {
    const {providerId,nativeId}=decodeNativeHistoryKey(key)
    const managedId=store.sourceByIdentity(providerId,nativeId)?.taskId??store.taskByNativeIdentity(providerId,nativeId)?.id
    if(managedId)return{preview:{state:'managed',providerId,project:basename(store.get(managedId).path),mode:null,taskId:managedId},page:null}
    const page=await historyDeadline()(()=>nativeReader(providerId).read(key,{limit:100}))
    if(page.session.key!==key)throw new Error('native_history_changed')
    const cwd=page.session.cwd,project=cwd?basename(cwd):null
    const out=(state:NativeContinueState,mode:NativeContinuePreview['mode']=null)=>({preview:{state,providerId,project,mode,taskId:null},page})
    let path:string
    try{path=canonicalProject(cwd??'')}catch{return out('folder_missing')}
    if(path!==cwd)return out('folder_missing')
    try{act().provider(providerId)}catch{return out('provider_missing')}
    // 看得见的「在跑」(Codex 的 active / 远程会话)与 CC 自己占着的;普通终端里的 Claude Code 看不见,靠确认卡上的声明(spec D3)。
    if(page.session.remote||page.session.observedState==='active')return out('busy_session')
    if(ctx.deps.executionConflict?.(path,providerId,null))return out('busy_folder')
    if(ctx.deps.executionConflict?.(path,providerId,nativeId))return out('busy_session')
    if(act().quotaExhausted(providerId))return out('quota')
    if(!selectNativeImportMessages(page.messages).length)return out('empty')
    // 还没有任务:用将要建的任务的三样(执行者、会话 id、目录)问能不能恢复 —— 与 prepareNativeResume 的判法一致(spec D2)。
    const resumable=act().canResume({providerId,sessionId:nativeId,path} as StoredTask)
    return out('ready',resumable?'native_resume':'fresh_context')
  }
  async function previewNativeContinue(key:string):Promise<NativeContinuePreview> {
    return (await inspectNativeSession(key)).preview
  }
  /** 导入的任务补一行 matter(spec D4):与 execute.createTask 的登记一致。没接 matters ⇒ 手机进不去,直说。 */
  function ensureTaskMatter(task:StoredTask):void {
    const m=ctx.deps.matters
    if(!m)throw new Error('matters_not_wired')
    if(m.get(task.id))return
    m.create({id:task.id,kind:'task',title:task.title,projectPath:task.path,ownerChatId:task.ownerChatId??null})
    m.linkTask(task.id)
    if(task.ownerChatId)m.bind(task.id,'wechat',task.ownerChatId)
  }
  /**
   * 手机「接着做」/「打开这件事」:幂等。已有任务 ⇒ 只补 matter 行;能接 ⇒ 按桌面同一规则挑消息、走现有导入、补 matter 行;
   * 其余 ⇒ NATIVE_CONTINUE_REFUSAL 里的错误码。读与导入之间会话变了 ⇒ 重来一次。matter 行补建失败不回滚导入:
   * 下次再点走 managed 再补(自愈)。不起执行者、不碰电脑上的原会话。
   */
  async function adoptNativeSession(key:string):Promise<{taskId:string;created:boolean}> {
    ctx.ensureAccepting()
    for(let attempt=0;;attempt++){
      const {preview,page}=await inspectNativeSession(key)
      if(preview.state==='managed'){ensureTaskMatter(store.get(preview.taskId!));return{taskId:preview.taskId!,created:false}}
      if(preview.state!=='ready')throw new Error(NATIVE_CONTINUE_REFUSAL[preview.state])
      const messages=selectNativeImportMessages(page!.messages)
      try{
        const result=await importNativeHistory({key,pages:[{...page!.page,sourceFingerprint:page!.sourceFingerprint}],messageIds:messages.map(m=>m.id)})
        ensureTaskMatter(store.get(result.task.id))
        return{taskId:result.task.id,created:result.created}
      }catch(error){
        if(attempt===0&&error instanceof Error&&error.message==='native_history_changed')continue
        throw error
      }
    }
  }
```

把 return 行改成:

```ts
  return { nativeReader,currentNativePages,validateNativeDecision, previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,listNativeHistory,readNativeHistory,previewNativeContinue,adoptNativeSession }
```

- [ ] **Step 5: 门面 `service.ts`** —— 在 `readNativeHistory:nativeDomain.readNativeHistory,` 之后加两行:

```ts
    /** 手机「接着做」(spec 2026-10-01-tendhearth-continue-sessions):只读预览 / 幂等地接成一件事。 */
    previewNativeContinue:nativeDomain.previewNativeContinue,
    adoptNativeSession:nativeDomain.adoptNativeSession,
```

- [ ] **Step 6: 跑,确认通过**

Run: `bun --bun vitest run src/core/workbench/native-continue.test.ts src/core/workbench/native-adoption.test.ts src/core/workbench/service/native.test.ts`
Expected: PASS。若「一直在变」那条没抛:确认 `changeOnRead(2,4)` 计的是 `read` 的调用次数(预览一次 + 导入一次 = 一轮两次)。

- [ ] **Step 7: 根回路**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck`
Expected: 全绿(退出码 0)。

- [ ] **Step 8: Commit**

```bash
git add src/core/workbench/native-adoption.ts src/core/workbench/service/native.ts src/core/workbench/service.ts src/core/workbench/native-continue.test.ts
git commit -m "接着做电脑会话 Task 1:核心预览与接成一件事(daemon 自己挑消息、补建 matter 行、忙 / 文件夹 / 执行者 / 额度各有错误码)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 核心 · 第一句话(`continueImported`,令牌不出 daemon、按 requestId 幂等)

**Files:**
- Modify: `src/core/workbench/service/native.ts:191-205`(`continueNativeTask` 加可选尾参;新增 `continueImported`)
- Modify: `src/core/workbench/service.ts`(门面暴露 `continueImported`)
- Modify: `src/core/workbench/native-continue.test.ts`(追加一个 describe)

**Interfaces:**
- Consumes: Task 1 的 `adoptNativeSession`;现有 `prepareNativeResume(id, mode)`、`state.nativeDecisions`、`store.liveInputs.get(id)`、`normalizeInputRequestId`(`../live-inputs`)、`checkedText`、`act().canResume / selectAttachments / start / taskView`。
- Produces:
  - `continueNativeTask(id, text, sourceClosedToken, restartToken?, materials = {}, extra: { inputRequestId?: string; attachmentPolicy?: 'owner' } = {})` —— 尾参只透传给 `selectAttachments` 与 `start(...)` 的 `queuedInputId` / `attachmentPolicy`;内部 API 调用不变。
  - `WorkbenchService.continueImported(id: string, text: string, options?: { inputRequestId?: string; draftId?: string; attachmentIds?: string[] }, attachmentPolicy?: 'owner'): Promise<WorkbenchTaskView>` —— 错误码:`input_conflict`(同一 requestId 换了正文)、`invalid_request`(不是「导入了还没发第一句」的任务)、以及 `prepareNativeResume` / `continueNativeTask` 的全部(`native_session_busy`、`workbench_busy`、`external_close_confirmation_stale` 等)。

- [ ] **Step 1: 追加失败的测试**(`src/core/workbench/native-continue.test.ts` 末尾)

```ts
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
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/native-continue.test.ts`
Expected: FAIL —— `service.continueImported is not a function`。

- [ ] **Step 3: 改 `continueNativeTask`、加 `continueImported`**

`native.ts` 顶部加:

```ts
import { normalizeInputRequestId } from '../live-inputs'
```

把 `continueNativeTask` 整个换成(只多了尾参 `extra`,透传两处):

```ts
  async function continueNativeTask(id:string,text:string,sourceClosedToken:string,restartToken?:string,materials:InputMaterials={},extra:{inputRequestId?:string;attachmentPolicy?:'owner'}={}):Promise<WorkbenchTaskView> {
    ctx.ensureAccepting();const task=store.get(id),decision=state.nativeDecisions.get(sourceClosedToken),attachments=act().selectAttachments(materials,id,extra.attachmentPolicy),request=checkedText(text,attachments)
    if(!decision)throw new Error('external_close_confirmation_stale')
    const execution=normalizeExecutionChoice(materials.execution,store.execution.choice(id))
    if(!sameExecutionChoice(execution,decision.execution))throw Error('external_close_confirmation_stale')
    if(state.runsByTask.has(id)||task.archivedAt!==null)throw new Error('workbench_busy')
    await validateNativeDecision(task,decision)
    ctx.ensureAccepting()
    if(act().taskVersion(store.get(id))!==decision.taskVersion||state.runsByTask.has(id)||state.nativeDecisions.get(sourceClosedToken)!==decision)throw new Error('external_close_confirmation_stale')
    const accepted:AcceptedContinuation=decision.mode==='native_resume'?{mode:'resume',sessionId:decision.nativeId}:{mode:'restart',preview:restartPreview(task,store.events(id),store.execution.choice(id))}
    if(accepted.mode==='restart'&&(restartToken!==accepted.preview.token||restartToken!==decision.restartToken))throw new Error('restart_confirmation_stale')
    act().requireInput(task.providerId,act().combinedAttachments(attachments,accepted.mode==='restart'?accepted.preview.attachments:[]),execution,accepted.mode==='resume')
    state.nativeDecisions.delete(sourceClosedToken)
    // extra.inputRequestId 进 start 的 queuedInputId:与 continueTask 同一张回执表,手机超时重发同一句不起第二轮(spec D6)。
    return act().start(task,request,decision.directoryIdentity,accepted,decision,undefined,undefined,extra.inputRequestId,attachments,materials.draftId,execution,undefined,extra.attachmentPolicy)
  }
  /**
   * 手机说的第一句(spec 2026-10-01-tendhearth-continue-sessions D2/D3/D6):确认卡上主人已声明原程序停了;
   * 模式按桌面同一判法(能恢复 ⇒ native_resume,否则 fresh_context);决定令牌与 restartToken 只在这一次调用里活,
   * 从不离开 daemon。先查回执:同一 requestId 重发 ⇒ 原样返回,不起第二轮。
   */
  async function continueImported(id:string,text:string,options:{inputRequestId?:string;draftId?:string;attachmentIds?:string[]}={},attachmentPolicy?:'owner'):Promise<WorkbenchTaskView> {
    ctx.ensureAccepting()
    const inputRequestId=options.inputRequestId===undefined?undefined:normalizeInputRequestId(options.inputRequestId)
    if(inputRequestId!==undefined){
      const prior=store.liveInputs.get(inputRequestId)
      if(prior){
        if(prior.taskId!==id||prior.text!==checkedText(text,prior.attachments??[]))throw new Error('input_conflict')
        return act().taskView(publicTask(store.get(id)))
      }
    }
    const task=store.get(id),source=store.source(id)
    if(!source||source.firstDispatchedAt!==null)throw new Error('invalid_request')
    const prepared=await prepareNativeResume(id,act().canResume(task)?'native_resume':'fresh_context')
    const decision=state.nativeDecisions.get(prepared.token)
    if(!decision)throw new Error('external_close_confirmation_stale')
    const materials:InputMaterials={...(options.draftId!==undefined?{draftId:options.draftId}:{}),...(options.attachmentIds!==undefined?{attachmentIds:options.attachmentIds}:{})}
    return continueNativeTask(id,text,prepared.token,decision.restartToken,materials,{...(inputRequestId!==undefined?{inputRequestId}:{}),...(attachmentPolicy?{attachmentPolicy}:{})})
  }
```

return 行再加 `continueImported`:

```ts
  return { nativeReader,currentNativePages,validateNativeDecision, previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,continueImported,listNativeHistory,readNativeHistory,previewNativeContinue,adoptNativeSession }
```

- [ ] **Step 4: 门面 `service.ts`** —— 在 `continueNativeTask:nativeDomain.continueNativeTask,` 之后加:

```ts
    /** 手机说的第一句给「导入了、还没发过第一句」的任务(spec 2026-10-01-tendhearth-continue-sessions D5)。 */
    continueImported:nativeDomain.continueImported,
```

- [ ] **Step 5: 跑,确认通过**

Run: `bun --bun vitest run src/core/workbench/native-continue.test.ts src/core/workbench/native-adoption.test.ts src/daemon/internal-api/routes-workbench.test.ts`
Expected: PASS(内部 API 的 `/v1/workbench/continue` 用例不受影响)。

- [ ] **Step 6: 根回路**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/core/workbench/service/native.ts src/core/workbench/service.ts src/core/workbench/native-continue.test.ts
git commit -m "接着做电脑会话 Task 2:第一句话 continueImported(决定令牌不出 daemon、按 requestId 幂等、又在跑就拒)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 「一件事」· 手机的第一句走 `continueImported`,详情带 `nativeStart`

**Files:**
- Modify: `src/core/matters/service.ts:14-56`(类型)、`:83-104`(detail)、`:110-139`(say)
- Create: `src/core/matters/service-native.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `WorkbenchService.continueImported`(经 `MattersServiceDeps.workbench`,pipeline-deps 已把整个工作台服务传进来,不用改接线);工作台 `detail()` 已有的 `requiresExternalClose?` / `continuation?`。
- Produces:
  - `export interface MatterNativeStart { mode: 'native_resume' | 'fresh_context'; providerId: string }`;`MatterDetail.nativeStart?: MatterNativeStart`。
  - `MattersServiceDeps.workbench.continueImported?(id, text, options: { inputRequestId?: string } & MatterMaterials, attachmentPolicy?: 'owner'): Promise<MatterTaskView>`。
  - `say(id, text, 'phone', input)` 对 `requiresExternalClose` 的任务调 `continueImported(id, text, { inputRequestId?, draftId?, attachmentIds? }, 'owner')`;其它 surface 不变。

- [ ] **Step 1: 写失败的测试** `src/core/matters/service-native.test.ts`

```ts
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
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/matters/service-native.test.ts`
Expected: FAIL —— 第一条 `continueImported` 没被调(走了 `continueTask` 抛 409);`nativeStart` 为 undefined。

- [ ] **Step 3: 改 `src/core/matters/service.ts`**

类型(`MatterDetail` 那行换掉,并在其前加 `MatterNativeStart`):

```ts
/** 接过来、还没发第一句的电脑会话:第一句会怎样(spec 2026-10-01-tendhearth-continue-sessions D12)。 */
export interface MatterNativeStart {mode:'native_resume'|'fresh_context';providerId:string}
export interface MatterDetail extends MatterTaskControls {matter:Matter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterEvent[];nativeStart?:MatterNativeStart}
```

`MattersServiceDeps.workbench` 里 `detail` 那行换成、并加 `continueImported`:

```ts
    detail(id:string):{task:MatterTaskView;events:MatterEvent[]}&Partial<MatterTaskControls>&{requiresExternalClose?:boolean;continuation?:{mode:string}}
    /** 手机说第一句给「导入了、还没发过第一句」的任务(spec 2026-10-01-tendhearth-continue-sessions D5);没接 ⇒ 手机也走 continueTask(409)。 */
    continueImported?(id:string,text:string,options:{inputRequestId?:string}&MatterMaterials,attachmentPolicy?:'owner'):Promise<MatterTaskView>
```

`detail()` 里:在 `let controls:…` 下一行加 `let nativeStart:MatterNativeStart|undefined`;在 `try{ const d=taskDetail(matter.id);task=d.task;… controls={…} }` 的 `controls={…}` 之后(仍在 try 里)加:

```ts
          if(d.requiresExternalClose)nativeStart={mode:d.continuation?.mode==='restart_required'?'fresh_context':'native_resume',providerId:d.task.providerId}
```

return 改成:

```ts
      return {matter,bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events,...controls,...(nativeStart?{nativeStart}:{})}
```

`say()` 里,在 `const attachmentPolicy=surface==='phone'?'owner':undefined` 之后、`if(input?.runId){` 之前加:

```ts
        // 手机接过来的电脑会话,第一句(spec D5):确认卡就是「原程序已关闭」的声明,令牌在 daemon 里一闪而过。
        // 只认手机:桌面 / 内部 API 照旧拿 409 external_close_confirmation_required,桌面自己的声明按钮不被绕过。
        if(attachmentPolicy&&d.requiresExternalClose&&deps.workbench.continueImported){
          await deps.workbench.continueImported(matter.id,text,{...(requestId!==undefined?{inputRequestId:requestId}:{}),...materials},attachmentPolicy)
          const task=syncTask(id),receipt=requestId?taskDetail(id).inputs?.find(r=>r.taskId===id&&r.id===requestId):undefined
          return {kind:'task',task,...(receipt?{input:publicInput(receipt)}:{})}
        }
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/core/matters/service-native.test.ts src/core/matters/service.test.ts src/core/matters/service-attachments.test.ts`
Expected: PASS。

- [ ] **Step 5: 根回路**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck`
Expected: 全绿(`pipeline-deps.ts` 把整个 `WorkbenchService` 交给 `makeMattersService`,`continueImported` 自动接上;typecheck 若在 `workbench: opts.workbench` 处报 detail 返回类型不兼容,检查 Step 3 的 `continuation?:{mode:string}` 是否写成了可选)。

- [ ] **Step 6: Commit**

```bash
git add src/core/matters/service.ts src/core/matters/service-native.test.ts
git commit -m "接着做电脑会话 Task 3:「一件事」手机第一句走 continueImported(桌面照旧要声明),详情带 nativeStart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 协议 + daemon 路由 `GET|POST /m/api/session/continue`(守卫、schema、接线)

**Files:**
- Modify: `packages/protocol/src/api.ts`(`MatterDetail` 加 `nativeStart`;新 schema;`PHONE_API_SCHEMAS` 两条)
- Modify: `packages/protocol/src/index.ts:21-29`(导出)
- Create: `packages/protocol/src/api-continue.test.ts`
- Modify: `src/daemon/mobile-workbench.ts`(`mobileSessionContinueRoute`、`MobileSessionContinueActions`;`mobileMatterError` 的 409 名单)
- Modify: `src/daemon/phone-routes.ts`(两条登记)
- Modify: `src/daemon/settings-panel.ts`(依赖 + 分发)
- Modify: `src/daemon/wiring/pipeline-deps.ts:620-624`(接线)
- Modify: `src/daemon/mobile-workbench.test.ts`、`src/daemon/phone-api-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `previewNativeContinue` / `adoptNativeSession` / `NativeContinuePreview`;Task 3 的 `nativeStart`。
- Produces:
  - 协议:`SESSION_CONTINUE_STATES`、`SessionContinue`(`{ state, provider: 'claude'|'codex', project: string|null, mode: 'native_resume'|'fresh_context'|null, matterId: string|null }`)、`SessionContinueT`、`SessionContinueResult`(`{ matterId: string, created: boolean }`)、`MatterNativeStart`;`MatterDetail.nativeStart` 可选。
  - daemon:`interface MobileSessionContinueActions { preview(key: string): Promise<NativeContinuePreview>; adopt(key: string): Promise<{ taskId: string; created: boolean }> }`;`mobileSessionContinueRoute(actions, url, req, seen?: (matterId: string) => void): Promise<Response | null>`;`SettingsPanelDeps.sessionContinue?: MobileSessionContinueActions`。
  - 线上形状:见 spec §4.3 表。

- [ ] **Step 1: 写失败的测试**

`packages/protocol/src/api-continue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MatterDetail, PHONE_API_SCHEMAS, SESSION_CONTINUE_STATES, SessionContinue, SessionContinueResult } from './index'

describe('接着做电脑会话的 schema(spec 2026-10-01-tendhearth-continue-sessions §4.3)', () => {
  it('预览接受全部八种状态,拒绝未知状态 / 未知执行者', () => {
    for (const state of SESSION_CONTINUE_STATES) expect(SessionContinue.safeParse({ state, provider: 'codex', project: null, mode: null, matterId: null }).success, state).toBe(true)
    expect(SessionContinue.safeParse({ state: 'running', provider: 'claude', project: 'p', mode: null, matterId: null }).success).toBe(false)
    expect(SessionContinue.safeParse({ state: 'ready', provider: 'cursor', project: 'p', mode: 'native_resume', matterId: null }).success).toBe(false)
  })
  it('两条路由都登记了;成功与错误回包都过', () => {
    const get = PHONE_API_SCHEMAS['GET /m/api/session/continue']!, post = PHONE_API_SCHEMAS['POST /m/api/session/continue']!
    expect(get.safeParse({ ok: true, state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null }).success).toBe(true)
    expect(get.safeParse({ ok: false, error: 'unsupported' }).success).toBe(true)
    expect(post.safeParse({ ok: true, matterId: 'deadbeef', created: false }).success).toBe(true)
    expect(post.safeParse({ ok: false, error: 'native_session_busy' }).success).toBe(true)
    expect(SessionContinueResult.safeParse({ matterId: 'deadbeef' }).success).toBe(false)
  })
  it('MatterDetail:nativeStart 可有可无;有就得是两种模式之一', () => {
    const base = { matter: { id: 'deadbeef', kind: 'task', title: 't', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }, bindings: [], sessions: [], task: null, events: [], permissions: [], questions: [], artifacts: [], inputs: [] }
    expect(MatterDetail.safeParse(base).success).toBe(true)
    expect(MatterDetail.safeParse({ ...base, nativeStart: { mode: 'fresh_context', providerId: 'claude' } }).success).toBe(true)
    expect(MatterDetail.safeParse({ ...base, nativeStart: { mode: 'resume', providerId: 'claude' } }).success).toBe(false)
  })
})
```

`src/daemon/mobile-workbench.test.ts`:import 行改成 `import {describe,expect,it,vi} from 'vitest'` 与 `import {mobileMatterError,mobileSessionContinueRoute,mobileWorkbenchRoute} from './mobile-workbench'`,文件末尾追加:

```ts
describe('手机「接着做」路由(/m/api/session/continue)',()=>{
  const KEY='eyJ2IjoxfQ'
  const url=(q='')=>new URL(`http://phone.test/m/api/session/continue${q}`)
  const ready={state:'ready' as const,providerId:'claude' as const,project:'proj',mode:'native_resume' as const,taskId:null}
  const actions=(o:{preview?:()=>Promise<unknown>;adopt?:()=>Promise<unknown>}={})=>({
    preview:(o.preview??(async()=>ready)) as never,
    adopt:(o.adopt??(async()=>({taskId:'deadbeef',created:true}))) as never,
  })
  const post=(body:unknown)=>new Request(url(),{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)})
  it('不是这条路径 ⇒ null;方法不对 ⇒ 405;没接 ⇒ 503 sessions_not_wired',async()=>{
    const other=new URL('http://phone.test/m/api/session')
    expect(await mobileSessionContinueRoute(actions(),other,new Request(other))).toBeNull()
    expect((await mobileSessionContinueRoute(actions(),url(),new Request(url(),{method:'PUT'})))!.status).toBe(405)
    const r=await mobileSessionContinueRoute(undefined,url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(r!.status).toBe(503);expect(await r!.json()).toEqual({ok:false,error:'sessions_not_wired'})
  })
  it('GET:key 缺 / 重复 / 超长 ⇒ 400;好的 ⇒ 预览(taskId 对外叫 matterId,providerId 叫 provider)',async()=>{
    for(const q of ['','?key=a&key=b',`?key=${'a'.repeat(2049)}`]){
      const r=await mobileSessionContinueRoute(actions(),url(q),new Request(url(q)))
      expect(r!.status,q).toBe(400);expect(await r!.json()).toEqual({ok:false,error:'invalid'})
    }
    const r=await mobileSessionContinueRoute(actions({preview:async()=>({...ready,state:'managed',mode:null,taskId:'deadbeef'})}),url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(await r!.json()).toEqual({ok:true,state:'managed',provider:'claude',project:'proj',mode:null,matterId:'deadbeef'})
  })
  it('POST:只认 {key};坏 JSON / 多余键 ⇒ 400;成功 ⇒ matterId + created,并登记手机露面',async()=>{
    const seen=vi.fn()
    expect((await mobileSessionContinueRoute(actions(),url(),post({key:KEY,x:1}),seen))!.status).toBe(400)
    expect((await mobileSessionContinueRoute(actions(),url(),post('{'),seen))!.status).toBe(400)
    expect((await mobileSessionContinueRoute(actions(),url(),post({key:5}),seen))!.status).toBe(400)
    expect(seen).not.toHaveBeenCalled()
    const r=await mobileSessionContinueRoute(actions(),url(),post({key:KEY}),seen)
    expect(await r!.json()).toEqual({ok:true,matterId:'deadbeef',created:true});expect(seen).toHaveBeenCalledWith('deadbeef')
  })
  it.each([
    ['native_session_busy',409,'native_session_busy'],['native_folder_busy',409,'native_folder_busy'],
    ['native_history_changed',409,'native_history_changed'],['native_history_empty',409,'native_history_empty'],
    ['invalid_path',400,'invalid_path'],['unavailable_provider',503,'unavailable_provider'],
    ['provider_quota_exhausted',503,'provider_quota_exhausted'],['native_history_unsupported',404,'unsupported'],
    ['invalid_native_history_key',400,'invalid'],['matters_not_wired',503,'unavailable'],
  ] as const)('adopt 抛 %s ⇒ HTTP %s %s',async(code,status,error)=>{
    const r=await mobileSessionContinueRoute(actions({adopt:async()=>{throw new Error(code)}}),url(),post({key:KEY}))
    expect(r!.status).toBe(status);expect(await r!.json()).toEqual({ok:false,error})
  })
  it('第一句 matter/say 抛会话忙 / 文件夹忙 / 会话变了 ⇒ 409 原码(以前落成 500)',async()=>{
    for(const code of ['native_session_busy','native_folder_busy','native_history_changed']){
      const r=mobileMatterError(new Error(code));expect(r.status,code).toBe(409);expect(await r.json()).toEqual({ok:false,error:code})
    }
  })
})
```

`src/daemon/phone-api-schema.test.ts`(「真实返回校验 — workbench + matters」那个 describe):
1. 顶部 import 加 `import { encodeNativeHistoryKey, historyPreview, type NativeHistoryItem, type NativeHistoryReader } from '../core/workbench/native-history'`;若没有 `randomUUID`,加 `import { randomUUID } from 'node:crypto'`。
2. describe 里的 `let` 行加 `nativeDir: string`。
3. `beforeEach` 里 `const registry = createProviderRegistry()` 之前加:

```ts
    // 电脑上的一条原生会话(spec 2026-10-01-tendhearth-continue-sessions):nativeId 与假执行者 init 报的一致,恢复才对得上。
    nativeDir = join(root, 'native'); mkdirSync(nativeDir)
    const nativeItem: NativeHistoryItem = { key: encodeNativeHistoryKey('claude', 'phone-schema-native'), providerId: 'claude', nativeId: 'phone-schema-native', title: '原会话', titleSource: 'native_custom', cwd: nativeDir, updatedAt: 1, remote: false, observedState: 'unknown' }
    const nativeRead: NativeHistoryReader['read'] = async (_key, page) => historyPreview(nativeItem, 1, [{ id: 'u', role: 'user', text: '原来的要求', truncated: false }], null, page)
    const nativeReader: NativeHistoryReader = { list: async () => ({ items: [nativeItem], nextCursor: null, coverage: 'native_supported_history' }), read: nativeRead, currentFingerprint: async (key, page = { limit: 100 }) => (await nativeRead(key, page)).sourceFingerprint }
```

4. `makeWorkbenchService({ … matters })` 的对象里加 `nativeHistory: { claude: nativeReader }`;`makeSettingsPanel({ … })` 里(`sessions:` 那行之后)加 `sessionContinue: { preview: k => workbench.previewNativeContinue(k), adopt: k => workbench.adoptNativeSession(k) },`。
5. 在「sessions / session 真实返回符合 schema」之后加:

```ts
  it('session/continue:预览 → 接成一件事 → managed → 详情 nativeStart → 第一句 say,真实返回都符合 schema', async () => {
    const key = encodeNativeHistoryKey('claude', 'phone-schema-native')
    expect(parseAs('GET /m/api/session/continue', await (await request(`/m/api/session/continue?key=${key}`)).json()))
      .toEqual({ ok: true, state: 'ready', provider: 'claude', project: 'native', mode: 'native_resume', matterId: null })
    const post = parseAs('POST /m/api/session/continue', await (await request('/m/api/session/continue', { key })).json()) as { ok: true; matterId: string; created: boolean }
    expect(post.created).toBe(true)
    expect(parseAs('GET /m/api/session/continue', await (await request(`/m/api/session/continue?key=${key}`)).json())).toMatchObject({ state: 'managed', matterId: post.matterId })
    expect(matters.bindings(post.matterId).map(b => b.surface).sort()).toEqual(['phone', 'wechat'])
    expect(parseAs('GET /m/api/matter', await (await request(`/m/api/matter?id=${post.matterId}`)).json())).toMatchObject({ nativeStart: { mode: 'native_resume', providerId: 'claude' } })
    const said = await request('/m/api/matter/say', { id: post.matterId, text: '接着做', requestId: randomUUID() })
    expect(said.status).toBe(200)
    parseAs('POST /m/api/matter/say', await said.json())
    const bad = await request('/m/api/session/continue', { key, extra: 1 })
    expect(bad.status).toBe(400)
    parseAs('POST /m/api/session/continue', await bad.json())
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/protocol/src/api-continue.test.ts src/daemon/mobile-workbench.test.ts src/daemon/phone-api-schema.test.ts`
Expected: FAIL —— `SessionContinue` 未导出、`mobileSessionContinueRoute` 不存在、路由 403/404。

- [ ] **Step 3: 协议 `packages/protocol/src/api.ts`**

`MatterDetail` 换成(加一行 `nativeStart`,其前加 `MatterNativeStart`):

```ts
/** 接过来、还没发第一句的电脑会话(spec 2026-10-01-tendhearth-continue-sessions D12);发过第一句就不再出现。 */
export const MatterNativeStart = z.object({ mode: z.enum(['native_resume', 'fresh_context']), providerId: z.string() })
export const MatterDetail = z.object({
  matter: Matter, bindings: z.array(MatterBinding), sessions: z.array(MatterSession),
  task: MatterTaskView.nullable(), events: z.array(MatterEvent),
  runId: z.string().optional(), inputMode: z.enum(['steer', 'send', 'queue']).optional(),
  permissions: z.array(MatterPermission), questions: z.array(MatterQuestion),
  artifacts: z.array(MatterArtifact), inputs: z.array(MatterInput),
  nativeStart: MatterNativeStart.optional(),
})
```

在 `NativeSessionPageT` 那行之后加:

```ts
// ── 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.3):只给目录名,matterId 只在 managed 有 ──
export const SESSION_CONTINUE_STATES = ['ready', 'managed', 'busy_session', 'busy_folder', 'provider_missing', 'folder_missing', 'quota', 'empty'] as const
export const SessionContinue = z.object({
  state: z.enum(SESSION_CONTINUE_STATES), provider: z.enum(['claude', 'codex']), project: z.string().nullable(),
  mode: z.enum(['native_resume', 'fresh_context']).nullable(), matterId: z.string().nullable(),
})
export type SessionContinueT = z.infer<typeof SessionContinue>
export const SessionContinueResult = z.object({ matterId: z.string(), created: z.boolean() })
```

`PHONE_API_SCHEMAS` 里 `'GET /m/api/session'` 之后加:

```ts
  'GET /m/api/session/continue': z.union([z.object({ ok: z.literal(true) }).extend(SessionContinue.shape), PhoneErrorResponse]),
  'POST /m/api/session/continue': z.union([z.object({ ok: z.literal(true) }).extend(SessionContinueResult.shape), PhoneErrorResponse]),
```

`packages/protocol/src/index.ts` 的 api 导出列表末行改成:

```ts
  NativeSessionRow, NativeSessionMessage, NativeSessionPage,
  MatterNativeStart, SESSION_CONTINUE_STATES, SessionContinue, SessionContinueResult,
} from './api'
export type { DeviceRowT, ConnectionsT, NativeSessionRowT, NativeSessionPageT, SessionContinueT } from './api'
```

- [ ] **Step 4: daemon 路由 `src/daemon/mobile-workbench.ts`**

import 区加:

```ts
import type {NativeContinuePreview} from '../core/workbench/native-adoption'
```

`mobileMatterError` 里 409 那行(`['permission_stale',…,'external_close_confirmation_stale']`)的数组末尾追加 `'native_session_busy','native_folder_busy','native_history_changed'`。

文件末尾追加:

```ts
/** 手机「接着做」电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.3)。直接调核心服务,不经 HTTP 自调。 */
export interface MobileSessionContinueActions {
  preview(key:string):Promise<NativeContinuePreview>
  adopt(key:string):Promise<{taskId:string;created:boolean}>
}
const sessionKey=(v:unknown):string|null=>typeof v==='string'&&v.length>0&&v.length<=2048?v:null
function sessionContinueError(error:unknown):Response {
  const code=error instanceof Error?error.message:''
  if(code==='native_history_unsupported')return json({ok:false,error:'unsupported'},404)
  if(code==='invalid_native_history_key')return json({ok:false,error:'invalid'},400)
  if(['native_session_busy','native_folder_busy','native_history_changed','native_history_empty','native_session_already_managed'].includes(code))return json({ok:false,error:code},409)
  return mobileMatterError(error)
}
/**
 * GET ?key= 只看能不能接(不缓存,裁定 8 的 15 秒缓存不适用:「正在跑」不能晚知道);POST {key} 幂等地接成一件事,
 * 成功后登记手机露面。路径字面量必须写成 `url.pathname === '…'`:scripts/phone-routes.guard.test.ts 只抓这个形状。
 */
export async function mobileSessionContinueRoute(actions:MobileSessionContinueActions|undefined,url:URL,req:Request,seen?:(matterId:string)=>void):Promise<Response|null>{
  const isContinue=url.pathname==='/m/api/session/continue'
  if(!isContinue)return null
  if(req.method!=='GET'&&req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405)
  if(!actions)return json({ok:false,error:'sessions_not_wired'},503)
  try{
    if(req.method==='GET'){
      const keys=url.searchParams.getAll('key'),key=keys.length===1?sessionKey(keys[0]):null
      if(!key)return json({ok:false,error:'invalid'},400)
      const p=await actions.preview(key)
      return json({ok:true,state:p.state,provider:p.providerId,project:p.project,mode:p.mode,matterId:p.taskId})
    }
    let body:unknown
    try{body=await req.json()}catch{return json({ok:false,error:'invalid'},400)}
    if(!object(body)||Object.keys(body).some(k=>k!=='key'))return json({ok:false,error:'invalid'},400)
    const key=sessionKey(body.key)
    if(!key)return json({ok:false,error:'invalid'},400)
    const r=await actions.adopt(key)
    try{seen?.(r.taskId)}catch{/* 只是露面登记 */}
    return json({ok:true,matterId:r.taskId,created:r.created})
  }catch(error){return sessionContinueError(error)}
}
```

- [ ] **Step 5: 登记与接线**

`src/daemon/phone-routes.ts`,`'GET /m/api/session',` 之后加:

```ts
  // 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions,mobile-workbench.ts):预览 + 接成一件事
  'GET /m/api/session/continue',
  'POST /m/api/session/continue',
```

`src/daemon/settings-panel.ts`:
- import 行改成 `import {mobileSessionContinueRoute,mobileWorkbenchRoute,mobileMatterError,mobileSayInput,type MobileMatterActions,type MobileEntryActions,type MobileUploadActions,type MobileSessionContinueActions} from './mobile-workbench'`。
- 依赖接口里 `sessions?: …` 之后加:

```ts
  /** 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions)。缺省 ⇒ /m/api/session/continue 503。 */
  sessionContinue?: MobileSessionContinueActions
```

- `const mobileResponse=await mobileWorkbenchRoute(…);if(mobileResponse)return mobileResponse` 之后加:

```ts
          const continueResponse=await mobileSessionContinueRoute(deps.sessionContinue,url,req,id=>deps.matters?.seenOnPhone(id))
          if(continueResponse)return continueResponse
```

`src/daemon/wiring/pipeline-deps.ts`,`...(phoneSessions ? { sessions: phoneSessions } : {}),` 之后加:

```ts
    // 在手机上接着做电脑上的会话:预览不缓存(「正在跑」不能晚 15 秒才知道),接成一件事幂等。
    ...(opts.workbench ? { sessionContinue: { preview: (k: string) => opts.workbench!.previewNativeContinue(k), adopt: (k: string) => opts.workbench!.adoptNativeSession(k) } } : {}),
```

- [ ] **Step 6: 跑,确认通过**

Run: `bun --bun vitest run packages/protocol/src/api-continue.test.ts src/daemon/mobile-workbench.test.ts src/daemon/phone-api-schema.test.ts scripts/phone-routes.guard.test.ts src/daemon/phone-routes.test.ts`
Expected: PASS(守卫:源码里多抓到 `/m/api/session/continue`,`PHONE_ROUTES` 也有;schema 守卫两条都有 schema)。

- [ ] **Step 7: 根回路 + 手机(协议改了,手机的类型从协议推)**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck && cd apps/app && bun run test && bun run typecheck && cd -`
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/api.ts packages/protocol/src/index.ts packages/protocol/src/api-continue.test.ts src/daemon/mobile-workbench.ts src/daemon/mobile-workbench.test.ts src/daemon/phone-routes.ts src/daemon/settings-panel.ts src/daemon/wiring/pipeline-deps.ts src/daemon/phone-api-schema.test.ts
git commit -m "接着做电脑会话 Task 4:GET|POST /m/api/session/continue(协议 schema、手机路由登记、第一句的忙码 409)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 手机后端 · `continuePreview` / `continueSession` 与五个细分错误码(真连接 + 演示)

**Files:**
- Modify: `apps/app/src/backend/types.ts`
- Modify: `apps/app/src/backend/live.ts`(两个方法)
- Modify: `apps/app/src/backend/demo.ts`(两个方法、`session().managed`、`say` 清 `nativeStart`、`reset`)
- Modify: `apps/app/src/net/errors.ts`
- Modify: `apps/app/src/net/errors.test.ts`、`apps/app/src/backend/live.test.ts`、`apps/app/src/backend/demo.test.ts`

**Interfaces:**
- Consumes: Task 4 的协议 `SessionContinue` / `SessionContinueT` / `MatterDetail.nativeStart`、路由形状。
- Produces:
  - `export type SessionContinueT`(从 `@wechat-cc/protocol` 推)。
  - `BackendCode` 增 `'session_busy' | 'folder_busy' | 'provider_missing' | 'folder_missing' | 'quota'`。
  - `Backend.continuePreview(key: string): Promise<SessionContinueT>`;`Backend.continueSession(key: string): Promise<{ matterId: string }>`。
  - 演示:`demo-claude-1` ⇒ `busy_session`;`demo-claude-2` ⇒ `ready`/`native_resume`(project `notes`);`demo-codex-1` ⇒ `ready`/`fresh_context`;接过 ⇒ `managed`。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/net/errors.test.ts`,第一个 `it.each` 之后加:

```ts
  it.each([
    [409, { ok: false, error: 'native_session_busy' }, 'session_busy'],
    [409, { ok: false, error: 'native_folder_busy' }, 'folder_busy'],
    [503, { ok: false, error: 'unavailable_provider' }, 'provider_missing'],
    [400, { ok: false, error: 'invalid_path' }, 'folder_missing'],
    [503, { ok: false, error: 'provider_quota_exhausted' }, 'quota'],
    [409, { ok: false, error: 'native_history_changed' }, 'unknown'],
    [400, { ok: false, error: 'invalid_text' }, 'invalid'],
  ] as const)('接着做电脑会话的码(spec D11):%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })
```

`apps/app/src/backend/live.test.ts`,「connections / sessions / session 走对应路由」之后加:

```ts
  it('接着做:continuePreview / continueSession 走 /m/api/session/continue(POST 幂等可重发);会话忙 ⇒ session_busy', async () => {
    const PRE = { ok: true, state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null }
    const { b, reqs } = harness({
      'GET /m/api/session/continue': ok(PRE),
      'POST /m/api/session/continue': ({ body }) => body.key === 'busy' ? ok({ ok: false, error: 'native_session_busy' }, 409) : ok({ ok: true, matterId: 'deadbeef', created: true }),
    })
    expect(await b.continuePreview('a/b')).toEqual({ state: 'ready', provider: 'claude', project: 'proj', mode: 'native_resume', matterId: null })
    expect(reqs.at(-1)!.path).toBe('/m/api/session/continue?key=a%2Fb')
    expect(await b.continueSession('k')).toEqual({ matterId: 'deadbeef' })
    expect(reqs.at(-1)).toMatchObject({ key: 'POST /m/api/session/continue', body: { key: 'k' }, retry: true })
    await expect(b.continueSession('busy')).rejects.toMatchObject({ code: 'session_busy' })
  })
```

`apps/app/src/backend/demo.test.ts`:顶部 protocol import 加 `MatterDetail, SessionContinue`(若该文件别处用的是动态 import 的 `MatterDetail`,保留那里不动,顶部再静态 import 一次不冲突);describe 末尾加:

```ts
  it('接着做(演示):进行中的那条 ⇒ busy;另两条 ready(恢复 / 新开);接成一件事带 nativeStart,再点回同一件;第一句后 nativeStart 消失;reset 清掉', async () => {
    vi.useFakeTimers()
    try {
      const b = makeDemoBackend({ lang: 'zh-Hans' })
      expect(SessionContinue.parse(await b.continuePreview('demo-claude-1'))).toMatchObject({ state: 'busy_session', provider: 'claude', matterId: null })
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'ready', mode: 'native_resume', project: 'notes' })
      expect(await b.continuePreview('demo-codex-1')).toMatchObject({ state: 'ready', mode: 'fresh_context', provider: 'codex' })
      await expect(b.continueSession('demo-claude-1')).rejects.toMatchObject({ code: 'session_busy' })
      await expect(b.continuePreview('nope')).rejects.toMatchObject({ code: 'not_found' })
      const { matterId } = await b.continueSession('demo-claude-2')
      expect((await b.continueSession('demo-claude-2')).matterId).toBe(matterId)
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'managed', matterId })
      expect((await b.session('demo-claude-2')).managed).toBe(true)
      const d = MatterDetail.parse(await b.matter(matterId, 'zh-Hans'))
      expect(d.nativeStart).toEqual({ mode: 'native_resume', providerId: 'claude' })
      expect(d.task?.status).toBe('interrupted')
      expect(d.events.map(e => e.kind)).toEqual(['user', 'text', 'user'])
      expect((await b.matters('zh-Hans')).some(m => m.id === matterId)).toBe(true)
      await b.say(matterId, '接着把首页改完', 'r-continue')
      expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2000)
      b.reset()
      expect(await b.continuePreview('demo-claude-2')).toMatchObject({ state: 'ready', matterId: null })
    } finally { vi.useRealTimers() }
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun x vitest run src/net/errors.test.ts src/backend/live.test.ts src/backend/demo.test.ts; cd -`
Expected: FAIL —— 新码映射成 `unknown` / `invalid`;`b.continuePreview is not a function`。

- [ ] **Step 3: `types.ts`**

import 列表加 `SessionContinue`;类型区加:

```ts
export type SessionContinueT = z.infer<typeof SessionContinue>
```

`BackendCode` 换成:

```ts
/** BackendCode 的全集(映射见 src/net/errors.ts)。后五个是「接着做电脑会话」细分出来的(spec 2026-10-01-tendhearth-continue-sessions D11)。 */
export type BackendCode = 'stale' | 'busy' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unavailable' | 'unknown'
  | 'session_busy' | 'folder_busy' | 'provider_missing' | 'folder_missing' | 'quota'
```

`Backend` 接口里 `session(...)` 之后加:

```ts
  /** 这个电脑上的会话能不能在手机上接着做(不缓存,每次问电脑)。读不了 ⇒ BackendError('not_found')。 */
  continuePreview(key: string): Promise<SessionContinueT>
  /** 接成一件事并返回它的 matterId;幂等(同一个会话再点回同一件、接过的只补登记)。拒绝 ⇒ session_busy / folder_busy / provider_missing / folder_missing / quota。 */
  continueSession(key: string): Promise<{ matterId: string }>
```

- [ ] **Step 4: `net/errors.ts`**

在 `NOT_FOUND` 之后加:

```ts
/** 接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions D11):各有各的一句话,不能都说「没送到」。
 *  必须在 `invalid_` 前缀规则之前判(invalid_path ⇒ folder_missing)。 */
const SPECIFIC: ReadonlyMap<string, BackendCode> = new Map<string, BackendCode>([
  ['native_session_busy', 'session_busy'], ['native_folder_busy', 'folder_busy'],
  ['unavailable_provider', 'provider_missing'], ['invalid_path', 'folder_missing'], ['provider_quota_exhausted', 'quota'],
])
```

`mapPhoneError` 里 `if (err && BUSY.has(err)) return 'busy'` 之后加:

```ts
  const specific = err ? SPECIFIC.get(err) : undefined
  if (specific) return specific
```

- [ ] **Step 5: `live.ts`**

类型 import 里加 `type SessionContinueT`;`session(key, cursor)` 方法之后加:

```ts
    async continuePreview(key) {
      return strip(await call<{ ok: true } & SessionContinueT>('GET /m/api/session/continue', `/m/api/session/continue?key=${encodeURIComponent(key)}`))
    },
    async continueSession(key) {
      // 幂等(spec D9):超时后协议客户端可以原样重发,daemon 回同一件事。
      const r = await call<{ matterId: string; created: boolean }>('POST /m/api/session/continue', '/m/api/session/continue', { body: { key }, retry: true })
      return { matterId: r.matterId }
    },
```

- [ ] **Step 6: `demo.ts`**

类型 import 加 `type SessionContinueT`;在 `let deviceLabel = ''` 之后加:

```ts
  // 接着做(演示,spec 2026-10-01-tendhearth-continue-sessions §4.4):会话 key → 接成的那件事
  let adopted = new Map<string, string>()
```

在 `const conn: Connection = …` 之前加:

```ts
  /** 演示里三条会话能不能接:进行中的那条看得见在跑;另两条一条能恢复、一条只能带记录新开。 */
  const DEMO_CONTINUE: Record<string, { state: SessionContinueT['state']; mode: SessionContinueT['mode'] }> = {
    'demo-claude-1': { state: 'busy_session', mode: null },
    'demo-claude-2': { state: 'ready', mode: 'native_resume' },
    'demo-codex-1': { state: 'ready', mode: 'fresh_context' },
  }
  const sessionRow = (key: string) => { const row = demoSessions(lastLang, now()).find(r => r.key === key); if (!row) throw new BackendError('not_found'); return row }
```

`session(key)` 里 `managed: false` 改成 `managed: adopted.has(key)`;在它之后加:

```ts
    async continuePreview(key) {
      const row = sessionRow(key), matterId = adopted.get(key) ?? null
      if (matterId) return { state: 'managed', provider: row.provider, project: row.project, mode: null, matterId }
      const c = DEMO_CONTINUE[key] ?? { state: 'empty', mode: null }
      return { state: c.state, provider: row.provider, project: row.project, mode: c.mode, matterId: null }
    },
    async continueSession(key) {
      const dup = adopted.get(key)
      if (dup) return { matterId: dup }
      const row = sessionRow(key), c = DEMO_CONTINUE[key]
      if (!c || c.state !== 'ready' || !c.mode) throw new BackendError(c?.state === 'busy_session' ? 'session_busy' : 'unknown')
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      adopted.set(key, matterId)
      const ts = now(), path = `~/Projects/${row.project ?? 'demo'}`
      const e: Entry = {
        stage: 'replied', version: 1, seeded: false,
        // 导入的原记录:与 daemon 一致,user ⇒ user、assistant ⇒ text
        evs: demoSessionMessages(lastLang).map((m, i) => ({ kind: m.role === 'user' ? 'user' : 'text', text: m.text, createdAt: ts - 1000 + i })),
        detail: mkDetail(mkMatter(matterId, 'task', row.title, 'open', path, ts),
          { id: matterId, title: row.title, status: 'interrupted', providerId: row.provider, path, error: null, updatedAt: ts },
          { nativeStart: { mode: c.mode, providerId: row.provider } }),
      }
      entries.set(matterId, e); order.unshift(matterId); publish([matterId])
      return { matterId }
    },
```

`say(id, text, requestId)` 里把 `evText(e, 'user', text); touch(e, {}); publish([id])` 换成:

```ts
      evText(e, 'user', text)
      // 接过来的那件事:第一句一发,「第一句会怎样」的说明就该消失(与 daemon 一致)
      if (e.detail.nativeStart) { const { nativeStart: _sent, ...rest } = e.detail; e.detail = rest; touch(e, { phase: 'working' }) }
      else touch(e, {})
      publish([id])
```

`reset()` 里加 `adopted = new Map();`(放在 `saidBy = new Set();` 之后)。

- [ ] **Step 7: 跑,确认通过**

Run: `cd apps/app && bun x vitest run src/net/errors.test.ts src/backend/live.test.ts src/backend/demo.test.ts; cd -`
Expected: PASS。

- [ ] **Step 8: 手机回路 + 根(根目录的 live e2e 也 import 这些文件)**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd - && bun run test && bun run typecheck`
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add apps/app/src/backend/types.ts apps/app/src/backend/live.ts apps/app/src/backend/demo.ts apps/app/src/net/errors.ts apps/app/src/net/errors.test.ts apps/app/src/backend/live.test.ts apps/app/src/backend/demo.test.ts
git commit -m "接着做电脑会话 Task 5:手机后端 continuePreview / continueSession(真连接幂等重发 + 演示三态)与五个细分错误码

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 手机界面 · 读页「接着做」+ 确认卡 + 进这件事(输入框聚焦)+ 第一句说明

**Files:**
- Create: `apps/app/src/view/continue.ts`、`apps/app/src/view/continue.test.ts`
- Modify: `apps/app/src/view/compose.ts`、`apps/app/src/view/compose.test.ts`
- Modify: `apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`
- Modify: `apps/app/src/app/sessions/[key].tsx`(整份替换)
- Modify: `apps/app/src/app/compose.tsx`、`apps/app/src/app/matter/[id].tsx`

**Interfaces:**
- Consumes: Task 5 的 `Backend.continuePreview / continueSession`、`SessionContinueT`、新 `BackendCode`;`MatterDetailT.nativeStart`(Task 4)。
- Produces:
  - `view/continue.ts`:`providerName(p: string, lang): string`;`type ContinueBlock = { kind: 'none' } | { kind: 'continue'; label } | { kind: 'open'; label } | { kind: 'note'; text; retry: boolean }`;`continueBlock(p: SessionContinueT | 'loading' | 'failed', lang): ContinueBlock`;`continueSheetLines(p: SessionContinueT, lang): string[]`;`continueErrorText(code: string, provider: string, lang): string`;`continueErrorDot(code: string): 'bad' | 'warn' | 'unknown'`;`CONTINUE_RECHECK: ReadonlySet<string>`;`nativeStartLines(n: { mode; providerId }, lang): string[]`。
  - `view/compose.ts`:`ComposeOutcome` 增 `'sessionBusy' | 'folderBusy' | 'providerMissing' | 'folderMissing' | 'quota'`;`composeOutcomeText(o: ComposeOutcome, lang, provider: string | null): string`。
  - testID:`session-continue`、`session-open`、`session-continue-note`、`session-continue-retry`、`session-continue-error`、`continue-sheet`、`continue-line-<i>`、`continue-confirm`、`continue-cancel`、`continue-error`、`compose-native-start`、`progress-native-start`。路由:`/compose?matter=<id>&focus=1`。

- [ ] **Step 1: 文案** —— `apps/app/src/i18n/en.ts` 删 `'sessions.readOnly'` 一行,在 `} as const` 之前加:

```ts
  'continue.action': 'Continue here',
  'continue.open': 'Open this task',
  'continue.title': 'Continue from your phone?',
  'continue.runsOn': 'It runs on your computer with {provider}, in the folder {project}.',
  'continue.unknownFolder': '(unknown)',
  'continue.modeResume': 'It picks up the same session, so it remembers what was said.',
  'continue.modeFresh': 'The original session can’t be resumed, so it starts a new round and brings the earlier conversation along.',
  'continue.quotaNote': 'This uses your {provider} quota.',
  'continue.stopFirst': 'First stop the original {provider} on your computer. CC can’t check that for you.',
  'continue.confirm': 'It’s stopped — continue',
  'continue.busySession': 'This session is running on your computer. You can continue once it stops',
  'continue.busyFolder': 'CC is busy with something else in this folder. You can continue once it’s done',
  'continue.providerMissing': '{provider} isn’t installed on your computer',
  'continue.providerMissingAny': 'This helper isn’t installed on your computer',
  'continue.folderMissing': 'This session’s folder is no longer on your computer',
  'continue.quota': 'This helper is out of quota. Try again after it resets.',
  'continue.empty': 'There’s nothing in this session to bring along',
  'continue.unknown': 'Can’t check right now whether this can continue',
  'continue.uncertain': 'Not sure your computer got it. Tapping again won’t do it twice.',
  'continue.firstResume': 'Your first message continues the original {provider} session on your computer.',
  'continue.firstFresh': 'Your first message starts a new round with the earlier conversation attached.',
```

`apps/app/src/i18n/zh-Hans.ts` 删 `'sessions.readOnly'` 一行,在末尾 `}` 之前加:

```ts
  'continue.action': '接着做',
  'continue.open': '打开这件事',
  'continue.title': '在手机上接着做？',
  'continue.runsOn': '会在你的电脑上用 {provider} 接着做，文件夹是 {project}。',
  'continue.unknownFolder': '（未知）',
  'continue.modeResume': '接着原来的会话，它记得之前说过的话。',
  'continue.modeFresh': '原来的会话没法直接接上，会新开一轮，把之前的对话记录一起带上。',
  'continue.quotaNote': '会用掉 {provider} 的额度。',
  'continue.stopFirst': '先让电脑上原来那个 {provider} 停下。CC 没法替你确认它停了。',
  'continue.confirm': '已经停了，接着做',
  'continue.busySession': '这个会话正在电脑上跑，停下后才能接着做',
  'continue.busyFolder': 'CC 正在这个文件夹里做别的事，做完后才能接着做',
  'continue.providerMissing': '电脑上没装 {provider}',
  'continue.providerMissingAny': '电脑上没装这个执行者',
  'continue.folderMissing': '电脑上找不到这个会话的文件夹了',
  'continue.quota': '这个执行者的额度已用完。等额度恢复后再试。',
  'continue.empty': '这个会话里没有能带过来的内容',
  'continue.unknown': '现在确认不了能不能接着做',
  'continue.uncertain': '不确定电脑收到没有。再点一次不会重复。',
  'continue.firstResume': '你发的第一句会接着电脑上原来的 {provider} 会话。',
  'continue.firstFresh': '你发的第一句会新开一轮，带上之前的对话记录。',
```

- [ ] **Step 2: 写失败的测试**

`apps/app/src/view/continue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { SessionContinueT } from '../backend/types'
import { CONTINUE_RECHECK, continueBlock, continueErrorDot, continueErrorText, continueSheetLines, nativeStartLines, providerName } from './continue'

// spec 2026-10-01-tendhearth-continue-sessions §4.4 / §4.5 / §5
const P = (o: Partial<SessionContinueT> = {}): SessionContinueT => ({ state: 'ready', provider: 'claude', project: 'portfolio', mode: 'native_resume', matterId: null, ...o })

describe('continueBlock:会话读页底部那一块', () => {
  it('还在问 ⇒ 不画(不先画一个可能用不了的按钮);问不到 ⇒ 灰字 + 再试', () => {
    expect(continueBlock('loading', 'zh-Hans')).toEqual({ kind: 'none' })
    expect(continueBlock('failed', 'zh-Hans')).toEqual({ kind: 'note', text: '现在确认不了能不能接着做', retry: true })
  })
  it('ready ⇒「接着做」;managed ⇒「打开这件事」', () => {
    expect(continueBlock(P(), 'zh-Hans')).toEqual({ kind: 'continue', label: '接着做' })
    expect(continueBlock(P({ state: 'managed', mode: null, matterId: 'deadbeef' }), 'en')).toEqual({ kind: 'open', label: 'Open this task' })
  })
  it.each([
    ['busy_session', '这个会话正在电脑上跑，停下后才能接着做'],
    ['busy_folder', 'CC 正在这个文件夹里做别的事，做完后才能接着做'],
    ['provider_missing', '电脑上没装 Claude Code'],
    ['folder_missing', '电脑上找不到这个会话的文件夹了'],
    ['quota', '这个执行者的额度已用完。等额度恢复后再试。'],
    ['empty', '这个会话里没有能带过来的内容'],
  ] as const)('%s ⇒ 一行灰字、没有按钮', (state, text) => {
    expect(continueBlock(P({ state, mode: null }), 'zh-Hans')).toEqual({ kind: 'note', text, retry: false })
  })
})

describe('continueSheetLines:确认卡', () => {
  it('恢复原会话:在哪、用谁、记得之前的话、会用额度、先让原来那个停下', () => {
    expect(continueSheetLines(P(), 'zh-Hans')).toEqual([
      '会在你的电脑上用 Claude Code 接着做，文件夹是 portfolio。',
      '接着原来的会话，它记得之前说过的话。',
      '会用掉 Claude Code 的额度。',
      '先让电脑上原来那个 Claude Code 停下。CC 没法替你确认它停了。',
    ])
  })
  it('新开一轮(Codex,英文)', () => {
    expect(continueSheetLines(P({ provider: 'codex', mode: 'fresh_context', project: 'trip' }), 'en')).toEqual([
      'It runs on your computer with Codex, in the folder trip.',
      'The original session can’t be resumed, so it starts a new round and brings the earlier conversation along.',
      'This uses your Codex quota.',
      'First stop the original Codex on your computer. CC can’t check that for you.',
    ])
  })
  it('没有目录名 ⇒ 写「未知」,不留空', () => {
    expect(continueSheetLines(P({ project: null }), 'zh-Hans')[0]).toBe('会在你的电脑上用 Claude Code 接着做，文件夹是 （未知）。')
  })
})

describe('continueErrorText / continueErrorDot / CONTINUE_RECHECK:提交失败', () => {
  it.each([
    ['session_busy', '这个会话正在电脑上跑，停下后才能接着做', 'warn'],
    ['folder_busy', 'CC 正在这个文件夹里做别的事，做完后才能接着做', 'warn'],
    ['provider_missing', '电脑上没装 Codex', 'bad'],
    ['folder_missing', '电脑上找不到这个会话的文件夹了', 'bad'],
    ['quota', '这个执行者的额度已用完。等额度恢复后再试。', 'warn'],
    ['uncertain', '不确定电脑收到没有。再点一次不会重复。', 'unknown'],
    ['revoked', '这台手机已不再配对', 'bad'],
    ['offline', '没有送到电脑上，请稍后再试。', 'bad'],
  ])('%s ⇒ 「%s」,点 %s', (code, text, dot) => {
    expect(continueErrorText(code, 'codex', 'zh-Hans')).toBe(text)
    expect(continueErrorDot(code)).toBe(dot)
  })
  it('状态类失败之后重问一次预览(按钮 / 灰字跟着变);网络类不重问', () => {
    expect([...CONTINUE_RECHECK].sort()).toEqual(['folder_busy', 'folder_missing', 'provider_missing', 'quota', 'session_busy'])
  })
})

describe('nativeStartLines / providerName', () => {
  it('第一句会怎样 + 先让原来那个停下', () => {
    expect(nativeStartLines({ mode: 'native_resume', providerId: 'codex' }, 'zh-Hans')).toEqual(['你发的第一句会接着电脑上原来的 Codex 会话。', '先让电脑上原来那个 Codex 停下。CC 没法替你确认它停了。'])
    expect(nativeStartLines({ mode: 'fresh_context', providerId: 'claude' }, 'en')[0]).toBe('Your first message starts a new round with the earlier conversation attached.')
  })
  it('只认 claude / codex,别的原样', () => {
    expect(providerName('claude', 'en')).toBe('Claude Code')
    expect(providerName('cursor', 'en')).toBe('cursor')
  })
})
```

`apps/app/src/view/compose.test.ts`:import 改成 `import { composeOutcome, composeOutcomeDot, composeOutcomeText, composeTooLong } from './compose'`,末尾加:

```ts
describe('接着做电脑会话的失败码(spec D11)', () => {
  it('五个码各有各的页内提示;忙 / 额度 ⇒ 琥珀(等一等),没装 / 文件夹不在 ⇒ 红', () => {
    expect([composeOutcome('session_busy'), composeOutcome('folder_busy'), composeOutcome('provider_missing'), composeOutcome('folder_missing'), composeOutcome('quota')])
      .toEqual(['sessionBusy', 'folderBusy', 'providerMissing', 'folderMissing', 'quota'])
    expect([composeOutcomeDot('sessionBusy'), composeOutcomeDot('folderBusy'), composeOutcomeDot('quota')]).toEqual(['warn', 'warn', 'warn'])
    expect([composeOutcomeDot('providerMissing'), composeOutcomeDot('folderMissing')]).toEqual(['bad', 'bad'])
  })
  it('composeOutcomeText:一句话;没装执行者时有名字说名字,没有就说「这个执行者」;旧的几种不变', () => {
    expect(composeOutcomeText('providerMissing', 'zh-Hans', 'claude')).toBe('电脑上没装 Claude Code')
    expect(composeOutcomeText('providerMissing', 'zh-Hans', null)).toBe('电脑上没装这个执行者')
    expect(composeOutcomeText('sessionBusy', 'zh-Hans', null)).toBe('这个会话正在电脑上跑，停下后才能接着做')
    expect(composeOutcomeText('ccBusy', 'zh-Hans', null)).toBe('CC 还在忙这件事，等这一轮做完再说。')
    expect(composeOutcomeText('revoked', 'zh-Hans', null)).toBe('这台手机已不再配对')
    expect(composeOutcomeText('failed', 'en', null)).toBe('This didn’t reach your computer. Please try again in a moment.')
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `cd apps/app && bun x vitest run src/view/continue.test.ts src/view/compose.test.ts src/i18n/i18n.test.ts; cd -`
Expected: FAIL —— `./continue` 不存在、`composeOutcomeText` 不存在。

- [ ] **Step 4: `apps/app/src/view/continue.ts`**

```ts
import type { SessionContinueT } from '../backend/types'
import { t, type Lang } from '../i18n'

/**
 * 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.4 / §4.5):读页底部那一块、确认卡、
 * 提交失败的那一句、接过来的事「第一句会怎样」。纯函数;页面只照着画。
 */

/** {provider} 填的名字:与会话页的分段同名;别的执行者原样(这一版只有 claude / codex 会走到这里)。 */
export const providerName = (p: string, lang: Lang): string =>
  p === 'claude' ? t(lang, 'sessions.claude') : p === 'codex' ? t(lang, 'sessions.codex') : p

export type ContinueBlock =
  | { kind: 'none' }
  | { kind: 'continue'; label: string }
  | { kind: 'open'; label: string }
  | { kind: 'note'; text: string; retry: boolean }

type Refusal = Exclude<SessionContinueT['state'], 'ready' | 'managed'>
function refusalText(state: Refusal, provider: string, lang: Lang): string {
  switch (state) {
    case 'busy_session': return t(lang, 'continue.busySession')
    case 'busy_folder': return t(lang, 'continue.busyFolder')
    case 'provider_missing': return t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) })
    case 'folder_missing': return t(lang, 'continue.folderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'empty': return t(lang, 'continue.empty')
  }
}

/** 还在问 ⇒ 不画;能接 ⇒ 唯一的强调按钮;接过了 ⇒ 打开那件事;不能接 ⇒ 一句灰字说为什么(问不到才给「再试一次」)。 */
export function continueBlock(p: SessionContinueT | 'loading' | 'failed', lang: Lang): ContinueBlock {
  if (p === 'loading') return { kind: 'none' }
  if (p === 'failed') return { kind: 'note', text: t(lang, 'continue.unknown'), retry: true }
  if (p.state === 'ready') return { kind: 'continue', label: t(lang, 'continue.action') }
  if (p.state === 'managed') return { kind: 'open', label: t(lang, 'continue.open') }
  return { kind: 'note', text: refusalText(p.state, p.provider, lang), retry: false }
}

/** 确认卡:在哪台电脑、用谁、哪个文件夹;接原会话还是带记录新开(从不让人选,spec D2);会用额度;先让原来那个停下(spec D3)。 */
export function continueSheetLines(p: SessionContinueT, lang: Lang): string[] {
  const provider = providerName(p.provider, lang)
  return [
    t(lang, 'continue.runsOn', { provider, project: p.project ?? t(lang, 'continue.unknownFolder') }),
    t(lang, p.mode === 'fresh_context' ? 'continue.modeFresh' : 'continue.modeResume'),
    t(lang, 'continue.quotaNote', { provider }),
    t(lang, 'continue.stopFirst', { provider }),
  ]
}

/** 这几种失败说明电脑那边的状态变了:失败后重问一次预览,让底部按钮 / 灰字跟上。 */
export const CONTINUE_RECHECK: ReadonlySet<string> = new Set(['session_busy', 'folder_busy', 'provider_missing', 'folder_missing', 'quota'])

/** 「接着做」/「打开这件事」提交失败 ⇒ 一句话。code 是 BackendCode 或 store 的 'uncertain'。 */
export function continueErrorText(code: string, provider: string, lang: Lang): string {
  switch (code) {
    case 'session_busy': return t(lang, 'continue.busySession')
    case 'folder_busy': return t(lang, 'continue.busyFolder')
    case 'provider_missing': return t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) })
    case 'folder_missing': return t(lang, 'continue.folderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'uncertain': return t(lang, 'continue.uncertain')
    case 'revoked': return t(lang, 'conn.revokedTitle')
    default: return t(lang, 'compose.failed')
  }
}

/** 那一句前面的点(状态色只上点):不知道收没收到 ⇒ 灰;等一等就好 ⇒ 琥珀;做不了 ⇒ 红。 */
export function continueErrorDot(code: string): 'bad' | 'warn' | 'unknown' {
  if (code === 'uncertain') return 'unknown'
  if (code === 'session_busy' || code === 'folder_busy' || code === 'quota') return 'warn'
  return 'bad'
}

/** 接过来、还没发第一句的那件事(进展页 / 说一句页顶上):第一句会怎样 + 先让原来那个停下。 */
export function nativeStartLines(n: { mode: 'native_resume' | 'fresh_context'; providerId: string }, lang: Lang): string[] {
  const provider = providerName(n.providerId, lang)
  return [
    t(lang, n.mode === 'fresh_context' ? 'continue.firstFresh' : 'continue.firstResume', { provider }),
    t(lang, 'continue.stopFirst', { provider }),
  ]
}
```

- [ ] **Step 5: `apps/app/src/view/compose.ts`**

文件顶部加:

```ts
import { t, type Lang } from '../i18n'
import { providerName } from './continue'
```

`composeOutcome`、`ComposeOutcome`、`composeOutcomeDot` 换成:

```ts
/** 提交失败码 ⇒ 页内提示。revoked 单列:手机已不再配对,「稍后再试」是错的(横幅由 ConnectionNotice 讲)。
 *  后五个是接着做电脑会话细分出来的(spec 2026-10-01-tendhearth-continue-sessions D11)。 */
export function composeOutcome(error: string): 'uncertain' | 'ccBusy' | 'revoked' | 'failed' | 'sessionBusy' | 'folderBusy' | 'providerMissing' | 'folderMissing' | 'quota' {
  if (error === 'uncertain') return 'uncertain'
  if (error === 'busy') return 'ccBusy'
  if (error === 'revoked') return 'revoked'
  if (error === 'session_busy') return 'sessionBusy'
  if (error === 'folder_busy') return 'folderBusy'
  if (error === 'provider_missing') return 'providerMissing'
  if (error === 'folder_missing') return 'folderMissing'
  if (error === 'quota') return 'quota'
  return 'failed'
}

export type ComposeOutcome = 'failed' | 'uncertain' | 'busy' | 'ccBusy' | 'tooLong' | 'revoked' | 'sessionBusy' | 'folderBusy' | 'providerMissing' | 'folderMissing' | 'quota'

/** 页内提示前面的状态点:没送到 / 送不了 ⇒ 红;不知道送没送到 ⇒ 灰;只是要等一等 ⇒ 琥珀。文字本身一律 inkSoft。 */
export function composeOutcomeDot(o: ComposeOutcome): 'bad' | 'unknown' | 'warn' {
  if (o === 'uncertain') return 'unknown'
  if (o === 'busy' || o === 'ccBusy' || o === 'sessionBusy' || o === 'folderBusy' || o === 'quota') return 'warn'
  return 'bad'
}

/** 页内提示那一句。provider:说的是哪个执行者(一件事的 task.providerId / 交办时选的);不知道 ⇒ 说「这个执行者」。 */
export function composeOutcomeText(o: ComposeOutcome, lang: Lang, provider: string | null): string {
  switch (o) {
    case 'uncertain': return t(lang, 'compose.uncertain')
    case 'busy': return t(lang, 'compose.busy')
    case 'ccBusy': return t(lang, 'common.ccBusy')
    case 'tooLong': return t(lang, 'compose.tooLong')
    case 'revoked': return t(lang, 'conn.revokedTitle')
    case 'sessionBusy': return t(lang, 'continue.busySession')
    case 'folderBusy': return t(lang, 'continue.busyFolder')
    case 'providerMissing': return provider ? t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) }) : t(lang, 'continue.providerMissingAny')
    case 'folderMissing': return t(lang, 'continue.folderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'failed': return t(lang, 'compose.failed')
  }
}
```

- [ ] **Step 6: 跑纯函数测试,确认通过**

Run: `cd apps/app && bun x vitest run src/view/continue.test.ts src/view/compose.test.ts src/i18n/i18n.test.ts; cd -`
Expected: PASS。

- [ ] **Step 7: 会话读页 —— 整份替换 `apps/app/src/app/sessions/[key].tsx`**

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NativeSessionPageT, SessionContinueT } from '../../backend/types'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useSubmit } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Dot } from '../../ui/Dot'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { canSubmit } from '../../view/connection'
import { CONTINUE_RECHECK, continueBlock, continueErrorDot, continueErrorText, continueSheetLines } from '../../view/continue'

type Msg = NativeSessionPageT['messages'][number]
type Cont = SessionContinueT | 'loading' | 'failed'

// 读一个电脑上的会话 + 在手机上接着做(spec 2026-10-01-tendhearth-continue-sessions §4.4)。
// 消息:首页进来就拉,「继续读取」按 nextCursor 追加。底部:先问电脑能不能接(不缓存),问到之前什么都不画。
export default function SessionReader() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const { key: raw } = useLocalSearchParams<{ key: string }>()
  const key = decodeURIComponent(String(raw ?? ''))
  const [title, setTitle] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'slow'>('loading')
  const [moreFailed, setMoreFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const req = useRef(0) // 每次换 key / 发新请求 +1;返回时对不上就丢弃,换 key 后新的加载不会被旧的锁挡掉
  const busyRef = useRef(false)
  // 接着做:预览、确认卡、提交
  const [cont, setCont] = useState<Cont>('loading')
  const [sheet, setSheet] = useState(false)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<{ text: string; dot: 'bad' | 'warn' | 'unknown' } | null>(null)
  const contReq = useRef(0)
  const online = canSubmit(conn)

  const load = async (cursor?: string) => {
    if (cursor && busyRef.current) return
    const my = ++req.current
    if (cursor) { busyRef.current = true; setBusy(true) }
    try {
      const p = await backend.session(key, cursor)
      if (my !== req.current) return
      setTitle(p.session.title)
      setMsgs(m => (cursor ? [...m, ...p.messages] : p.messages))
      setNext(p.nextCursor)
      setState('ok'); setMoreFailed(false)
    } catch (e) {
      if (my !== req.current) return
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
      if (cursor) setMoreFailed(true)
      else setState(code === 'not_found' ? 'missing' : 'slow')
    } finally { if (cursor && my === req.current) { busyRef.current = false; setBusy(false) } }
  }
  /** 问电脑这条能不能接。重连(epoch 前进)、点开确认卡、状态类失败之后都重问。 */
  const check = async () => {
    const my = ++contReq.current
    try { const p = await backend.continuePreview(key); if (my === contReq.current) setCont(p) }
    catch { if (my === contReq.current) setCont('failed') }
  }
  useEffect(() => {
    busyRef.current = false; setBusy(false)
    setTitle(''); setMsgs([]); setNext(null); setMoreFailed(false); setState('loading')
    setCont('loading'); setSheet(false); setFailure(null)
    void load()
    return () => { req.current++ }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void check()
    return () => { contReq.current++ }
  }, [key, conn.epoch]) // eslint-disable-line react-hooks/exhaustive-deps

  const provider = typeof cont === 'object' ? cont.provider : 'claude'
  const block = continueBlock(cont, lang)
  /** 「接着做」与「打开这件事」都走同一个幂等 POST;daemon 回成功之前页面上不出现任何「在跑」。 */
  const adopt = async (then: (matterId: string) => void) => {
    if (sending) return
    setSending(true); setFailure(null)
    const box: { id: string | null } = { id: null }
    const r = await submit(`continue:${key}`, async () => { box.id = (await backend.continueSession(key)).matterId })
    setSending(false)
    if (r === 'ok' && box.id) { then(box.id); return }
    if (r === 'busy') return // 同一个请求还在路上(本机)
    const code = r === 'ok' ? 'unknown' : r.error
    setFailure({ text: continueErrorText(code, provider, lang), dot: continueErrorDot(code) })
    if (CONTINUE_RECHECK.has(code)) void check()
  }
  const confirm = () => adopt(id => {
    setSheet(false)
    // 成了一件事:读页换成这件事的进展页,再叠上说一句页(输入框已聚焦),返回就是这件事。
    router.replace(`/matter/${encodeURIComponent(id)}`)
    router.push(`/compose?matter=${encodeURIComponent(id)}&focus=1`)
  })
  const openExisting = () => adopt(id => router.push(`/matter/${encodeURIComponent(id)}`))
  const openSheet = () => { setFailure(null); setSheet(true); void check() }

  const failureRow = (testID: string) => failure ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind={failure.dot} size={8} />
      <Txt testID={testID} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{failure.text}</Txt>
    </View>
  ) : null

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={title || t(lang, 'sessions.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/sessions'))} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.m }}>
        {state === 'loading' ? <Txt role="bubble" tone="inkSoft">{t(lang, 'sessions.loading')}</Txt> : null}
        {state === 'missing' ? <Txt testID="sessions-unsupported" role="bubble" tone="inkSoft">{t(lang, 'sessions.unsupported')}</Txt> : null}
        {state === 'slow' ? (
          <View style={{ gap: space.m }}>
            <Txt testID="sessions-slow" role="bubble" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt>
            <Button kind="secondary" testID="session-retry" label={t(lang, 'common.retry')} onPress={() => void load()} />
          </View>
        ) : null}
        {msgs.map((m, i) => {
          const mine = m.role === 'user'
          return (
            <View
              key={`${m.id}:${i}`}
              testID={`session-message-${i}`}
              style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: c.paper, borderColor: c.hair, borderWidth: 1, paddingHorizontal: space.l, paddingVertical: space.m, gap: space.xs,
                borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble, borderBottomLeftRadius: mine ? radius.bubble : 4, borderBottomRightRadius: mine ? 4 : radius.bubble }}
            >
              <Txt selectable role="body" content="user">{m.text}</Txt>
              {m.truncated ? <Txt role="caption" tone="inkSoft">{t(lang, 'chat.truncated')}</Txt> : null}
            </View>
          )
        })}
        {state === 'ok' && next ? (
          <View style={{ gap: space.s }}>
            {moreFailed ? <Txt testID="sessions-slow" role="meta" tone="inkSoft">{t(lang, 'sessions.slow')}</Txt> : null}
            <Button kind="secondary" testID="session-more" label={t(lang, 'sessions.readMore')} busy={busy} onPress={() => void load(next)} />
          </View>
        ) : null}
      </ScrollView>

      {block.kind === 'none' ? null : (
        <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m, gap: space.s }}>
          {block.kind === 'continue' ? (
            <Button kind="primary" testID="session-continue" label={block.label} onPress={openSheet} disabled={!online} />
          ) : block.kind === 'open' ? (
            <Button kind="primary" testID="session-open" label={block.label} onPress={() => void openExisting()} disabled={!online} busy={sending} />
          ) : (
            <>
              <Txt testID="session-continue-note" role="meta" tone="inkSoft">{block.text}</Txt>
              {block.retry ? <Button kind="secondary" testID="session-continue-retry" label={t(lang, 'common.retry')} onPress={() => void check()} /> : null}
            </>
          )}
          {sheet ? null : failureRow('session-continue-error')}
        </View>
      )}

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable accessibilityLabel={t(lang, 'common.cancel')} style={{ flex: 1, backgroundColor: c.scrim }} onPress={() => setSheet(false)} />
        <View testID="continue-sheet" style={{ backgroundColor: c.paper, padding: space.xl, gap: space.m, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
          <Txt role="item" accessibilityRole="header">{t(lang, 'continue.title')}</Txt>
          {typeof cont === 'object' && cont.state === 'ready' ? (
            <>
              {continueSheetLines(cont, lang).map((line, i) => <Txt key={i} testID={`continue-line-${i}`} role="bubble" content="user">{line}</Txt>)}
              {failureRow('continue-error')}
              <Button kind="primary" testID="continue-confirm" label={t(lang, 'continue.confirm')} onPress={() => void confirm()} disabled={!online} busy={sending} />
            </>
          ) : block.kind === 'note' ? (
            // 点开时重问,电脑那边变了(开始跑了 / 额度用完了):只说为什么,收起主按钮
            <Txt testID="continue-sheet-note" role="bubble" tone="inkSoft">{block.text}</Txt>
          ) : null}
          <Button kind="secondary" testID="continue-cancel" label={t(lang, 'common.cancel')} onPress={() => setSheet(false)} />
        </View>
      </Modal>
    </SafeAreaView>
  )
}
```

- [ ] **Step 8: 说一句页 `apps/app/src/app/compose.tsx`**

1. import:`import { composeOutcome, composeOutcomeDot, composeOutcomeText, composeTooLong, type ComposeOutcome } from '../view/compose'`;加 `import { nativeStartLines } from '../view/continue'`。
2. 参数行 `const matter = one(useLocalSearchParams<{ matter?: string }>().matter) || undefined` 换成:

```tsx
  const params = useLocalSearchParams<{ matter?: string; focus?: string }>()
  const matter = one(params.matter) || undefined
  // 从「接着做」进来:输入框直接聚焦,主人接着打字(spec §4.4)
  const focus = one(params.focus) === '1'
```

3. `const options = useQuery('entryOptions', …)` 之后加:

```tsx
  // 说的是一件事:读它的详情(与进展页共用缓存)—— 接过来还没发第一句的,顶上说清第一句会怎样;失败句要知道执行者叫什么
  const detail = useQuery(`matter:${matter ?? ''}`, l => backend.matter(matter ?? '', l), { enabled: !!matter })
  const nativeStart = matter ? detail.data?.nativeStart : undefined
```

4. `{matter ? (<Txt role="caption" tone="inkSoft">{t(lang, 'compose.continueHint')}</Txt>) : (…)}` 的 matter 分支换成:

```tsx
            <>
              <Txt role="caption" tone="inkSoft">{t(lang, 'compose.continueHint')}</Txt>
              {nativeStart ? (
                <View testID="compose-native-start" style={{ gap: space.xs }}>
                  {nativeStartLines(nativeStart, lang).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
                </View>
              ) : null}
            </>
```

5. `<TextField testID="compose-input" …` 加一行属性 `autoFocus={focus}`。
6. outcome 那一行的 `{t(lang, outcome === 'uncertain' ? … : 'compose.failed')}` 整个换成:

```tsx
{composeOutcomeText(outcome, lang, matter ? detail.data?.task?.providerId ?? null : provider?.id ?? null)}
```

- [ ] **Step 9: 进展页 `apps/app/src/app/matter/[id].tsx`**

import 加 `import { nativeStartLines } from '../../view/continue'`;`<View testID="progress-status"><StatusPill status={v.status} /></View>` 之后加:

```tsx
        {d.nativeStart ? (
          // 接过来、还没发第一句的电脑会话(spec D12):第一句会怎样 + 先让原来那个停下;发过第一句就没有了
          <View testID="progress-native-start" style={{ gap: space.xs }}>
            {nativeStartLines(d.nativeStart, lang).map((line, i) => <Txt key={i} role="meta" tone="inkSoft">{line}</Txt>)}
          </View>
        ) : null}
```

- [ ] **Step 10: 手机回路**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd -`
Expected: 全绿(`style.guard.test.ts`:没有字面色值 / `fontWeight` / 裸 `Text`)。

- [ ] **Step 11: 根回路(根测试 import 手机的 view / backend)**

Run: `bun run test && bun run typecheck`
Expected: 全绿。

- [ ] **Step 12: Commit**

```bash
git add apps/app/src/view/continue.ts apps/app/src/view/continue.test.ts apps/app/src/view/compose.ts apps/app/src/view/compose.test.ts apps/app/src/i18n/en.ts apps/app/src/i18n/zh-Hans.ts "apps/app/src/app/sessions/[key].tsx" apps/app/src/app/compose.tsx "apps/app/src/app/matter/[id].tsx"
git commit -m "接着做电脑会话 Task 6:手机读页「接着做」+ 确认卡(先让原来那个停下)+ 进这件事输入框聚焦 + 第一句说明;各种拒绝各说各的

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 端到端(LiveBackend 对真 daemon)+ Maestro 演示流 + 文档

**Files:**
- Modify: `src/daemon/phone-app-live-e2e.test.ts`(夹具加原生历史与 `sessionContinue`;新用例)
- Create: `apps/app/.maestro/continue-session.yaml`
- Modify: `docs/roadmap.md`(7a 那条之后加 7b 一条)、`docs/INDEX.md`(加一行)

**Interfaces:**
- Consumes: Task 1–6 的全部;夹具里的 `live()`、`release()`、`P`。
- Produces: 无新接口。

- [ ] **Step 1: 写端到端用例**(`src/daemon/phone-app-live-e2e.test.ts`)

1. import 加 `import { encodeNativeHistoryKey, historyPreview, type NativeHistoryItem, type NativeHistoryReader } from '../core/workbench/native-history'`。
2. 模块级 `let` 区加 `let nativeDir: string`。
3. `beforeEach` 里 `const registry = createProviderRegistry()` 之前加:

```ts
  // 电脑上的原生会话(spec 2026-10-01-tendhearth-continue-sessions):e2e-native 能接(nativeId 与假执行者 init 报的一致);
  // e2e-busy 看得见正在跑(observedState active)。两条都在 native 目录。
  nativeDir = join(root, 'native'); mkdirSync(nativeDir, { recursive: true })
  const nativeItem = (nativeId: string): NativeHistoryItem => ({ key: encodeNativeHistoryKey('claude', nativeId), providerId: 'claude', nativeId, title: `原会话 ${nativeId}`, titleSource: 'native_custom', cwd: nativeDir, updatedAt: 1, remote: false, observedState: nativeId === 'e2e-busy' ? 'active' : 'unknown' })
  const nativeItems = [nativeItem('e2e-native'), nativeItem('e2e-busy')]
  const nativeRead: NativeHistoryReader['read'] = async (key, page) => {
    const item = nativeItems.find(i => i.key === key)
    if (!item) throw new Error('native_history_unavailable')
    return historyPreview(item, 1, [{ id: 'u', role: 'user', text: '原来的要求', truncated: false }, { id: 'a', role: 'assistant', text: '原来的回答', truncated: false }], null, page)
  }
  const nativeReader: NativeHistoryReader = { list: async () => ({ items: nativeItems, nextCursor: null, coverage: 'native_supported_history' }), read: nativeRead, currentFingerprint: async (key, page = { limit: 100 }) => (await nativeRead(key, page)).sourceFingerprint }
```

4. `makeWorkbenchService({ … handoffGraceMs: 0 })` 的对象里加 `nativeHistory: { claude: nativeReader }`;`makeSettingsPanel({ … })` 里(`matters:` 那行之后)加 `sessionContinue: { preview: k => workbench.previewNativeContinue(k), adopt: k => workbench.adoptNativeSession(k) },`。
5. 在「连接:真快照过 schema…」用例之后加:

```ts
  it('接着做电脑上的会话:预览 ready → 接成一件事(再点同一件)→ managed → 详情 nativeStart → 第一句接着原会话跑完 → nativeStart 消失;正在跑的会话 ⇒ busy', async () => {
    const b = live()
    await expect.poll(() => b.connection().state, P).toBe('online')
    const key = encodeNativeHistoryKey('claude', 'e2e-native')
    expect(await b.continuePreview(key)).toEqual({ state: 'ready', provider: 'claude', project: 'native', mode: 'native_resume', matterId: null })
    const { matterId } = await b.continueSession(key)
    expect((await b.continueSession(key)).matterId).toBe(matterId)
    expect(await b.continuePreview(key)).toMatchObject({ state: 'managed', matterId })
    expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toEqual({ mode: 'native_resume', providerId: 'claude' })
    expect((await b.matters('zh-Hans')).some(m => m.id === matterId)).toBe(true)
    await b.say(matterId, '接着做', randomUUID())
    await release({ path: nativeDir })
    await expect.poll(async () => (await b.matter(matterId, 'zh-Hans')).events.some(e => e.text === '做完了'), P).toBe(true)
    expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toBeUndefined()
    const busy = encodeNativeHistoryKey('claude', 'e2e-busy')
    expect(await b.continuePreview(busy)).toMatchObject({ state: 'busy_session', matterId: null })
    await expect(b.continueSession(busy)).rejects.toMatchObject({ code: 'session_busy' })
  })
```

- [ ] **Step 2: 跑**

Run: `bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts`
Expected: PASS(原有用例不受影响:没接 `sessions` 依赖,「原生会话没接上 ⇒ unavailable」那条照旧)。若新用例卡在 `release`:确认 `nativeDir` 是 `realpathSync` 过的 `root` 下的路径(`canonicalProject` 比的是真实路径)。

- [ ] **Step 3: Maestro 流** `apps/app/.maestro/continue-session.yaml`

```yaml
# 设置 → 电脑上的会话 → 正在跑的那条只有灰字、没有按钮 → 另一条「接着做」→ 确认卡(先让原来那个停下)
# → 进这件事、说一句页输入框已聚焦(直接打字,不点输入框)→ 发出 → 回到这件事,话在对话里,「第一句」说明消失。演示模式。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- tapOn:
    id: welcome-look-first
- extendedWaitUntil:
    visible:
      id: now-connections
    timeout: 10000
- tapOn:
    id: topbar-settings
- scrollUntilVisible:
    element:
      id: settings-sessions
- tapOn:
    id: settings-sessions
- extendedWaitUntil:
    visible:
      id: sessions-row-demo-claude-1
    timeout: 5000
- tapOn:
    id: sessions-row-demo-claude-1
- extendedWaitUntil:
    visible:
      id: session-continue-note
    timeout: 5000
- assertVisible: ".*(正在电脑上跑|running on your computer).*"
- assertNotVisible:
    id: session-continue
- tapOn:
    id: topbar-back
- tapOn:
    id: sessions-row-demo-claude-2
- extendedWaitUntil:
    visible:
      id: session-continue
    timeout: 5000
- tapOn:
    id: session-continue
- extendedWaitUntil:
    visible:
      id: continue-sheet
    timeout: 5000
- assertVisible: ".*(先让电脑上原来那个|First stop the original).*"
- tapOn:
    id: continue-confirm
- extendedWaitUntil:
    visible:
      id: compose-input
    timeout: 5000
- assertVisible:
    id: compose-native-start
- inputText: "finish the homepage"
- tapOn:
    id: compose-send
- extendedWaitUntil:
    visible:
      id: progress-conversation
    timeout: 5000
- scrollUntilVisible:
    element:
      text: ".*finish the homepage.*"
- assertNotVisible:
    id: progress-native-start
```

- [ ] **Step 4: 手机回路 + Maestro**

Run:

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check
UDID=$(cat /tmp/th-push-udid) && bunx expo run:ios --device "$UDID"
maestro --device "$UDID" test .maestro/continue-session.yaml && maestro --device "$UDID" test .maestro/connections.yaml && maestro --device "$UDID" test .maestro/compose.yaml
cd -
```

Expected: 三个流 PASS(`connections.yaml` 读会话那段不再断言「只读」;`compose.yaml` 不受 `focus` 影响)。若 `inputText` 没打进输入框:说明 `autoFocus` 没生效 —— 回 Task 6 Step 8 检查 `focus` 参数(`/compose?matter=…&focus=1`),不要在流里补一个 `tapOn: compose-input` 盖过去。

- [ ] **Step 5: 文档**

`docs/roadmap.md`:在「配对体验(plan 7a)」那条之后加一条(并把那条末尾的「下一份 = 7b(手机上接着电脑上的会话)。」改成「7b 见下一条。」):

```markdown
- **手机接着做电脑上的会话(plan 7b)**(2026-10-01,`continue-sessions` 分支):手机「电脑上的会话」读页一个「接着做」→ 确认卡(在哪台电脑、用 Claude Code / Codex、哪个文件夹、会用额度;接原会话还是带记录新开从不让人选,两者在核心里互斥;卡即「原程序已关闭」声明,因为普通终端里的 Claude Code CC 看不见)→ 成为「一起做」的一件事、进去输入框已聚焦,第一句在 daemon 里一次完成 prepare + continue(决定令牌不出 daemon,按 requestId 幂等)。接过的 ⇒「打开这件事」(幂等 POST,桌面早先导入、没有 matter 行的顺手补上);看得见在跑 ⇒ 灰字,绝不劫持。新路由 `GET|POST /m/api/session/continue`;桌面不改。spec `docs/superpowers/specs/2026-10-01-tendhearth-continue-sessions-design.md`。主人事项:真机各验一条 Claude Code / Codex;要不要让 hook 成为前提;额度耗尽时换执行者。
```

`docs/INDEX.md`:在「配对体验(plan 7a…)」那一行之后加:

```markdown
| 手机接着做电脑上的会话(plan 7b:预览 / 接成一件事 / 第一句、确认卡即声明、忙与额度各说各的) | [roadmap.md](roadmap.md) | spec `superpowers/specs/2026-10-01-tendhearth-continue-sessions-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-continue-sessions.md` |
```

- [ ] **Step 6: 全量回路(最后一次)**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck && bun --bun vitest run apps/desktop && cd apps/app && bun run test && bun run typecheck && bun run export:check && cd -`
Expected: 全绿(桌面单测没改代码,应原样通过)。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/phone-app-live-e2e.test.ts apps/app/.maestro/continue-session.yaml docs/roadmap.md docs/INDEX.md
git commit -m "接着做电脑会话 Task 7:LiveBackend 对真 daemon 端到端 + Maestro 演示流 + roadmap / INDEX

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
