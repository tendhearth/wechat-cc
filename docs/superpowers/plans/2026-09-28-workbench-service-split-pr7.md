# workbench service 拆分 · PR 7(native + handoff 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 native + handoff 域(原生会话导入 / 续接决策 / 交接:`nativeReader` / `currentNativePages` / `validateNativeDecision` 三个闭包 + `previewHandoff` / `handoff` / `handoffRecord` / `conflictsExternal` / `importNativeHistory` / `prepareNativeResume` / `continueNativeTask` / `listNativeHistory` / `readNativeHistory` 九个入口)逐字搬进 `service/native.ts`;前置是把 `service.ts` 模块级的 `checkedText` 挪成 `service/checked-text.ts`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。顺手清掉 PR 6 评审点名的死 import。

**Architecture:** 同 PR 1–6。这是跨域最重的一块:它要 admission 的 `requireInput` / `canResume` / `taskVersion`(`provider` / `continuation` 已在 actions),attachments 的 `selectAttachments` / `combinedAttachments` / `handoffAttachments`,view 的 `taskView`,execute 的 `start`,以及 `matterSync`。全部走 `ServiceActions`(Ref 晚绑定,与前几个 PR 同一种机制;`start` 是真正需要晚绑定的,其余是查询但为了只留一种机制照旧)。**ServiceActions 到此 18 个字段**——记一笔:execute PR 之后考虑按域分组(`actions.admission.requireInput`),本 PR 不动形状。`ctx.deps` 加 `executionConflict`。`nativeDecisions` / `handoffDecisions` 两个 Map 已在 `state`,域内经 `state.*`。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 6 项,排在第 7 项之后做,见 PR 6 计划的顺序裁决)。基线 dev `6ff5d058`(#138 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-7`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案、超时(5 分钟决策有效期、100 条上限)。逐字搬,注释一起搬。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。七份域单测允许为 ctx/actions 新字段补 stub。
- `service/*.ts` 禁止 import `../service`(depcruise error 兜底)。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`handoff` 的 `assertCurrent` 二次校验**:校验 → `provider` → 校验附件 → 续接决策 → (目标为导入任务时)`validateNativeDecision` 后**再** `assertCurrent()` 且 `nativeDecisions.get(native.token)!==native ⇒ stale` —— 搬家后顺序必须原样;Task 2 域单测「token 畸形 ⇒ invalid_request、token 未知 ⇒ handoff_changed」钉住入口,完整链由 `service-execution.test.ts` 兜底。
2. **`prepareNativeResume` / `continueNativeTask` 的决策 Map 是 `state.nativeDecisions`**(同一实例;`handoff` 也读它)—— Task 2 域单测「prepareNativeResume 没有 source ⇒ invalid_request;continueNativeTask 未知 token ⇒ external_close_confirmation_stale」+ 「state.nativeDecisions 被域读到」钉住。
3. **`conflictsExternal` 三段**:路径不可 canonical ⇒ true;nativeId 已被管理 ⇒ true;否则看 `runsByTask` 路径冲突 —— Task 2 域单测三条。
4. **`checkedText` 语义**:非字符串 / 空且无附件 / 超 20000 ⇒ `invalid_text`;有附件时允许空文本;返回 trim —— Task 1 单测钉住;`createTask` / `continueTask` / `submitInput` / `continueNativeTask` 四个调用点只换 import。
5. **`start` 经 `ctx.actions.deref('native').start` 在调用时取**:`handoff` / `continueNativeTask` 只在 service 建好后才会被调用;工厂体里不 deref —— Task 2 域单测「构造时 actions 未 set 也不抛」钉住。

---

### Task 1: `service/checked-text.ts` + `ctx.deps.executionConflict` + `ServiceActions` 扩展 + 清死 import

**Files:**
- Create: `src/core/workbench/service/checked-text.ts`、`src/core/workbench/service/checked-text.test.ts`
- Modify: `src/core/workbench/service/ctx.ts`、`src/core/workbench/service.ts`、七份域单测的 `actions.set` stub(review / notices / admission / view;attachments / quota / artifacts 没 set 过 actions,不用动)

**Interfaces:**
```ts
// checked-text.ts
export function checkedText(text: string, attachments?: readonly Attachment[]): string
// ctx.ts
export interface ServiceDeps { …; /** 外部(终端里的 claude/codex)是否正占着这个文件夹/会话;不传 ⇒ 不查。 */ executionConflict?: (path:string,providerId:string,nativeId:string|null) => boolean }
export interface ServiceActions {
  …
  requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume?:boolean): AdmittedProvider
  canResume(task:StoredTask): boolean
  taskVersion(task:StoredTask): string
  selectAttachments(input?:InputMaterials,taskId?:string,policy?:'owner'): Attachment[]
  combinedAttachments(current:readonly Attachment[],previous?:readonly Attachment[]): Attachment[]
  handoffAttachments(refs:AttachmentSelection[],expectedTaskId:string): Attachment[]
  taskView(task:Task,includePermissions?:boolean): WorkbenchTaskView
  matterSync(fn:(m:MatterStore)=>void): void
  start(task:StoredTask,text:string,acceptedDirectoryIdentity:string,acceptedContinuation?:AcceptedContinuation,nativeResume?:AcceptedNativeResume,handoffArtifacts?:ArtifactSelection[],handoffId?:string,queuedInputId?:string,attachments?:Attachment[],draftId?:string,executionChoice?:AgentExecutionChoice,acceptance?:{persist:(runId:string)=>void;activate:(fn:()=>void)=>void;scope?:{ownerKey:string}},attachmentPolicy?:'owner'): WorkbenchTaskView
}
```

- [ ] **Step 1: 写 `checked-text.test.ts`(红)**

```ts
import { describe, it, expect } from 'vitest'
import { checkedText } from './checked-text'
import type { Attachment } from '../attachments'

const att = { id: 'a', size: 1 } as unknown as Attachment

describe('checkedText', () => {
  it('trim 后返回;非字符串 / 空且无附件 / 超 20000 ⇒ invalid_text', () => {
    expect(checkedText('  做点事 ')).toBe('做点事')
    expect(() => checkedText(1 as never)).toThrow('invalid_text')
    expect(() => checkedText('   ')).toThrow('invalid_text')
    expect(() => checkedText('x'.repeat(20_001))).toThrow('invalid_text')
  })
  it('有附件时允许空文本(只发材料)', () => {
    expect(checkedText('', [att])).toBe('')
  })
})
```

- [ ] **Step 2: 跑,红**(`Cannot find module './checked-text'`)。
- [ ] **Step 3**:`service.ts:88-91` 的 `function checkedText(...)` 逐字剪到新文件加 `export`(import `type Attachment` from `'../attachments'`);service.ts 加 `import { checkedText } from './service/checked-text'`。
- [ ] **Step 4**:`ctx.ts` 加 `deps.executionConflict` 与九个 actions(import `MatterStore` from `'../../matters/store'`、`AcceptedContinuation` from `'./state'`、`AcceptedNativeResume` from `'../native-adoption'`、`ArtifactSelection, AttachmentSelection` from `'../handoff'`、`Attachment` from `'../attachments'`、`Task` from `'../store'`)。typecheck 先红(service.ts 的 `actions.set` + 四份 stub)。
- [ ] **Step 5**:service.ts 的 ctx 字面量加 `...(opts.executionConflict?{executionConflict:opts.executionConflict}:{})`;`actions.set` 加 `requireInput,canResume,taskVersion,selectAttachments,combinedAttachments,handoffAttachments,taskView,matterSync,start`(都是已解构/已定义的名字;`start`、`matterSync` 是 function 声明,提升可引用)。四份 stub 各补九个 `() => { throw new Error('unused') }`(`selectAttachments`/`combinedAttachments`/`handoffAttachments` 可用 `() => []`)。
- [ ] **Step 6: 清死 import** —— 跑 `bun x tsc --noEmit --noUnusedLocals 2>&1 | grep "service.ts"`(不改 tsconfig),把它报的 service.ts 里未用 import 全删(PR 6 评审点名的 4 个 + base 就有的 8 个;别删 `noUnusedLocals` 报的**函数/变量**,只删 import)。
- [ ] **Step 7: 验证** —— checked-text 2 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service` 30 文件全过;depcheck `0 errors, 21 warnings`。
- [ ] **Step 8: Commit** —— `workbench service 拆分 21/n:checkedText 挪成 service/checked-text.ts;ctx.deps 加 executionConflict、actions 加九个跨域动作;清 service.ts 死 import(native 域的前置,行为不变)`

---

### Task 2: native + handoff 域

**Files:**
- Create: `src/core/workbench/service/native.ts`、`src/core/workbench/service/native.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export function makeNativeDomain(ctx:ServiceCtx) {
  …
  return { nativeReader,currentNativePages,validateNativeDecision, previewHandoff,handoff,handoffRecord,conflictsExternal,importNativeHistory,prepareNativeResume,continueNativeTask,listNativeHistory,readNativeHistory }
}
export type NativeDomain = ReturnType<typeof makeNativeDomain>
```
`service.ts` 解构 `{validateNativeDecision}`(execute 里 `if(running.nativeResume)await validateNativeDecision(...)` 用;`nativeReader` / `currentNativePages` 只在域内)。

- [ ] **Step 1: 写 `service/native.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeNativeDomain } from './native'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const unused = () => { throw new Error('unused') }

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-native-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeNativeDomain(ctx)
  const stub = () => actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => null, artifact: unused, quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: id => { const p = registry.get(id); if (!p) throw new Error('unavailable_provider'); return p as never }, requireInput: id => registry.get(id) as never, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: c => [...c], handoffAttachments: () => [], taskView: t => t as never, matterSync: () => {}, start: unused })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  return { store, state, domain, task, project, actions, stub }
}

describe('makeNativeDomain · 构造与守门', () => {
  it('构造时不 deref actions', () => { const { actions } = setup(); expect(actions.current).toBeNull() })
  it('stopping 之后五个会开新工作的入口都抛 workbench_stopping', async () => {
    const { domain, state, task, stub } = setup(); stub(); state.stopping = true
    await expect(domain.previewHandoff({} as never)).rejects.toThrow('workbench_stopping')
    await expect(domain.handoff({ token: 'a'.repeat(64) })).rejects.toThrow('workbench_stopping')
    await expect(domain.importNativeHistory({} as never)).rejects.toThrow('workbench_stopping')
    await expect(domain.prepareNativeResume(task.id)).rejects.toThrow('workbench_stopping')
    await expect(domain.continueNativeTask(task.id, 'x', 'a'.repeat(64))).rejects.toThrow('workbench_stopping')
  })
})

describe('makeNativeDomain · 原生历史', () => {
  it('没接读取器 ⇒ listNativeHistory / readNativeHistory / nativeReader 都是 native_history_unsupported', async () => {
    const { domain } = setup()
    await expect(domain.listNativeHistory('claude', {} as never)).rejects.toThrow('native_history_unsupported')
    expect(() => domain.nativeReader('claude')).toThrow('native_history_unsupported')
  })
  it('importNativeHistory:畸形输入 ⇒ invalid_request', async () => {
    const { domain, stub } = setup(); stub()
    await expect(domain.importNativeHistory({ key: 'bad', pages: [], messageIds: [] } as never)).rejects.toThrow('invalid_request')
  })
  it('prepareNativeResume:不是导入来的任务 ⇒ invalid_request;continueNativeTask:未知 token ⇒ external_close_confirmation_stale', async () => {
    const { domain, task, stub } = setup(); stub()
    await expect(domain.prepareNativeResume(task.id)).rejects.toThrow('invalid_request')
    await expect(domain.continueNativeTask(task.id, '继续', 'f'.repeat(64))).rejects.toThrow('external_close_confirmation_stale')
  })
})

describe('makeNativeDomain · 交接', () => {
  it('handoff:token 畸形 ⇒ invalid_request;未知 token ⇒ handoff_changed', async () => {
    const { domain, stub } = setup(); stub()
    await expect(domain.handoff({ token: 'short' })).rejects.toThrow('invalid_request')
    await expect(domain.handoff({ token: 'a'.repeat(64) })).rejects.toThrow('handoff_changed')
  })
  it('previewHandoff:同一执行者交给自己 ⇒ invalid_request;畸形输入 ⇒ invalid_request', async () => {
    const { domain, task, stub } = setup(); stub()
    await expect(domain.previewHandoff({ sourceTaskId: task.id, targetProviderId: 'claude', purpose: 'review', request: '看看', artifacts: [] })).rejects.toThrow('invalid_request')
    await expect(domain.previewHandoff({ sourceTaskId: 'zz', targetProviderId: 'codex', purpose: 'review', request: '看看', artifacts: [] })).rejects.toThrow('invalid_request')
  })
  it('handoffRecord:不存在 ⇒ 抛;conflictsExternal:路径不可 canonical ⇒ true、同路径有 run 在跑 ⇒ true、否则 false', () => {
    const { domain, task, state, project } = setup()
    expect(() => domain.handoffRecord(task.id, 'nope')).toThrow()
    expect(domain.conflictsExternal('\0bad', 'claude', null)).toBe(true)
    expect(domain.conflictsExternal(project, 'claude', null)).toBe(false)
    state.runsByTask.set(task.id, { identity: 'r', taskId: task.id, path: project } as unknown as Active)
    expect(domain.conflictsExternal(project, 'claude', null)).toBe(true)
  })
})
```

`canonicalProject('\0bad')` 是否抛以 `artifacts.ts` 为准(不抛就换个必抛的:不存在的路径 / 文件)。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './native'`)。
- [ ] **Step 3: 新建 `service/native.ts`** —— 脚本抠:A = `function nativeReader(` 起到 `validateNativeDecision` 闭合 `}`(三个连续定义);B = public 九段各按首行锚点到各自 `    },`(`previewHandoff` 与 `handoff` 是 `async`,`listNativeHistory` / `readNativeHistory` 也是)。替换只有:`opts.nativeHistory`→`ctx.deps.nativeHistory`、`opts.executionConflict`→`ctx.deps.executionConflict`、`opts.stateDir`→`ctx.stateDir`、`opts.ownerChatId`→`ctx.deps.ownerChatId`、`ensureAccepting()`→`ctx.ensureAccepting()`、`touched(`→`ctx.hub.touched(`、`runsByTask`/`nativeDecisions`/`handoffDecisions`→`state.*`(域内 `const { store, state } = ctx`;**别用 `\bqueue\b` 那种宽正则**,这三个名字逐个替换)、`service.prepareNativeResume(`→`prepareNativeResume(`(域内直调)、以下经 `const a=()=>ctx.actions.deref('native')`:`provider(`→`a().provider(`、`requireInput(`→`a().requireInput(`、`canResume(`→`a().canResume(`、`continuation(`→`a().continuation(`、`taskVersion(`→`a().taskVersion(`、`selectAttachments(`→`a().selectAttachments(`、`combinedAttachments(`→`a().combinedAttachments(`、`handoffAttachments(`→`a().handoffAttachments(`、`taskView(`→`a().taskView(`、`matterSync(`→`a().matterSync(`、`start(`→`a().start(`。**替换前先确认这些名字在抠出的文本里没有作为别的东西出现**(如 `p.artifacts.map(...)` 不含 `start(`;`restartPreview(` 含 `start(` 子串 —— 用 `(?<![\w.])start\(` 这种带边界的正则,逐个 `grep -c` 核对替换次数)。public 九段改 `function` 声明。import 照 Task 1 Step 6 清完后 service.ts 里剩余的 native/handoff 专用名字搬过去:`readNativeImport, nativeImportInput, publicSource, pageInput, nativeResumeToken, snapshotHash, type ImportPage, type NativeImportInput, type NativeResumeDecision, type AcceptedNativeResume` from `../native-adoption`;`decodeNativeHistoryKey, normalizeHistoryList, normalizeHistoryRead, historyDeadline, type NativeHistoryProvider, type NativeHistoryListInput, type NativeHistoryReadInput` from `../native-history`;`handoffToken, handoffTokenHash, validateHandoffInput, handoffArtifactText, handoffContext, type HandoffInput, type HandoffPreview, type AttachmentSelection` from `../handoff`;`pathsConflict` from `../scheduler`;`restartPreview, type Continuation` from `../continuation`;`normalizeExecutionChoice, sameExecutionChoice, PROVIDER_EXECUTION_CHOICE` from `../execution-settings`;`canonicalProject` from `../artifacts`;`randomUUID` from `node:crypto`;`publicTask, TERMINAL_TASK_STATUSES, type StoredTask` from `../store`;`directoryIdentity` from `./directory-identity`;`checkedText` from `./checked-text`;`type AcceptedContinuation` from `./state`;`type InputMaterials, type WorkbenchTaskView` from `./types`。
- [ ] **Step 4: service.ts 接上** —— `const nativeDomain=makeNativeDomain(ctx)` + `const {validateNativeDecision}=nativeDomain` 放在 view 解构之后;删 A/B;public 九个换成 `xxx:nativeDomain.xxx,`。再跑一次 `tsc --noEmit --noUnusedLocals | grep service.ts` 清掉这次腾出来的 import。
- [ ] **Step 5: 验证** —— native 单测 8 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 32 文件全过(`service-execution` / `service-capabilities` / `service-attachments` 走完整交接与导入链);depcheck `0 errors, 21 warnings`;逐字 diff 核对(替换清单长,核对时把每条替换反向还原)。
- [ ] **Step 6: Commit** —— `workbench service 拆分 22/n:native + handoff 域搬进 service/native.ts(导入/续接决策/交接九个入口,行为不变)`

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈1170 行 / 30),改常量与注释「当前值 = PR 7 搬完 native+handoff 域之后的实际值」。数字手抄。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 705 文件 / 9303 条(PR 6 后 703/9293 + 2 文件 10 条);node 全绿;0;`0 errors, 21 warnings`。**别用 `grep -c` 当链中间的一环**(没匹配时退出码 1 会断链,PR 6 踩过)。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 23/n:棘轮下调到搬完 native+handoff 域的实际值;附 PR 7 计划`

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 6 Task 5;`selftest workbench --resume` 的 `resume_replied via continue` 走 continueTask,不走本域,所以另加一次 `selftest chat --provider cursor --resume`(不走本域也没关系——本域真机路径是桌面「导入 / 交接」,由 19 份旧测试与 CI 兜底;真机导入一条 Claude 历史留给主人抽查)。

---

## Self-Review

- **Spec 覆盖**:§3 第 6 项 native + handoff ✓;§2 `service/native.ts` ✓;`checked-text.ts` 同 `directory-identity.ts` 的理由;§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 3 的替换清单逐条列出、带边界要求。
- **类型一致**:Task 1 产 `actions.*` 九个与 `deps.executionConflict`,Task 2 消费;`validateNativeDecision` 解构名与 execute 调用点同名;`ServiceActions.start` 签名逐字抄自 service.ts。
- **Review Focus** 归属:1→Task 2「handoff 守门」;2→「prepareNativeResume / continueNativeTask」;3→「conflictsExternal 三段」;4→Task 1 checked-text 单测;5→「构造时不 deref」。
