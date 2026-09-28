# workbench service 拆分 · PR 6(admission + view 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 admission 域(执行者准入:`provider` / `requireInput` / `requireEntryInput` / `canResume` / `continuation` / `taskVersion` + `modelCatalog` / `prepareContinuation` / `acknowledgeUnattended`)和 view 域(主人眼里的进度:`held` / `waitingFor` / `runtimeSnapshot` / `inputMode` / `isReplied` / `phaseOf` / `taskView` + `attention` / `projects` / `addProject` / `list` / `detail`)逐字搬进 `service/admission.ts` 与 `service/view.ts`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1–5。**顺序裁决**:spec §3 第 6 项是 native + handoff,第 7 项才是 admission + view;但 native/handoff 的每个方法都调 admission 的五个帮手,先搬 native 就得把它们塞进 `ServiceActions` 再在下个 PR 拆出来 —— 白绕一圈。所以本 PR 做第 7 项,PR 7 做第 6 项。`ctx.deps` 加 `unattendedAck` / `nativeHistory` / `registeredProjects` / `defaultProvider`(都是 `Options` 的只读子集);`ServiceActions` 加 `quotaExhausted`(admission 的 `requireEntryInput` 与 view 的 `list` 用)与 `continuation`(view 的 `detail` 用 admission 的)。`ensureAccepting` 仍在 service.ts 定义、经 ctx 给域用。view 域内 `waitingFor` 里的 `quiet(holder)` 改成 `isReplied(holder)`(`quiet` 只是 `isReplied` 的别名,service.ts 保留 `const quiet=isReplied` 给 lifecycle 用)。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 7 项,提前到第 6 项之前)。基线 dev `e59f2e46`(#137 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-6`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案。逐字搬,注释一起搬(`acknowledgeUnattended` 上那段「免审执行者只能停在要求确认」尤其)。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。五份域单测允许为 ctx 新字段补字段。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`requireInput` 的免审门**:`isUnattendedExecutor && (unattendedAck.get() ?? null) === null ⇒ unattended_ack_required`;`unattendedAck` 没接(老接线)时永远要求确认 —— Task 2 域单测「没接 ack ⇒ 抛;接了但 get() 为 null ⇒ 抛;set 之后 ⇒ 过」钉住。
2. **`continuation` 三态**:没有 user/text 事件 ⇒ `new`;有且 `canResume` ⇒ `resume`;有且不能 ⇒ `restart_required` 带 `restart` 预览 —— Task 2 域单测三条钉住。
3. **`taskView.canArchive` 与 `importedOnly`**:终态 + 没在跑 + `error!=='writer_not_closed'` 才可归档;导入未派发过的终态任务标 `importedOnly` —— Task 3 域单测钉住。
4. **`waitingFor` 的 `holderWriting`**:持有者找不到 ⇒ `true`(宁可说「还在写」);持有者已答复 ⇒ `false` 且 `closeInMs` 来自 `idleClose.at` —— Task 3 域单测「同路径被占、持有者 idle 已答复 ⇒ holderWriting=false, closeInMs≥0」钉住(`quiet`→`isReplied` 那处替换正是这里)。
5. **`list` 的 `defaultProvider` 回落**:配置的 default 不在准入名单 ⇒ 取第一个;没有执行者 ⇒ null —— Task 3 域单测钉住;`unattendedAcknowledgedAt` / `canWechat` / `historyProviders` 同一条里断言。

---

### Task 1: `ctx.deps` 加四个字段;`ServiceActions` 加 `quotaExhausted` / `continuation`

**Files:**
- Modify: `src/core/workbench/service/ctx.ts`
- Modify: `src/core/workbench/service.ts`(ctx 字面量、`actions.set`)
- Modify: `service/review.test.ts` 与 `service/notices.test.ts`(`actions.set` 补两字段;其它三份域单测的 deps 都是可选字段,不用动)

**Interfaces:**
```ts
export interface ServiceDeps {
  …
  /** 免审执行者的一次性确认(daemon 侧持久化);不传 ⇒ 免审执行者永远要求确认。 */
  unattendedAck?: { get(): number | null; set(at: number): void }
  /** 原生历史读取器(claude / codex),list 只报名字,native 域真读。 */
  nativeHistory?: Partial<Record<NativeHistoryProvider, NativeHistoryReader>>
  registeredProjects?: () => Array<{alias:string;path:string}>
  defaultProvider?: string
}
export interface ServiceActions {
  …
  quotaExhausted(providerId:string): QuotaState|null
  continuation(task:StoredTask,execution?:AgentExecutionChoice): Continuation
}
```

- [ ] **Step 1**:改 `ctx.ts`(import `NativeHistoryProvider, NativeHistoryReader` from `../native-history`、`QuotaState` from `../../provider-quota`、`StoredTask` from `../store`、`AgentExecutionChoice` from `../../agent-provider`、`Continuation` from `../continuation`)。
- [ ] **Step 2: typecheck 先红** —— Expected `Found 3 errors`(service.ts 的 `actions.set`、review.test / notices.test 的 `actions.set` 各缺两字段)。
- [ ] **Step 3: service.ts** —— ctx 字面量 `deps` 加 `...(opts.unattendedAck?{unattendedAck:opts.unattendedAck}:{}),...(opts.nativeHistory?{nativeHistory:opts.nativeHistory}:{}),...(opts.registeredProjects?{registeredProjects:opts.registeredProjects}:{}),...(opts.defaultProvider!==undefined?{defaultProvider:opts.defaultProvider}:{})`;`actions.set({…,quotaExhausted:quotaDomain.quotaExhausted,continuation})`(`continuation` 此时还是 service.ts 的闭包,Task 2 搬走后解构名不变)。
- [ ] **Step 4**:两份域单测的 `actions.set` 补 `quotaExhausted: () => null, continuation: () => ({ mode: 'new' })`(notices.test 那处是 `as never`,顺手也补上,免得以后改签名不报)。
- [ ] **Step 5: 验证** —— typecheck 0;`bun --bun vitest run src/core/workbench/service` 27 文件全过。
- [ ] **Step 6: Commit** —— `workbench service 拆分 17/n:ctx.deps 加 unattendedAck/nativeHistory/registeredProjects/defaultProvider;actions 加 quotaExhausted/continuation(admission+view 的前置,行为不变)`

---

### Task 2: admission 域

**Files:**
- Create: `src/core/workbench/service/admission.ts`、`src/core/workbench/service/admission.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export interface AdmissionDomain {
  provider(id:string): NonNullable<ReturnType<ProviderRegistry['get']>> & {opts:{workbench:WorkbenchExecutorCapabilities}}
  requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume?:boolean): ReturnType<AdmissionDomain['provider']>
  requireEntryInput(providerId:string,attachments:readonly Attachment[],execution:AgentExecutionChoice,text:string): void
  canResume(task:StoredTask): boolean
  continuation(task:StoredTask,execution?:AgentExecutionChoice): Continuation
  taskVersion(task:StoredTask): string
  modelCatalog(providerId:string,path:string): Promise<AgentModelCatalog>
  prepareContinuation(id:string,executionChoice?:unknown): Continuation
  acknowledgeUnattended(): number
}
export function makeAdmissionDomain(ctx:ServiceCtx): AdmissionDomain
```
`service.ts` 解构全部六个帮手(execute / start / createTask / entry / native / handoff / lifecycle 的调用点不改)。`provider` 的返回类型照 service.ts 原来的 `entry as typeof entry&{opts:…}` 推导写,写不出来就 `ReturnType<typeof provider>` 在域内自引用。

- [ ] **Step 1: 写 `service/admission.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { MANAGED_NATIVE_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../executor-capabilities'
import { PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState } from './state'
import { makeAdmissionDomain } from './admission'
import type { ServiceActions, ServiceCtx, ServiceDeps } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }

function setup(over: { ack?: ServiceDeps['unattendedAck']; canResume?: boolean; quotaExhausted?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-admission-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => over.canResume ?? true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('agy', provider, { displayName: 'Agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
  registry.register('kimi', provider, { displayName: 'Kimi', canResume: () => false })   // 没有 workbench 能力
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }, quotaExhausted: () => over.quotaExhausted ? { kind: 'quota', since: 0, resetAt: Date.now() + 1000, message: '满了' } : null, continuation: () => ({ mode: 'new' }) })
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry, ...(over.ack ? { unattendedAck: over.ack } : {}) }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeAdmissionDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  return { store, state, domain, task, project }
}

describe('makeAdmissionDomain · 准入', () => {
  it('provider:没登记 / 没有 workbench 能力 ⇒ unavailable_provider;有 ⇒ 登记项', () => {
    const { domain } = setup()
    expect(() => domain.provider('nope')).toThrow('unavailable_provider')
    expect(() => domain.provider('kimi')).toThrow('unavailable_provider')
    expect(domain.provider('claude').opts.displayName).toBe('Claude')
  })
  it('requireInput:免审执行者没接 ack / ack 为空 ⇒ unattended_ack_required;确认过 ⇒ 放行', () => {
    expect(() => setup().domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE)).toThrow('unattended_ack_required')
    let at: number | null = null
    const { domain } = setup({ ack: { get: () => at, set: v => { at = v } } })
    expect(() => domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE)).toThrow('unattended_ack_required')
    expect(domain.acknowledgeUnattended()).toBe(at)
    expect(domain.requireInput('agy', [], PROVIDER_EXECUTION_CHOICE).opts.displayName).toBe('Agy')
  })
  it('acknowledgeUnattended:没接 ack ⇒ unattended_ack_unavailable', () => {
    expect(() => setup().domain.acknowledgeUnattended()).toThrow('unattended_ack_unavailable')
  })
  it('requireEntryInput:额度耗尽(经 ctx.actions.quotaExhausted)⇒ provider_quota_exhausted', () => {
    expect(() => setup({ quotaExhausted: true }).domain.requireEntryInput('claude', [], PROVIDER_EXECUTION_CHOICE, '做')).toThrow('provider_quota_exhausted')
    expect(() => setup().domain.requireEntryInput('claude', [], PROVIDER_EXECUTION_CHOICE, '做')).not.toThrow()
  })
})

describe('makeAdmissionDomain · 续接判定', () => {
  it('canResume:没 sessionId ⇒ false;有且执行者说能 ⇒ true;执行者说不能 ⇒ false', () => {
    const { domain, task, store } = setup()
    expect(domain.canResume(store.get(task.id))).toBe(false)
    store.setSession(task.id, 'sess-1')
    expect(domain.canResume(store.get(task.id))).toBe(true)
    const no = setup({ canResume: false }); no.store.setSession(no.task.id, 'sess-1')
    expect(no.domain.canResume(no.store.get(no.task.id))).toBe(false)
  })
  it('continuation:没有 user/text 事件 ⇒ new;有且能续 ⇒ resume;有且不能续 ⇒ restart_required 带预览', () => {
    const { domain, task, store } = setup({ canResume: false })
    expect(domain.continuation(store.get(task.id))).toEqual({ mode: 'new' })
    store.addEvent(task.id, 'user', '做点事'); store.addEvent(task.id, 'text', '好了')
    const restart = domain.continuation(store.get(task.id))
    expect(restart.mode).toBe('restart_required'); expect(restart).toHaveProperty('restart.token')
    const yes = setup(); yes.store.addEvent(yes.task.id, 'text', '好了'); yes.store.setSession(yes.task.id, 'sess-1')
    expect(yes.domain.continuation(yes.store.get(yes.task.id))).toEqual({ mode: 'resume' })
  })
  it('taskVersion:事件变了版本就变;同一状态两次相同', () => {
    const { domain, task, store } = setup()
    const v1 = domain.taskVersion(store.get(task.id))
    expect(domain.taskVersion(store.get(task.id))).toBe(v1)
    store.addEvent(task.id, 'text', 'x')
    expect(domain.taskVersion(store.get(task.id))).not.toBe(v1)
  })
  it('prepareContinuation:还在跑 / 非终态 ⇒ workbench_busy;归档 ⇒ workbench_archived;导入未派发 ⇒ external_close_confirmation_required', () => {
    const { domain, task, store, state } = setup()
    expect(() => domain.prepareContinuation(task.id)).toThrow('workbench_busy')
    store.update(task.id, 'completed')
    expect(domain.prepareContinuation(task.id)).toEqual({ mode: 'new' })
    store.setArchived(task.id, true)
    expect(() => domain.prepareContinuation(task.id)).toThrow('workbench_archived')
  })
  it('modelCatalog:执行者没这功能 ⇒ model_catalog_unavailable', async () => {
    const { domain, project } = setup()
    await expect(domain.modelCatalog('claude', project)).rejects.toThrow('model_catalog_unavailable')
  })
})
```

`store.setSession` 的名字以 `store.ts` 为准(可能叫 `setSessionId` 或经 `update`);`state` 未用的话删掉解构。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './admission'`)。
- [ ] **Step 3: 新建 `service/admission.ts`** —— 脚本抠:A = `function provider(` 起到 `taskVersion` 那一行(六个连续定义,`:185-214`);B = public 的 `modelCatalog` 整段、`prepareContinuation` 整段、`acknowledgeUnattended`(含上面两行注释)整段。替换只有:`opts.registry`→`ctx.deps.registry`、`opts.unattendedAck`→`ctx.deps.unattendedAck`、`quota.exhausted(`→`ctx.actions.deref('admission').quotaExhausted(`、`ensureAccepting()`→`ctx.ensureAccepting()`、`runsByTask`→`ctx.state.runsByTask`。public 三个从方法简写改成 `function` 声明(同 PR 5 的 artifact/approve)。import:`isWorkbenchProviderId, isWorkbenchExecutorCapabilities, isUnattendedExecutor, canResumeWorkbenchExecutor, requireWorkbenchInput, type WorkbenchExecutorCapabilities` from `../executor-capabilities`;`restartPreview, type Continuation` from `../continuation`;`snapshotHash` from `../native-adoption`;`canonicalProject` from `../artifacts`;`normalizeExecutionChoice` from `../execution-settings`;`TERMINAL_TASK_STATUSES, type StoredTask` from `../store`;`type AgentExecutionChoice, type AgentModelCatalog` from `../../agent-provider`;`type Attachment` from `../attachments`。
- [ ] **Step 4: service.ts 接上** —— `const admissionDomain=makeAdmissionDomain(ctx)` + `const {provider,requireInput,requireEntryInput,canResume,continuation,taskVersion}=admissionDomain` 放在 quota 解构之后(view 与 notices 都不依赖它的构造顺序;但 `actions.set` 里的 `continuation` 引用解构名,不变);删 A/B;public 里 `modelCatalog:admissionDomain.modelCatalog,` `prepareContinuation:admissionDomain.prepareContinuation,` `acknowledgeUnattended:admissionDomain.acknowledgeUnattended,`。删不再用的 import(`grep -c`:`isUnattendedExecutor` `canResumeWorkbenchExecutor` `requireWorkbenchInput` `restartPreview` `type WorkbenchExecutorCapabilities` `type AgentModelCatalog` 可能只剩 import;`snapshotHash` `normalizeExecutionChoice` `TERMINAL_TASK_STATUSES` `canonicalProject` 别处还用)。
- [ ] **Step 5: 验证** —— admission 单测 9 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 29 文件全过(`service-unattended` / `service-capabilities` / `service-execution` 走完整链);depcheck `0 errors, 21 warnings`;逐字 diff 核对。
- [ ] **Step 6: Commit** —— `workbench service 拆分 18/n:admission 域搬进 service/admission.ts(准入/续接判定/版本 + modelCatalog/prepareContinuation/acknowledgeUnattended,行为不变)`

---

### Task 3: view 域

**Files:**
- Create: `src/core/workbench/service/view.ts`、`src/core/workbench/service/view.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export interface ViewDomain {
  held(): Active[]
  waitingFor(running:Active): TaskWaitingFor|null
  runtimeSnapshot(running:Active|undefined): AgentRuntimeSnapshot|undefined
  inputMode(running:Active): 'steer'|'send'|'queue'
  isReplied(running:Active): boolean
  phaseOf(task:Task,running:Active|undefined): WorkbenchPhase
  taskView(task:Task,includePermissions?:boolean): WorkbenchTaskView
  attention(): {tasks:Array<…>}            // 照 service.ts 的推导类型写,或 ReturnType 自引用
  projects(): ReturnType<typeof makeProjectCatalog>
  addProject(input:{path:string;name?:string;providerId:string}): ReturnType<WorkbenchStore['addProject']>
  list(query?:WorkbenchListQuery): …        // 同上
  detail(id:string,options?:{since?:number}): …
}
export function makeViewDomain(ctx:ServiceCtx): ViewDomain
```
`service.ts` 解构 `{held,runtimeSnapshot,inputMode,isReplied,taskView}`,并保留 `const quiet=isReplied`。`addProject` 用 `provider(...)`、`list` 用 `quota.exhausted`、`detail` 用 `continuation(...)` —— 分别走 `ctx.actions.deref('view').provider`(**Task 1 没加 `provider`**:在本 Task 顺手加进 `ServiceActions`,`actions.set` 用解构出来的 `provider`)、`.quotaExhausted`、`.continuation`。

- [ ] **Step 1: 写 `service/view.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore, publicTask } from '../store'
import { MANAGED_NATIVE_CAPABILITIES } from '../executor-capabilities'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider, AgentRuntimeSnapshot } from '../../agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeViewDomain } from './view'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }

function setup(over: { defaultProvider?: string; owner?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-view-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const actions = new Ref<ServiceActions>('t')
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => over.owner === undefined ? 'owner' : over.owner, registry, nativeHistory: { claude: {} as never }, ...(over.defaultProvider ? { defaultProvider: over.defaultProvider } : {}) }, ensureAccepting: () => {}, now: Date.now, actions }
  const domain = makeViewDomain(ctx)
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: domain.isReplied, fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }, quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), provider: id => { const p = registry.get(id); if (!p) throw new Error('unavailable_provider'); return p as never } })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const snapshot = (over: Partial<AgentRuntimeSnapshot> = {}): AgentRuntimeSnapshot => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send', ...over })
  /** 假 Active:带 runtime 快照与空的待决队列。 */
  const running = (over: Partial<Active> & { snap?: AgentRuntimeSnapshot } = {}): Active => {
    const { snap, ...rest } = over
    return { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, permissions: { pending: () => [] }, questions: { pending: () => [] }, session: snap ? { workbenchRuntime: { snapshot: () => snap } } : undefined, ...rest } as unknown as Active
  }
  return { store, state, domain, task, project, running, snapshot }
}

describe('makeViewDomain · 进度', () => {
  it('isReplied:retained + idle + 无后台 + 无待决 ⇒ true;取消/在写/有待决 ⇒ false', () => {
    const { domain, running, snapshot } = setup()
    expect(domain.isReplied(running({ snap: snapshot() }))).toBe(true)
    expect(domain.isReplied(running({ snap: snapshot({ foreground: 'running' }) }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), cancelled: true }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), permissions: { pending: () => [{}] } } as never))).toBe(false)
    expect(domain.isReplied(running())).toBe(false)   // 没有 runtime 快照
  })
  it('phaseOf / taskView:queued→queued;running 已答复→replied 否则 working;completed→replied;终态照抄;canArchive 只对没在跑的终态', () => {
    const { domain, running, snapshot, task, store, state } = setup()
    const t = (status: string) => ({ ...publicTask(store.get(task.id)), status } as never)
    expect(domain.phaseOf(t('queued'), undefined)).toBe('queued')
    expect(domain.phaseOf(t('running'), running({ snap: snapshot() }))).toBe('replied')
    expect(domain.phaseOf(t('running'), running())).toBe('working')
    expect(domain.phaseOf(t('completed'), undefined)).toBe('replied')
    expect(domain.phaseOf(t('failed'), undefined)).toBe('failed')
    expect(domain.taskView(t('completed')).canArchive).toBe(true)
    expect(domain.taskView({ ...t('completed'), error: 'writer_not_closed' } as never).canArchive).toBe(false)
    state.runsByTask.set(task.id, running())
    expect(domain.taskView(t('completed')).canArchive).toBe(false)
    expect(domain.taskView(t('running'), true)).toMatchObject({ pendingPermissionCount: 0, pendingQuestionCount: 0 })
  })
  it('waitingFor:不在排队 ⇒ null;同路径被占、持有者已答复 ⇒ holderWriting=false 且 closeInMs≥0;持有者找不到 ⇒ holderWriting=true', () => {
    const { domain, running, snapshot, state } = setup()
    expect(domain.waitingFor(running())).toBeNull()
    const holder = running({ identity: 'holder', snap: snapshot(), idleClose: { timer: 0 as never, at: Date.now() + 5000, reason: 'idle' } })
    state.reservations.set('holder', holder); state.runsByTask.set(holder.taskId, holder)
    const waiter = running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued' })
    const w = domain.waitingFor(waiter)
    expect(w).toMatchObject({ holderWriting: false }); expect(w!.closeInMs).toBeGreaterThanOrEqual(0)
    state.runsByTask.clear()
    expect(domain.waitingFor(waiter)).toMatchObject({ holderWriting: true, closeInMs: null })
  })
  it('attention:只列有待决权限/提问的 run', () => {
    const { domain, running, state, task } = setup()
    state.runsByTask.set(task.id, running())
    expect(domain.attention().tasks).toEqual([])
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1' }] } } as never))
    expect(domain.attention().tasks).toMatchObject([{ id: task.id, pendingPermissionCount: 1, pendingQuestionCount: 0 }])
  })
})

describe('makeViewDomain · 列表与详情', () => {
  it('list:执行者带能力/额度/用量;defaultProvider 不在名单 ⇒ 回落第一个;historyProviders / canWechat / unattendedAcknowledgedAt', () => {
    const { domain } = setup({ defaultProvider: 'nope' })
    const l = domain.list()
    expect(l.providers.map(p => p.id)).toEqual(['claude', 'codex'])
    expect(l.defaultProvider).toBe('claude'); expect(l.historyProviders).toEqual(['claude']); expect(l.canWechat).toBe(true); expect(l.unattendedAcknowledgedAt).toBeNull()
    expect(setup({ defaultProvider: 'codex' }).domain.list().defaultProvider).toBe('codex')
  })
  it('projects:没配主人 ⇒ [];addProject:畸形 ⇒ invalid_request、未知执行者 ⇒ unavailable_provider', () => {
    expect(setup({ owner: null }).domain.projects()).toEqual([])
    const { domain, project } = setup()
    expect(() => domain.addProject({ path: project, providerId: 'nope' })).toThrow('unavailable_provider')
    expect(() => domain.addProject({ path: project, providerId: 'claude', name: '' })).toThrow('invalid_request')
    expect(domain.addProject({ path: project, providerId: 'claude' })).toMatchObject({ path: project })
  })
  it('detail:没在跑 ⇒ 带 continuation(经 ctx.actions)、没有 inputMode;在跑 ⇒ runId + inputMode', () => {
    const { domain, running, snapshot, task, state } = setup()
    const d1 = domain.detail(task.id)
    expect(d1).toMatchObject({ continuation: { mode: 'new' }, wechatNotifications: { enabled: false } }); expect(d1).not.toHaveProperty('inputMode')
    state.runsByTask.set(task.id, running({ snap: snapshot({ input: 'steer' }) }))
    expect(domain.detail(task.id)).toMatchObject({ runId: 'run-1', inputMode: 'steer' })
  })
})
```

`Active.idleClose` / `state` 字段名以 `service/state.ts` 为准;`store.detail` 的返回形状以 `store.ts` 为准。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './view'`)。
- [ ] **Step 3: `ServiceActions` 加 `provider`**(签名照 `AdmissionDomain['provider']`),`actions.set` 补 `provider`,admission.test / review.test / notices.test 的 stub 补 `provider: () => { throw new Error('unused') }`。
- [ ] **Step 4: 新建 `service/view.ts`** —— 脚本抠:A = `const held=` 上面那行注释起到 `taskView` 闭合 `}`(`:240-284`);B = public 的 `attention` 整段、`projects` 整段、`addProject` 整段、`list` 整段、`detail` 整段(五段不连续,各按首行锚点到各自 `    },`)。替换只有:`opts.ownerChatId`→`ctx.deps.ownerChatId`、`opts.registry`→`ctx.deps.registry`、`opts.registeredProjects`→`ctx.deps.registeredProjects`、`opts.defaultProvider`→`ctx.deps.defaultProvider`、`opts.nativeHistory`→`ctx.deps.nativeHistory`、`opts.usage`→`ctx.deps.usage`、`opts.unattendedAck`→`ctx.deps.unattendedAck`、`touched(`→`ctx.hub.touched(`、`runsByTask`/`reservations`/`queue`→`state.xxx`(域内 `const { store, state } = ctx`)、`quiet(`→`isReplied(`、`quota.exhausted(`→`ctx.actions.deref('view').quotaExhausted(`、`continuation(`→`ctx.actions.deref('view').continuation(`、`provider(`→`ctx.actions.deref('view').provider(`(只在 addProject 里)。public 五个改 `function` 声明。import:`findPathBlocker` from `../scheduler`;`makeProjectCatalog` from `../project-catalog`;`isWorkbenchProviderId, isWorkbenchExecutorCapabilities` from `../executor-capabilities`;`canonicalProject` from `../artifacts`;`TERMINAL_TASK_STATUSES, type Task, type WorkbenchListQuery` from `../store`;`type AgentRuntimeSnapshot` from `../../agent-provider`;`type TaskWaitingFor` from `../wechat-types`;`type WorkbenchPhase, type WorkbenchTaskView` from `./types`;`type Active` from `./state`。
- [ ] **Step 5: service.ts 接上** —— `const viewDomain=makeViewDomain(ctx)` + `const {held,runtimeSnapshot,inputMode,isReplied,taskView}=viewDomain` 放在 admission 解构之后;`const quiet=isReplied` 那行留在原地;删 A/B;public 里五个换成 `xxx:viewDomain.xxx,`。删不再用的 import(`findPathBlocker` `makeProjectCatalog` `type WorkbenchListQuery` `type AgentRuntimeSnapshot` `type TaskWaitingFor` 大概率只剩 import;`publicTask` `TERMINAL_TASK_STATUSES` `isWorkbenchProviderId` 别处还用)。
- [ ] **Step 6: 验证** —— view 单测 7 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 30 文件全过(`service-phase` / `service-lease` / `service-one-session` / `service.test` 走完整链);depcheck `0 errors, 21 warnings`;逐字 diff 核对。
- [ ] **Step 7: Commit** —— `workbench service 拆分 19/n:view 域搬进 service/view.ts(进度/等待行/任务视图 + attention/projects/addProject/list/detail,行为不变)`

---

### Task 4: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈1360 行 / 34),改常量与注释「当前值 = PR 6 搬完 admission + view 域之后的实际值」。数字手抄。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 703 文件 / 9293 条(PR 5 后 701/9277 + 2 文件 16 条);node 全绿;0;`0 errors, 21 warnings`。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 20/n:棘轮下调到搬完 admission+view 域的实际值;附 PR 6 计划`

---

### Task 5: 推分支、PR、CI、合入后真机

同 PR 5 Task 4(`selftest workbench` 的 `created` / `replied` / `resume_replied` 走的正是 taskView / phaseOf / continuation)。

---

## Self-Review

- **Spec 覆盖**:§3 第 7 项 admission + view ✓(提前到第 6 项前,Architecture 有裁决);§2 `service/admission.ts` / `service/view.ts` ✓;§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2/3 Step 3-4 按锚点抠、diff 核对;接口里「照推导类型写」有回退办法(`ReturnType` 自引用)。
- **类型一致**:Task 1 产 `deps.*` 与 `actions.quotaExhausted/continuation`,Task 2/3 消费;Task 3 补 `actions.provider`;解构名与调用点同名。
- **Review Focus** 归属:1→Task 2「免审门」;2→Task 2「三态」;3→Task 3「phaseOf/taskView」;4→Task 3「waitingFor」;5→Task 3「list」。
