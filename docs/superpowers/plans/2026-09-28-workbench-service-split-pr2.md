# workbench service 拆分 · PR 2(attachments 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `makeWorkbenchService` 里的 attachments 域(材料的作用域判定、选择、合并、handoff 校验、分块上传句柄 + 6 个 public 方法)逐字搬进 `src/core/workbench/service/attachments.ts`,`service.ts` 解构接回 —— **行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1(`docs/superpowers/plans/2026-09-28-workbench-service-split-pr1.md`):域工厂 `makeAttachmentsDomain(ctx)` 返回函数集;`service.ts` 对内部帮手解构(调用点不变),public 对象直接引用域方法。本 PR 给 `ServiceCtx` 加两样域必需、又不该各自复制的东西:`deps.ownerChatId`(主人身份的唯一来源)与 `ensureAccepting`(停机闸,一处定义)。两个懒初始化的 `let`(`materialUploads`)随域走;`managedWorkspaces` 属 entry 域,本 PR 不动。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 2 项)。基线 dev `f90b8d24`。

## Global Constraints

- 分支 `sweep/workbench-service-split-2`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、事件文案、限额数值(8 个 / 24 MiB / `workbench_archived` / `workbench_stopping` / `attachment_scope` / `invalid_entry_owner` / `invalid_handoff_attachment` / `invalid_attachment_context_limit`)。逐字搬,注释一起搬。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。`service/review.test.ts` 是 PR 1 自己的,允许为 ctx 新字段补两项。
- `service/*.ts` 禁止 import `../service`(棘轮守卫 + depcruise error 兜底)。
- 每个任务一个 commit,中文、写清「行为不变」,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`discardAttachment` 两条分支的作用域不同**:上传请求还在(`store.uploadRequestExists`)走 `strictAttachmentScope()`(没配主人就抛 `invalid_entry_owner`),已落库的走 `attachmentScope()`(没配主人 ⇒ `undefined`,放行)。搬家后两条分支必须各自保持 —— Task 2 域单测「没配主人:已落库材料可丢、上传中材料抛 invalid_entry_owner」钉住。
2. **`uploads()` 的懒初始化只初始化一次**,且 `onTransaction` 日志经 `ctx.log`,没配 log 时不抛 —— Task 2 域单测「两次调用 uploads() 只建一个 attachmentUploads」钉住(spy `store.attachmentUploads`)。
3. **`continuationAttachmentScope` 的老任务放行条件三者缺一不可**(已配主人 + `ids` 是空数组 + 任务 `ownerChatId===null`)—— PR 1 评审第 1 条的修复就在这里,搬家不能把 `Array.isArray(ids)` 弄丢。Task 2 域单测三条边界钉住。
4. **`ensureAccepting` 只在 service.ts 定义一次**,域经 `ctx.ensureAccepting()`;搬家后 `state.stopping=true` 时 `uploadAttachment` / `uploadAttachmentChunk` 必须抛 `workbench_stopping` —— Task 2 域单测钉住。
5. **`combinedAttachments` 的去重顺序**:`previous` 在前、`current` 在后,同 id 以 `current` 覆盖但保留 `previous` 的位置 —— Task 2 域单测「同 id 取 current 的字段、位置在 previous 处」钉住。

---

### Task 1: `ServiceCtx` 加 `deps.ownerChatId` 与 `ensureAccepting`

**Files:**
- Modify: `src/core/workbench/service/ctx.ts`
- Modify: `src/core/workbench/service.ts`(ctx 字面量;`ensureAccepting` 定义位置不变,只是同时塞进 ctx)
- Modify: `src/core/workbench/service/review.test.ts`(`setup()` 的 ctx 字面量补两个字段)

**Interfaces:**
- Produces:
  ```ts
  export interface ServiceDeps { ownerChatId: () => string | null }
  export interface ServiceCtx {
    store: WorkbenchStore
    stateDir: string
    state: WorkbenchRuntimeState
    hub: ServiceHub
    deps: ServiceDeps
    /** 停机闸:stopping 后所有会开新工作的入口先过这一道(`workbench_stopping`)。只在 service.ts 定义一次。 */
    ensureAccepting: () => void
    log?: (tag:string,line:string)=>void
    now: () => number
    actions: Ref<ServiceActions>
  }
  ```

- [ ] **Step 1: 改 `ctx.ts`** —— 在 `ServiceHub` 之后加 `ServiceDeps`,`ServiceCtx` 加 `deps` 与 `ensureAccepting` 两个字段(注释照上面)。

- [ ] **Step 2: typecheck 先红**

Run: `bun run typecheck 2>&1 | grep -c "error TS"`
Expected: 2(`service.ts` 的 ctx 字面量、`review.test.ts` 的 ctx 字面量各缺字段)。这就是这一步的「红」:类型是契约,少了字段编译器替你红。

- [ ] **Step 3: `service.ts` 的 ctx 字面量**改成:

```ts
  const ctx:ServiceCtx={store,stateDir:opts.stateDir,state,hub:{touched,bumped},deps:{ownerChatId:opts.ownerChatId},ensureAccepting,...(opts.log?{log:opts.log}:{}),now:Date.now,actions}
```

`ensureAccepting` 是 `function` 声明(提升),在 ctx 之后定义也能引用;不要搬它。

- [ ] **Step 4: `review.test.ts` 的 `setup()`**里 ctx 改成:

```ts
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner' }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
```

- [ ] **Step 5: 验证**

Run: `bun run typecheck 2>&1 | grep -c "error TS"; bun --bun vitest run src/core/workbench/service 2>&1 | grep -E "Test Files|Tests "`
Expected: `0`;22 文件全过(19 + state + review + guard 不在这个 glob,所以是 21 文件 250 条)。

- [ ] **Step 6: Commit**

```bash
git add src/core/workbench/service/ctx.ts src/core/workbench/service.ts src/core/workbench/service/review.test.ts
git commit -m "workbench service 拆分 5/n:ServiceCtx 加 deps.ownerChatId 与 ensureAccepting(attachments 域的前置,行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: attachments 域

**Files:**
- Create: `src/core/workbench/service/attachments.ts`
- Create: `src/core/workbench/service/attachments.test.ts`
- Modify: `src/core/workbench/service.ts`(删 `:143-163` 与 `:178-192` 两段闭包;删 public 对象里 `uploadAttachment`…`discardAttachment` 六行;建域并解构)

**Interfaces:**
- Consumes:Task 1 的 `ctx.deps.ownerChatId`、`ctx.ensureAccepting`;`InputMaterials` from `./types`。
- Produces:
  ```ts
  export interface AttachmentsDomain {
    /** 分块上传句柄:懒建、只建一次(materialUploads 那个 let 随之进来)。 */
    uploads(): ReturnType<WorkbenchStore['attachmentUploads']>
    attachmentScope(): {ownerKey:string;allowLegacyUnbound:true} | undefined
    strictAttachmentScope(taskId?:string): {ownerKey:string}
    continuationAttachmentScope(taskId:string,ids:unknown): {ownerKey:string} | undefined
    selectAttachments(input?:InputMaterials,taskId?:string,policy?:'owner'): Attachment[]
    combinedAttachments(current:readonly Attachment[],previous?:readonly Attachment[]): Attachment[]
    handoffAttachments(refs:AttachmentSelection[],expectedTaskId:string): Attachment[]
    uploadAttachment(input:Parameters<WorkbenchStore['attachments']['upload']>[0]): Attachment
    uploadAttachmentChunk(input:Parameters<ReturnType<WorkbenchStore['attachmentUploads']>['chunk']>[0],context:EntryContext): ReturnType<ReturnType<WorkbenchStore['attachmentUploads']>['chunk']>
    attachmentUploadStatus(input:{id:string;draftId:string},context:EntryContext): ReturnType<ReturnType<WorkbenchStore['attachmentUploads']>['status']>
    discardAttachmentUpload(input:{id:string;draftId:string},context:EntryContext): ReturnType<ReturnType<WorkbenchStore['attachmentUploads']>['discard']>
    readAttachment(taskId:string,id:string): ReturnType<WorkbenchStore['attachments']['read']>
    discardAttachment(id:string,draftId:string): ReturnType<WorkbenchStore['attachments']['discard']> | ReturnType<ReturnType<WorkbenchStore['attachmentUploads']>['discard']>
  }
  export function makeAttachmentsDomain(ctx:ServiceCtx):AttachmentsDomain
  ```
  返回类型若与 `store` 的真实签名对不上,以 `store.ts` / `attachments.ts` / `attachment-uploads.ts` 的导出类型为准改接口,**不要**改实现体。

- [ ] **Step 1: 写 `service/attachments.test.ts`(红:模块不存在)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import type { Attachment } from '../attachments'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState } from './state'
import { makeAttachmentsDomain } from './attachments'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

/** 最小 ctx:真 store,主人可配可不配(owner=null 模拟「还没配主人」)。 */
function setup(owner: string | null = 'owner') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-attachments-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const log = vi.fn()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => owner }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, log, now: Date.now, actions: new Ref<ServiceActions>('t') }
  const domain = makeAttachmentsDomain(ctx)
  const task = (ownerChatId: string | null) => store.create({ title: '事', path: project, providerId: 'claude', ownerChatId })
  return { store, state, domain, task, log, project }
}

const att = (id: string, size = 1): Attachment => ({ id, size } as unknown as Attachment)

describe('makeAttachmentsDomain · 作用域', () => {
  it('attachmentScope:配了主人 ⇒ 带 allowLegacyUnbound;没配 ⇒ undefined', () => {
    expect(setup().domain.attachmentScope()).toEqual({ ownerKey: 'owner', allowLegacyUnbound: true })
    expect(setup(null).domain.attachmentScope()).toBeUndefined()
  })
  it('strictAttachmentScope:没配主人 ⇒ invalid_entry_owner;别人的任务 ⇒ attachment_scope;自己的 ⇒ {ownerKey}', () => {
    expect(() => setup(null).domain.strictAttachmentScope()).toThrow('invalid_entry_owner')
    const { domain, task } = setup()
    expect(() => domain.strictAttachmentScope(task('someone-else').id)).toThrow('attachment_scope')
    expect(domain.strictAttachmentScope(task('owner').id)).toEqual({ ownerKey: 'owner' })
  })
  it('continuationAttachmentScope:老任务(owner=NULL)+ 空材料 ⇒ undefined 放行;带材料 / 非数组 / 别人的任务 ⇒ attachment_scope', () => {
    const { domain, task } = setup()
    const legacy = task(null).id
    expect(domain.continuationAttachmentScope(legacy, [])).toBeUndefined()
    expect(() => domain.continuationAttachmentScope(legacy, ['a'])).toThrow('attachment_scope')
    expect(() => domain.continuationAttachmentScope(legacy, undefined)).toThrow('attachment_scope')
    expect(() => domain.continuationAttachmentScope(task('someone-else').id, [])).toThrow('attachment_scope')
    expect(domain.continuationAttachmentScope(task('owner').id, [])).toEqual({ ownerKey: 'owner' })
  })
  it('selectAttachments:不带材料、不带策略 ⇒ 空数组,不要求主人', () => {
    expect(setup(null).domain.selectAttachments()).toEqual([])
    expect(setup(null).domain.selectAttachments({}, undefined)).toEqual([])
  })
})

describe('makeAttachmentsDomain · 合并', () => {
  it('combinedAttachments:previous 在前、同 id 取 current 的字段但位置留在 previous 处;超 8 个或 24 MiB ⇒ invalid_attachment_context_limit', () => {
    const { domain } = setup()
    const merged = domain.combinedAttachments([att('b', 2), att('c')], [att('a'), att('b', 9)])
    expect(merged.map(a => [a.id, a.size])).toEqual([['a', 1], ['b', 2], ['c', 1]])
    expect(() => domain.combinedAttachments(Array.from({ length: 9 }, (_, i) => att(String(i))))).toThrow('invalid_attachment_context_limit')
    expect(() => domain.combinedAttachments([att('x', 24 * 1024 * 1024 + 1)])).toThrow('invalid_attachment_context_limit')
    expect(domain.combinedAttachments([att('x', 24 * 1024 * 1024)])).toHaveLength(1)
  })
})

describe('makeAttachmentsDomain · 入口闸', () => {
  it('stopping 之后 uploadAttachment / uploadAttachmentChunk 抛 workbench_stopping,status/discard 不受影响', () => {
    const { domain, state } = setup()
    state.stopping = true
    expect(() => domain.uploadAttachment({} as never)).toThrow('workbench_stopping')
    expect(() => domain.uploadAttachmentChunk({} as never, { ownerKey: 'owner', surface: 'phone' })).toThrow('workbench_stopping')
  })
  it('uploadAttachment:归档任务 ⇒ workbench_archived(在碰 store.attachments.upload 之前)', () => {
    const { domain, task, store } = setup()
    const id = task('owner').id
    store.setArchived(id, true)
    const upload = vi.spyOn(store.attachments, 'upload')
    expect(() => domain.uploadAttachment({ taskId: id } as never)).toThrow('workbench_archived')
    expect(upload).not.toHaveBeenCalled()
  })
  it('readAttachment:任务不存在 ⇒ not_found', () => {
    expect(() => setup().domain.readAttachment('deadbeef', 'x')).toThrow('not_found')
  })
  it('uploads():懒建且只建一次;onTransaction 走 ctx.log', () => {
    const { domain, store, log } = setup()
    const spy = vi.spyOn(store, 'attachmentUploads')
    expect(spy).not.toHaveBeenCalled()
    const a = domain.uploads(), b = domain.uploads()
    expect(a).toBe(b); expect(spy).toHaveBeenCalledTimes(1)
    const opts = spy.mock.calls[0]![0]
    opts.onTransaction!({ operation: 'reserve', durationMs: 1.5 } as never)
    expect(log).toHaveBeenCalledWith('attachment-upload', 'reserve lock_ms=1.5')
  })
  it('discardAttachment:没配主人时,已落库的材料走 attachmentScope(不抛 invalid_entry_owner);上传中的走 strict(抛)', () => {
    const { domain, store } = setup(null)
    vi.spyOn(store, 'uploadRequestExists').mockReturnValueOnce(false)
    const discard = vi.spyOn(store.attachments, 'discard').mockReturnValueOnce(undefined as never)
    domain.discardAttachment('att-1', 'draft-1')
    expect(discard).toHaveBeenCalledWith('att-1', 'draft-1', undefined)
    vi.spyOn(store, 'uploadRequestExists').mockReturnValueOnce(true)
    expect(() => domain.discardAttachment('att-2', 'draft-1')).toThrow('invalid_entry_owner')
  })
})
```

`store.setArchived` / `store.uploadRequestExists` / `store.attachments.discard` 的名字按 `store.ts` 现有导出为准;若 `setArchived` 不是 store 方法,用 `store.update`/对应 API 把 `archivedAt` 置非 null。**不要为了测试改 store。**

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/core/workbench/service/attachments.test.ts`
Expected: FAIL,`Cannot find module './attachments'`。

- [ ] **Step 3: 新建 `service/attachments.ts`** —— 用脚本从 `service.ts` 抠出两段(`let materialUploads` 起到 `selectAttachments` 的闭合 `}`;`function combinedAttachments` 起到 `handoffAttachments` 的闭合 `}`)和 public 对象里 `uploadAttachment`…`discardAttachment` 六行,逐字放进域;只做这些机械替换:`opts.stateDir`→`ctx.stateDir`、`opts.ownerChatId`→`ctx.deps.ownerChatId`、`opts.log?.(`→`ctx.log?.(`、`ensureAccepting()`→`ctx.ensureAccepting()`。文件头:

```ts
/**
 * attachments 域:材料的作用域判定 / 选择 / 合并 / handoff 校验 / 分块上传句柄,以及 6 个 public 入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 2 项);只认 ctx。
 * 主人身份只从 ctx.deps.ownerChatId 取;停机闸走 ctx.ensureAccepting(service.ts 定义一次)。
 */
import type { Attachment } from '../attachments'
import type { AttachmentSelection } from '../handoff'
import type { EntryContext } from '../task-entry'
import type { WorkbenchStore } from '../store'
import type { ServiceCtx } from './ctx'
import type { InputMaterials } from './types'

export interface AttachmentsDomain { /* 见 Interfaces */ }

export function makeAttachmentsDomain(ctx:ServiceCtx):AttachmentsDomain {
  const { store } = ctx
  // ……闭包两段逐字……
  return {
    uploads,attachmentScope,strictAttachmentScope,continuationAttachmentScope,selectAttachments,combinedAttachments,handoffAttachments,
    // ……六个 public 方法逐字(方法简写语法照旧)……
  }
}
```

- [ ] **Step 4: `service.ts` 接上**

1. 头部加 `import { makeAttachmentsDomain } from './service/attachments'`。
2. 在 `const review=makeReviewDomain(ctx)` 之后加:
   ```ts
   const materials=makeAttachmentsDomain(ctx)
   const {uploads,attachmentScope,strictAttachmentScope,continuationAttachmentScope,selectAttachments,combinedAttachments,handoffAttachments}=materials
   ```
   (域变量叫 `materials`,因为 `attachments` 在这个文件里是几十处局部变量名。)
3. 删掉两段闭包和六个 public 方法;public 对象里换成:
   ```ts
    uploadAttachment:materials.uploadAttachment,
    uploadAttachmentChunk:materials.uploadAttachmentChunk,
    attachmentUploadStatus:materials.attachmentUploadStatus,
    discardAttachmentUpload:materials.discardAttachmentUpload,
    readAttachment:materials.readAttachment,
    discardAttachment:materials.discardAttachment,
   ```
4. 注意 `ctx` 字面量在闭包之后、`uploads` 用了 `ctx`——域工厂只在调用时读 `ctx.*`,所以 `makeAttachmentsDomain(ctx)` 放在 ctx 之后即可;解构出来的函数在 `execute`/`start`/`submitInput` 等后面的函数里才被调用,不存在 TDZ。
5. 删不再使用的 import:`type AttachmentSelection`(`:22`,若 `service.ts` 别处不再引用)、`type Attachment`(`:8`,同上);`EntryContext`、`ManagedWorkspaces`、`createManagedWorkspaces` 还在用(entry 域没搬),留着。以 `grep -c` 为准。

- [ ] **Step 5: 验证**

Run: `bun --bun vitest run src/core/workbench/service/attachments.test.ts`
Expected: 10 通过。

Run: `bun run typecheck 2>&1 | grep -c "error TS"; bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: `0`;23 文件全过(19 + state + review + attachments + 守卫)。

Run: `bun run depcheck 2>&1 | tail -1`
Expected: `0 errors, 21 warnings`。

- [ ] **Step 6: Commit**

```bash
git add src/core/workbench/service/attachments.ts src/core/workbench/service/attachments.test.ts src/core/workbench/service.ts
git commit -m "workbench service 拆分 6/n:attachments 域搬进 service/attachments.ts(作用域/选择/合并/handoff 校验/分块上传 + 6 个入口,行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 棘轮下调 + spec §3 措辞 + 全量闸门

**Files:**
- Modify: `scripts/workbench-service-ratchet.guard.test.ts`(两个常量)
- Modify: `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 1 项那句「depcruise `no-circular` 对 `src/core/workbench/` 升 error」)

- [ ] **Step 1: 量实际值**

Run: `wc -l src/core/workbench/service.ts; bun -e "const s=require('fs').readFileSync('src/core/workbench/service.ts','utf8');process.stdout.write(String((s.match(/^  (?:async )?function \w+\(|^  const \w+ ?= ?(?:async ?)?\(/gm)??[]).length))"`
Expected: 行数约 1740(1797 − 51 + 12 左右);内函数 61(68 − 7)。**`bun -e` 的输出别直接拼进文件**(PR 1 踩过 ANSI 色码),抄数字。

- [ ] **Step 2: 改常量**为量到的值,不留余量。

- [ ] **Step 3: spec §3 第 1 项**把「顺手断环,depcruise `no-circular` 对 `src/core/workbench/` 升 error」改成「顺手断环;depcruise 只对 service 族(`service.ts`、`service/`、`wechat-control.ts`)升 error(PR 1 已做),整个 `src/core/workbench/` 升 error 等 §4 提到的 store 层 4 个环另修之后」。

- [ ] **Step 4: 全量闸门**

Run:
```bash
bun run test 2>&1 | grep -E "Test Files|Tests "
npm run test:node 2>&1 | grep -E "Test Files|Tests "
bun run typecheck 2>&1 | grep -c "error TS"
bun run depcheck 2>&1 | tail -1
```
Expected:bun 697 文件 / 9249 条(PR 1 之后 696/9239 + attachments 1 文件 10 条);node 全绿;`0`;`0 errors, 21 warnings`。

- [ ] **Step 5: Commit**

```bash
git add scripts/workbench-service-ratchet.guard.test.ts docs/superpowers/specs/2026-09-27-workbench-service-split-design.md docs/superpowers/plans/2026-09-28-workbench-service-split-pr2.md
git commit -m "workbench service 拆分 7/n:棘轮下调到搬完 attachments 域的实际值;spec §3 no-circular 措辞与 PR 1 对齐;附 PR 2 计划

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 推分支、PR、CI、合入后真机

- [ ] **Step 1**:`git push -u origin sweep/workbench-service-split-2`
- [ ] **Step 2**:`gh pr create --base dev` 标题「workbench service 拆分 PR 2:attachments 域(行为不变)」,正文照 PR 1 的格式(改了啥 / 怎么验的 / 🤖 尾注)。
- [ ] **Step 3**:`wechat-cc ci triage --sha $(git rev-parse HEAD) --wait --rerun`,期望 exit 0。
- [ ] **Step 4**(合 dev 后):`cd apps/desktop && bun run build-sidecar && cd -`;`wechat-cc self deploy --binary apps/desktop/src-tauri/binaries/wechat-cc-cli-aarch64-apple-darwin`;`wechat-cc selftest workbench --executor cursor --image --resume`,期望 `PASS`(`--image` 那一步走的正是 `selectAttachments`/`combinedAttachments`)。

---

## Self-Review

- **Spec 覆盖**:§3 第 2 项 attachments 域 ✓;§2 `service/attachments.ts` ✓;§5 每域一份单测 ✓、棘轮下调 ✓、真机 ✓;§4 不改行为 ✓。spec §3 第 1 项措辞对齐是 PR 1 裁决的欠账,Task 3 还上。
- **占位符**:Task 2 Step 3 的「逐字」指向 service.ts 现有行段,实施用脚本抠、diff 核对(同 PR 1)。
- **类型一致**:`AttachmentsDomain` 七个帮手的名字与 service.ts 调用点逐字一致(解构才能不改调用点);`ctx.deps.ownerChatId` 在 Task 1 产、Task 2 消费;`ensureAccepting` 同。
- **Review Focus** 五条归属:1→Task 2「discardAttachment 两分支」;2→「uploads() 只建一次」;3→「continuationAttachmentScope 三边界」;4→「stopping 之后抛 workbench_stopping」;5→「combinedAttachments 顺序」。
