# workbench service 拆分 · PR 8(inputs 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 inputs 域(主人的补充:`holdInputs` / `hasUndeliveredInput` / `drainInputs` / `settleRuntimeInput` 四个闭包 + `submitInput` / `withdrawInput` / `resolveAnswer` / `resolvePermission` 四个入口,以及 `autoContinueBlocked` 这份状态和 `INPUT_UNCONFIRMED` 常量)逐字搬进 `service/inputs.ts`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1–7。inputs 域与 lifecycle 互相调用(`submitInput` 要 `cancelIdleClose` / `armIdleClose`,`resolveAnswer` / `resolvePermission` 要 `settleAfterDecision`;反过来 lifecycle 的 `armIdleClose` / `closeForIdle` 要 `hasUndeliveredInput`,execute / `cancelRun` 要 `holdInputs` / `drainInputs` / `settleRuntimeInput`)—— 这是 spec §1 说的环第一次真正经 `ctx.actions` 走:inputs → lifecycle 的三个动作进 `ServiceActions`(真正的晚绑定),lifecycle/execute → inputs 的四个帮手由 service.ts 解构(它们还在 service.ts 里,下个 PR 搬 lifecycle 时再反过来进 actions)。另加 `continuationAttachmentScope`(attachments)与 `inputMode`(view)两个查询进 actions。`autoContinueBlocked` 进 `WorkbenchRuntimeState`;`INPUT_UNCONFIRMED` 只有 inputs 用,随域走。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 8 项)。基线 dev `eb2736c2`(#139 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-8`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案(`INPUT_UNCONFIRMED` / `原会话需要你确认恢复方式…` / `input_*` 错误码逐字)、上限(10 条)。逐字搬,注释一起搬(submitInput 里三段「评审修复轮」注释是安全依据)。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。域单测允许补 stub。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 链式命令里别用 `grep -c` 当中间环节。

## Review Focus

1. **`submitInput` 入口先 `cancelIdleClose`,存不下来时 `armIdleClose` 兜回去**(评审 2026-09-21 修复轮 #1)—— 搬家后这两处经 `ctx.actions` 仍在同一位置。Task 2 域单测「入口调用 cancelIdleClose;`liveInputs.add` 抛 ⇒ armIdleClose 被调且错误透传」钉住。
2. **两处 await 之后重跑守卫**(`runsByTask.get(id)!==running||cancelled||finishing||uncertain ⇒ input_stale`)逐字。Task 2 域单测「await 期间 run 被替换 ⇒ input_stale、不落库」钉住(stub `reviewCapture` 为一个我们控制的 promise,在它 resolve 前把 `state.runsByTask` 换掉)。
3. **`autoContinueBlocked` 是同一个 Set**:`holdInputs` 加、成功后删;`settleRuntimeInput` 写库失败加;`drainInputs` / `submitInput` 读 —— 全在 `state.autoContinueBlocked`。Task 1 `state.test` 加初值断言;Task 2 域单测「holdInputs 落库成功后集合里没有它;settleRuntimeInput 写库抛 ⇒ 集合里有它 ⇒ submitInput 抛 input_storage_unavailable」钉住。
4. **`drainInputs` 只在 `continuation.mode==='resume'` 时派发**,否则 `holdInputs(id,'原会话需要你确认恢复方式，补充尚未发送。')` —— Task 2 域单测钉住文案。
5. **`settleRuntimeInput` 的三态**:shutdownComplete ⇒ 只删本地登记;error ⇒ 仅 sending→held(附错误信息);成功 ⇒ sending/held→delivered + user 事件 —— Task 2 域单测三条。

---

### Task 1: `state.autoContinueBlocked` + `ServiceActions` 五个字段

**Files:**
- Modify: `service/state.ts`、`service/state.test.ts`、`service/ctx.ts`、`service.ts`(ctx/actions.set、删 `const autoContinueBlocked=new Set<string>()` 改用 `state.autoContinueBlocked`)、五份域单测 stub(review / notices / admission / view / native)

**Interfaces:**
```ts
// state.ts
export interface WorkbenchRuntimeState { …; /** 补充暂时不能自动续投的任务(存库失败 / 被 hold 中);见 inputs 域。 */ autoContinueBlocked: Set<string> }
// ctx.ts
export interface ServiceActions {
  …
  continuationAttachmentScope(taskId:string,ids:unknown): {ownerKey:string}|undefined
  inputMode(running:Active): 'steer'|'send'|'queue'
  armIdleClose(running:Active): void
  cancelIdleClose(running:Active): void
  settleAfterDecision(running:Active): void
}
```

- [ ] **Step 1: `state.test.ts` 加断言(红)** —— 第一条 it 里加 `expect(a.autoContinueBlocked.size).toBe(0)`。跑 → TS 报属性不存在(vitest 会因 bun 转译不报类型错而直接 `undefined.size` 抛)—— 红。
- [ ] **Step 2**:`state.ts` 接口与 `makeRuntimeState` 加 `autoContinueBlocked: new Set()`;`ctx.ts` 加五个 actions。typecheck 红(service.ts `actions.set` 与五份 stub)。
- [ ] **Step 3**:service.ts 删 `const autoContinueBlocked=new Set<string>()`,把 `autoContinueBlocked` 全部改成 `state.autoContinueBlocked`(6 处,用 tsc 报的 `Cannot find name` 定位,逐处改);`actions.set` 加 `continuationAttachmentScope,inputMode,armIdleClose,cancelIdleClose,settleAfterDecision`(后三个是 function 声明,提升可引用)。五份 stub 各补 `continuationAttachmentScope: () => undefined, inputMode: () => 'queue', armIdleClose: () => {}, cancelIdleClose: () => {}, settleAfterDecision: () => {}`。
- [ ] **Step 4: 验证** —— typecheck 0;`bun --bun vitest run src/core/workbench/service` 全过;depcheck `0 errors, 21 warnings`。
- [ ] **Step 5: Commit** —— `workbench service 拆分 24/n:autoContinueBlocked 进 state;actions 加 inputs 域要的五个动作(行为不变)`

---

### Task 2: inputs 域

**Files:**
- Create: `src/core/workbench/service/inputs.ts`、`src/core/workbench/service/inputs.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export function makeInputsDomain(ctx:ServiceCtx) {
  …
  return { holdInputs,hasUndeliveredInput,drainInputs,settleRuntimeInput, submitInput,withdrawInput,resolveAnswer,resolvePermission }
}
export type InputsDomain = ReturnType<typeof makeInputsDomain>
```
`service.ts` 解构 `{holdInputs,hasUndeliveredInput,drainInputs,settleRuntimeInput}`(lifecycle / execute / cancelRun 调用点不改);public 四个换成 `xxx:inputsDomain.xxx,`;`actions.set` 里 `submitInput:(id,input,policy)=>service.submitInput(id,input,policy)` 不动。

- [ ] **Step 1: 写 `service/inputs.test.ts`(红)**

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
import { PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeInputsDomain } from './inputs'
import { directoryIdentity } from './directory-identity'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }
const unused = () => { throw new Error('unused') }
const REQ = '11111111-1111-4111-8111-111111111111'

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-inputs-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn() }
  const actions = new Ref<ServiceActions>('t')
  const spies = { armIdleClose: vi.fn(), cancelIdleClose: vi.fn(), settleAfterDecision: vi.fn(), start: vi.fn(), continuation: vi.fn(() => ({ mode: 'new' } as never)), inputMode: vi.fn(() => 'queue' as const) }
  actions.set({ submitInput: vi.fn(), continueTask: vi.fn(), isReplied: () => false, fallbackExecutor: () => null, artifact: unused, quotaExhausted: () => null, continuation: spies.continuation, provider: unused, requireInput: id => registry.get(id) as never, canResume: () => false, taskVersion: () => 'v', selectAttachments: () => [], combinedAttachments: c => [...c], handoffAttachments: () => [], taskView: t => t as never, matterSync: () => {}, start: spies.start, continuationAttachmentScope: () => undefined, inputMode: spies.inputMode, armIdleClose: spies.armIdleClose, cancelIdleClose: spies.cancelIdleClose, settleAfterDecision: spies.settleAfterDecision })
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeInputsDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1', taskId: task.id, title: task.title, task, path: project, directoryIdentity: directoryIdentity(project), execution: PROVIDER_EXECUTION_CHOICE, cancelled: false, finishing: false, uncertain: false, delivering: false, permissions: { pending: () => [], resolve: () => true }, questions: { pending: () => [], resolve: () => true }, ...over } as unknown as Active)
  const pending = (text = '补一句') => store.liveInputs.add({ id: REQ, taskId: task.id, runId: 'run-1', text, attachments: [], execution: PROVIDER_EXECUTION_CHOICE })
  return { store, state, hub, domain, task, project, running, spies, pending }
}

describe('makeInputsDomain · 拍板与撤回', () => {
  it('withdrawInput:不存在 / 不是 pending ⇒ input_stale;pending ⇒ withdrawn + bumped', () => {
    const { domain, task, store, hub, pending } = setup()
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
    pending(); domain.withdrawInput(task.id, REQ)
    expect(store.liveInputs.get(REQ)!.status).toBe('withdrawn'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    expect(() => domain.withdrawInput(task.id, REQ)).toThrow('input_stale')
  })
  it('resolveAnswer / resolvePermission:没 run ⇒ *_stale;拍板后 bumped 且经 ctx.actions.settleAfterDecision 补一次落定;非法 decision ⇒ invalid_decision', () => {
    const { domain, task, state, running, spies, hub } = setup()
    expect(() => domain.resolveAnswer(task.id, 'q1', {})).toThrow('question_stale')
    expect(() => domain.resolvePermission(task.id, 'p1', 'allow')).toThrow('permission_stale')
    expect(() => domain.resolvePermission(task.id, 'p1', 'maybe' as never)).toThrow('invalid_decision')
    const r = running(); state.runsByTask.set(task.id, r)
    domain.resolveAnswer(task.id, 'q1', {}); domain.resolvePermission(task.id, 'p1', 'deny')
    expect(spies.settleAfterDecision).toHaveBeenCalledTimes(2); expect(hub.bumped).toHaveBeenCalledTimes(2)
  })
})

describe('makeInputsDomain · 补充的投递', () => {
  it('submitInput:带 execution ⇒ invalid_execution;stopping ⇒ workbench_stopping;被 hold 中 ⇒ input_storage_unavailable;没 run ⇒ input_stale', async () => {
    const { domain, task, state } = setup()
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x', execution: {} } as never)).rejects.toThrow('invalid_execution')
    state.autoContinueBlocked.add(task.id)
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('input_storage_unavailable')
    state.autoContinueBlocked.clear()
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('input_stale')
    state.stopping = true
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('workbench_stopping')
  })
  it('submitInput:没有 runtime 也没有 steer ⇒ 存成 pending 返回;入口先 cancelIdleClose;同 id 重发同文 ⇒ 幂等返回,异文 ⇒ input_conflict', async () => {
    const { domain, task, state, running, spies, store } = setup()
    state.runsByTask.set(task.id, running())
    const saved = await domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '补一句' })
    expect(saved).toMatchObject({ id: REQ, status: 'pending', text: '补一句' }); expect(spies.cancelIdleClose).toHaveBeenCalledTimes(1)
    expect(await domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '补一句' })).toMatchObject({ id: REQ })
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: '另一句' })).rejects.toThrow('input_conflict')
    expect(store.liveInputs.count(task.id)).toBe(1)
  })
  it('submitInput:存库失败 ⇒ armIdleClose 兜回去、错误透传', async () => {
    const { domain, task, state, running, spies, store } = setup()
    state.runsByTask.set(task.id, running())
    vi.spyOn(store.liveInputs, 'add').mockImplementationOnce(() => { throw new Error('disk_full') })
    await expect(domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })).rejects.toThrow('disk_full')
    expect(spies.armIdleClose).toHaveBeenCalledTimes(1)
  })
  it('submitInput:await 基线期间 run 被替换 ⇒ input_stale、不落库', async () => {
    const { domain, task, state, running, spies, store } = setup()
    let release!: () => void
    const capture = new Promise<void>(r => { release = r })
    const r = running({ session: { workbenchRuntime: { snapshot: () => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send' }), submit: unused } }, reviewCapture: capture } as never)
    spies.inputMode.mockReturnValue('send'); state.runsByTask.set(task.id, r)
    const p = domain.submitInput(task.id, { runId: 'run-1', requestId: REQ, text: 'x' })
    state.runsByTask.set(task.id, running({ identity: 'run-2' })); release()
    await expect(p).rejects.toThrow('input_stale'); expect(store.liveInputs.count(task.id)).toBe(0)
  })
})

describe('makeInputsDomain · 持有、排空与结算', () => {
  it('holdInputs:pending 变 held、bumped;落库成功后 autoContinueBlocked 里没有它;hasUndeliveredInput 随之为 false', () => {
    const { domain, task, state, store, hub, pending, running } = setup()
    pending(); expect(domain.hasUndeliveredInput(running())).toBe(true)
    domain.holdInputs(task.id, '任务已停止')
    expect(store.liveInputs.get(REQ)!.status).toBe('held'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    expect(state.autoContinueBlocked.has(task.id)).toBe(false); expect(domain.hasUndeliveredInput(running())).toBe(false)
  })
  it('drainInputs:被 hold 中 / 没有 pending ⇒ 不动;有 pending 但续接不是 resume ⇒ hold 并留下「原会话需要你确认恢复方式，补充尚未发送。」;是 resume ⇒ 经 ctx.actions.start 派发', () => {
    const { domain, task, state, store, pending, spies, project } = setup()
    domain.drainInputs(task.id, directoryIdentity(project)); expect(spies.start).not.toHaveBeenCalled()
    pending(); state.autoContinueBlocked.add(task.id); domain.drainInputs(task.id, directoryIdentity(project)); expect(store.liveInputs.get(REQ)!.status).toBe('pending')
    state.autoContinueBlocked.clear(); domain.drainInputs(task.id, directoryIdentity(project))
    expect(store.liveInputs.get(REQ)).toMatchObject({ status: 'held' }); expect(store.liveInputs.get(REQ)!.reason ?? store.liveInputs.get(REQ)!.error).toContain('原会话需要你确认恢复方式')
    const again = setup(); again.pending(); again.store.session(again.task.id, 'sess'); again.spies.continuation.mockReturnValue({ mode: 'resume' } as never)
    again.domain.drainInputs(again.task.id, directoryIdentity(again.project))
    expect(again.spies.start).toHaveBeenCalledTimes(1); expect(again.store.liveInputs.get(REQ)!.status).toBe('sending')
  })
  it('settleRuntimeInput:shutdownComplete ⇒ 只删本地登记;error ⇒ sending→held 带错误信息;成功 ⇒ delivered + user 事件 + touched', () => {
    const { domain, task, state, store, hub, pending, running } = setup()
    const saved = pending(); store.liveInputs.set(REQ, 'sending')
    const r = running({ runtimeInputs: new Map([[REQ, saved]]) } as never)
    state.shutdownComplete = true; domain.settleRuntimeInput(r, saved); expect(r.runtimeInputs!.size).toBe(0); expect(store.liveInputs.get(REQ)!.status).toBe('sending')
    state.shutdownComplete = false; r.runtimeInputs!.set(REQ, saved)
    domain.settleRuntimeInput(r, saved, new Error('boom')); expect(store.liveInputs.get(REQ)!.status).toBe('held'); expect(hub.bumped).toHaveBeenCalledWith(task.id)
    r.runtimeInputs!.set(REQ, saved); domain.settleRuntimeInput(r, saved)
    expect(store.liveInputs.get(REQ)!.status).toBe('delivered'); expect(store.events(task.id).some(e => e.kind === 'user' && e.text === '补一句')).toBe(true); expect(hub.touched).toHaveBeenCalledWith(task.id)
  })
})
```

`liveInputs.add/set/get/hold/next/count` 与 held 记录里错误字段的名字(`reason` / `error`)以 `live-inputs.ts` 为准;`store.session` 是会话 setter(PR 6 核过)。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './inputs'`)。
- [ ] **Step 3: 新建 `service/inputs.ts`** —— 脚本抠:A = `function holdInputs(` 起到闭合 `}`;B = `hasUndeliveredInput` 上面那段注释 `/**` 起到函数闭合 `}`(**不要**带走后面「会话安静下来就起一个计时器」那段——那是 `armIdleClose` 的注释);C = `function drainInputs(` 起到 `settleRuntimeInput` 闭合 `}`;D = public 四段(`resolveAnswer` / `withdrawInput` / `async submitInput` / `resolvePermission`,各到 `    },`);E = `const INPUT_UNCONFIRMED=…` 那一行(模块级,搬到域文件顶部)。替换只有:`opts.stateDir`→`ctx.stateDir`、`ensureAccepting()`→`ctx.ensureAccepting()`、`touched(`→`ctx.hub.touched(`、`bumped(`→`ctx.hub.bumped(`、`runsByTask`/`autoContinueBlocked`→`state.*`(逐个名字,带 `(?<![.\w])…(?![\w])` 边界;`state.autoContinueBlocked` 在 service.ts 里已是 `state.` 形式,抠出来的文本里别双加),以及经 `const a=()=>ctx.actions.deref('inputs')`:`continuation(`、`requireInput(`、`start(`、`selectAttachments(`、`continuationAttachmentScope(`、`inputMode(`、`cancelIdleClose(`、`armIdleClose(`、`settleAfterDecision(`。public 四段改 `function` 声明。import:`captureGitBaseline` from `../git-review`;`canonicalProject` from `../artifacts`;`normalizeInputRequestId, sameAttachments, type LiveInput` from `../live-inputs`;`type PermissionDecision` from `../permissions`;`checkedText` from `./checked-text`;`directoryIdentity` from `./directory-identity`;`type Active` from `./state`;`type InputMaterials` from `./types`;`type ServiceCtx` from `./ctx`。
- [ ] **Step 4: service.ts 接上** —— `const inputsDomain=makeInputsDomain(ctx)` + `const {holdInputs,hasUndeliveredInput,drainInputs,settleRuntimeInput}=inputsDomain` 放在 native 解构之后;删 A–E;public 四个换引用;`tsc --noEmit --noUnusedLocals | grep service.ts` 清腾出来的 import(只删 import 行里的名字)。
- [ ] **Step 5: 验证** —— inputs 单测 9 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 33 文件全过(`service-live` / `service-background` / `service-execution` 走完整投递链);depcheck `0 errors, 21 warnings`;逐字 diff 核对。
- [ ] **Step 6: Commit** —— `workbench service 拆分 25/n:inputs 域搬进 service/inputs.ts(补充的持有/排空/结算 + submitInput/withdrawInput/resolveAnswer/resolvePermission,行为不变)`

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈1050 行 / 27),改常量与注释「当前值 = PR 8 搬完 inputs 域之后的实际值」(用 python 正则改注释,sed 上次没命中)。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 706 文件 / 9312 条(PR 7 后 705/9303 + 1 文件 9 条);node 全绿;0;`0 errors, 21 warnings`。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 26/n:棘轮下调到搬完 inputs 域的实际值;附 PR 8 计划`

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 7 Task 4;`selftest workbench --resume` 对 claude/codex 走 `submitInput`(cursor 走 `continue`),合入后额外跑一次 `selftest workbench --executor claude --resume` 让 `submitInput` 真机过一遍(claude 有额度的话;没有就记下来等主人)。

---

## Self-Review

- **Spec 覆盖**:§3 第 8 项 inputs ✓;§2 `service/inputs.ts` ✓;§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓;§1「环第一次经 ctx.actions 走」的前半段(inputs→lifecycle)在本 PR 落地,后半段等 PR 9。
- **占位符**:Task 2 Step 3 五块按锚点抠,替换清单带边界。
- **类型一致**:Task 1 产 `state.autoContinueBlocked` 与五个 actions,Task 2 消费;四个解构名与调用点同名。
- **Review Focus** 归属:1→「存库失败 ⇒ armIdleClose」+「入口 cancelIdleClose」;2→「await 期间 run 被替换」;3→state.test + 「holdInputs / settleRuntimeInput 与集合」;4→「drainInputs 文案」;5→「settleRuntimeInput 三态」。
