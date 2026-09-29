# workbench service 拆分 · PR 1(地基 + review 域 + 断环)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/core/workbench/service.ts` 拆分的地基(`service/types.ts`、`service/state.ts`、`service/ctx.ts`)和第一个域(review)落地,顺手断掉 `wechat-control.ts ↔ service.ts` 的 import 环,并用棘轮守卫钉住 `service.ts` 只降不升 —— **行为一字不变**,20 份 `service*.test.ts` 一行不改、全绿。

**Architecture:** 闭包拆模块 + 显式 `ServiceCtx`。域工厂 `makeReviewDomain(ctx)` 返回函数集,`service.ts` 的 public 对象直接引用;域需要「别的域 / service 自己的动作」一律经 `ctx.actions.deref()`(`src/lib/lifecycle.ts` 的 `Ref`,daemon 接线在用的同一套晚绑定,只此一种)。共享可变状态集中到 `WorkbenchRuntimeState` 一个对象;`service.ts` 对 7 个容器解构(引用不变),6 个 `let` 改成 `state.x`。类型先于代码搬:所有会被域模块引用的类型必须离开 `service.ts`,否则 `service/*.ts → service.ts` 就是新环。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`,所以类型 import 必须写 `import type`)、vitest(`bun --bun vitest run` / `npm run test:node`)、dependency-cruiser(`bun run depcheck`)。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 1 项;本计划实施基线 dev `6c455751`,Codex #129 之后)。

## Global Constraints

- 只在 `dev` 分支族上干活;本 PR 分支 `sweep/workbench-service-split`,工作树 `.claude/worktrees/deploy-dev`。进 dev 走 PR + squash。
- 不改任何行为、错误码、事件文案、超时数值(spec §4)。搬代码**逐字**搬,注释一起搬(注释里的安全依据尤其)。
- 不改 public 方法签名、不改 `WorkbenchService` 类型的形状(`routes-workbench.ts`、`wire-workbench.ts`、桌面代理都依赖它)。
- 20 份既有 `src/core/workbench/service*.test.ts` **一行不改**,每个任务结束时全绿。
- 不碰 `store.ts` / `wire-workbench.ts` / `routes-workbench.ts`;不动 store 层那 4 个循环 warn。
- 新文件目录 `src/core/workbench/service/`;`service/*.ts` **禁止** import `../service`(值或类型都不行 —— depcruise 对 type-only import 同样算环,`wechat-control.ts` 那个 warn 就是 type-only 环)。
- 每个任务一个 commit,信息用中文、写清「行为不变」;结尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`returnReviewFiles` 的「标记在续接成功之后才落」** —— 搬进域后 `ctx.actions.deref().continueTask` 抛 `workbench_busy` / `restart_confirmation_required` 时,`store.reviewMarks` 必须仍是空的。Task 3 的域单测「continueTask 抛错 ⇒ 不落标记」钉住。
2. **`ctx.actions` 在 `service` 对象建好之前被 deref** —— `Ref.deref` 会抛 `accessed before set`;域工厂只能在**调用时**取,不能在工厂体里取。Task 3 的域单测「构造 makeReviewDomain 时 actions 尚未 set 也不抛」钉住。
3. **6 个 `let` 改 `state.x` 漏改一处** —— 删掉 `let` 声明后 `tsc` 会把每个残留裸引用报成 `Cannot find name`,Task 2 以「typecheck 0 错」为门;此外 `shutdown()` 里 `shutdownComplete=true` 和 `collect()` 里读它是同一个对象,`service-lease.test.ts` / `service-background.test.ts` 覆盖。
4. **`service.ts` 对外 re-export 的类型少了一个** —— `apps/desktop`、`src/daemon` 只从 `./service` 取类型;Task 1/2 结束时 `bun run typecheck` 覆盖整仓库(含 `apps/mobile`),少一个就红。
5. **review 域读 `running.identity` 时 `runsByTask` 拿到的是别的 run** —— 域用的是 `ctx.state.runsByTask`,和 `service.ts` 解构出来的 `runsByTask` 必须是**同一个 Map 实例**。Task 2 的 `state.test.ts` 钉住「makeRuntimeState 的容器是同一引用可被解构」;Task 3 的域单测用 `state.runsByTask.set(...)` 后经域读到。

---

## §1 重画(spec 要求:按合入后的行号)

`service.ts` 现 1965 行(`6c455751`)。本 PR 只动打 ★ 的行段,其余留给后续 PR:

| 域 | 闭包(6c455751 行号) | public 方法 | 本 PR |
|---|---|---|---|
| 类型(公共) | 139-156 `InputMaterials` `CreateTask` `CreateWechatTask` `SendWechatArtifact` `WorkbenchPhase` `TaskWaitingFor` `WorkbenchTaskView` `EntryResult` | — | ★ 搬到 `wechat-types.ts` / `service/types.ts`,`service.ts` re-export |
| 运行时状态 | 81-137 `Active` / 138 `AcceptedContinuation`;280-305 七个容器 + 六个 `let` | — | ★ `service/state.ts` |
| hub | 209-213 `changes` `touched` `bumped` | `changes.wait` | ★ 进 `ctx.hub`(定义留在 service.ts) |
| review | 1266-1291 四个帮手;1853-1921 三个方法 | `reviewList` `markReviewFile` `returnReviewFiles` | ★ `service/review.ts` |
| attachments / entry | 214-263 | `uploadAttachment` `readAttachment` `discardAttachment` `createEntry` … | PR 2 |
| quota | 284-294 | `providerQuota` `quotaExhausted` `fallbackExecutor` | PR 3 |
| notices / wechat | 306-386 | `deliverWechatArtifact` `setWechatWatch` `createWechat` `handleWechat` | PR 4 |
| artifacts / 快照 | 488-612 | `artifact` `approve` | PR 5 |
| native / handoff | 417-438, 256-263 | `importNativeHistory` `prepareNativeResume` `continueNativeTask` `previewHandoff` `handoff` | PR 6 |
| admission + view | 387-416, 439-487 | `prepareContinuation` `acknowledgeUnattended` `modelCatalog` `attention` `list` `detail` | PR 7 |
| inputs | 264-279, 1064-1104 | `submitInput` `withdrawInput` | PR 8 |
| lifecycle + settle | 614-777, 1105-1133, 1238-1265, `shutdown` | `cancel` `setArchived` `shutdown` | PR 9 |
| execute / start / create | 778-1063, 1134-1237 | `create` `continueTask` | PR 10 |

环:`wechat-control.ts:6` 从 `./service` 取三个类型(type-only);`service.ts:2` 从 `./wechat-control` 取 `makeWechatWorkbenchControl`(值)。本 PR 断掉。

---

### Task 1: `wechat-types.ts` + 断环 + depcruise 规则 + 守卫骨架

**Files:**
- Create: `src/core/workbench/wechat-types.ts`
- Create: `scripts/workbench-service-ratchet.guard.test.ts`
- Modify: `src/core/workbench/service.ts:141-142,154`(删三个定义,改成 re-export)
- Modify: `src/core/workbench/wechat-control.ts:6`
- Modify: `.dependency-cruiser.cjs`(`forbidden` 数组加两条)

**Interfaces:**
- Produces: `src/core/workbench/wechat-types.ts` 导出 `CreateWechatTask`、`SendWechatArtifact`、`TaskWaitingFor`(三个 interface,定义逐字不变);`service.ts` 仍 `export type {CreateWechatTask,SendWechatArtifact,TaskWaitingFor}`,外部 import 路径不用改。

- [ ] **Step 1: 写守卫(红)** —— 新建 `scripts/workbench-service-ratchet.guard.test.ts`:

```ts
/**
 * core/workbench/service.ts 的棘轮守卫(spec 2026-09-27-workbench-service-split §5)。
 * 行数与 makeWorkbenchService 内函数数只许降;新域进 src/core/workbench/service/<domain>.ts。
 * 搬走一个域就把上限往下调 —— 棘轮只往一个方向转。
 * 另钉两条环:wechat-control.ts 不许回头 import ./service;service/*.ts 不许 import ../service。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WB = join(ROOT, 'src', 'core', 'workbench')
const src = readFileSync(join(WB, 'service.ts'), 'utf8')

// Task 4 会把这两个数调成搬完 review 域之后的实际值;此刻先按 6c455751 的现状钉住「不再增长」。
const MAX_LINES = 1965
const MAX_INNER_FUNCTIONS = 130

const lineCount = (s: string) => s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
/** makeWorkbenchService 体内两格缩进的 `function x(` / `async function x(` / `const x=(`/`const x = (` 箭头。 */
const innerFunctions = (s: string) => (s.match(/^  (?:async )?function \w+\(|^  const \w+ ?= ?(?:async ?)?\(/gm) ?? []).length

describe('core/workbench/service.ts 只许变小', () => {
  it(`行数 ≤ ${MAX_LINES}(新域进 src/core/workbench/service/<domain>.ts)`, () => {
    expect(lineCount(src)).toBeLessThanOrEqual(MAX_LINES)
  })
  it(`makeWorkbenchService 内函数 ≤ ${MAX_INNER_FUNCTIONS}`, () => {
    expect(innerFunctions(src)).toBeLessThanOrEqual(MAX_INNER_FUNCTIONS)
  })
  it('wechat-control.ts 不 import ./service(那是 type-only 环,depcruise 一样算)', () => {
    const control = readFileSync(join(WB, 'wechat-control.ts'), 'utf8')
    expect(control).not.toMatch(/from '\.\/service'/)
  })
  it('service/*.ts 不 import ../service(域模块只认 ctx)', () => {
    const dir = join(WB, 'service')
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const body = readFileSync(join(dir, f), 'utf8')
      expect(body, f).not.toMatch(/from '\.\.\/service'/)
    }
  })
})
```

- [ ] **Step 2: 跑守卫,确认红在「wechat-control」那条**

Run: `bun --bun vitest run scripts/workbench-service-ratchet.guard.test.ts`
Expected: 1 failed(`wechat-control.ts 不 import ./service`),其余 3 通过。若「内函数 ≤ 130」也红,把 `MAX_INNER_FUNCTIONS` 改成失败信息里的实际值(它只是现状,不是目标)。

- [ ] **Step 3: 新建 `src/core/workbench/wechat-types.ts`**(三个定义从 `service.ts:141,142,154` 逐字剪过来,含 `TaskWaitingFor` 上面那整段注释):

```ts
/**
 * 微信侧和等待行共用的三个类型,从 service.ts 挪出来断环(spec 2026-09-27-workbench-service-split §2):
 * wechat-control.ts 只需要这三个类型,不该反向 import 整个 service。
 */
import type { WaitingFor } from './scheduler'

export interface CreateWechatTask {ownerChatId:string;accountId:string;requestId:string;commandHash:string;projectId:string;providerId?:string;text:string;originMessageId?:string}
export interface SendWechatArtifact {ownerChatId:string;accountId:string;requestId:string;commandHash:string;taskId:string;artifactId:string}
/** 等待行给主人看的那份:除了「挡路的是谁、为什么」,还要说清「挡路的那位是不是已经答复、
 *  是不是正数着秒自己让开」——不然「答复完了」和「文件夹空了」这两件事在等待行里还是分不开
 *  (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md，任务 2 的由来)。
 *  `holderWriting=false` 且 `closeInMs` 不是 null 时,才是「快让开了,可以现在就收工」那句话
 *  该出现的时候;`writer_not_closed` 那种 holder 永远不安静,这两个字段用不上也盖不掉老文案。 */
export interface TaskWaitingFor extends WaitingFor { holderWriting: boolean; closeInMs: number | null }
```

- [ ] **Step 4: `service.ts` 改成 re-export**

删掉 141、142 两行和 154 那行(连同它上面的注释块,已搬走),在原 139 行前加:

```ts
export type { CreateWechatTask, SendWechatArtifact, TaskWaitingFor } from './wechat-types'
import type { CreateWechatTask, SendWechatArtifact, TaskWaitingFor } from './wechat-types'
```

(`service.ts` 内部自己也用这三个名字,所以既 re-export 又 import。)`WaitingFor` 在 `service.ts:28` 的 import 若因此只剩 `findPathBlocker, type PathReservation` 在用,把 `type WaitingFor` 从那行删掉(`tsc` 不报未用 import,但 `verbatimModuleSyntax` 下留着也无害;以 typecheck 为准)。

- [ ] **Step 5: `wechat-control.ts:6` 改路径**

```ts
import type {CreateWechatTask,SendWechatArtifact,TaskWaitingFor} from './wechat-types'
```

- [ ] **Step 6: depcruise 加两条规则** —— 在 `.dependency-cruiser.cjs` 的 `forbidden` 数组里、`no-circular` 那条之后插入:

```js
    {
      name: 'workbench-service-no-circular',
      severity: 'error',
      comment: '2026-09-28 workbench service 拆分:service.ts 与 service/<domain>.ts 之间不许有环(type-only 也算);域只认 ctx,动作走 ctx.actions 晚绑定。store 层那 4 个环另立项,这里不管。',
      from: { path: '^src/core/workbench/service(/|\\.ts$)' },
      to: { circular: true, viaOnly: { path: '^src/core/workbench/(service(/|\\.ts$)|wechat-control\\.ts$)' } },
    },
    {
      name: 'wechat-control-must-not-link-service',
      severity: 'error',
      comment: '2026-09-28:wechat-control.ts 需要的三个类型在 wechat-types.ts;回头 import ./service 就是环。',
      from: { path: '^src/core/workbench/wechat-control\\.ts$' },
      to: { path: '^src/core/workbench/service\\.ts$' },
    },
```

`viaOnly` 把这条环规则限定在 service 家族内部,不会因为 `service.ts → store.ts → …` 那些 store 层的老环误报。

- [ ] **Step 7: 验证**

Run: `bun --bun vitest run scripts/workbench-service-ratchet.guard.test.ts && bun run typecheck && bun run depcheck 2>&1 | tail -3`
Expected: 守卫 4 通过;typecheck 0 错;depcheck `0 errors, 21 warnings`(比基线 22 少的那一条正是 wechat-control ↔ service)。若 depcheck 报 `workbench-service-no-circular` error,说明 `viaOnly` 写法在当前 dependency-cruiser 版本不生效 —— 改成只用 `from: { path: '^src/core/workbench/service/' }`(spec §5 原文的范围)并把 `service.ts` 自身留给 `wechat-control-must-not-link-service` 那条守。

Run: `bun --bun vitest run src/core/workbench/service src/core/workbench/wechat-control`
Expected: 全部通过(仅 import 路径变化)。

- [ ] **Step 8: Commit**

```bash
git add src/core/workbench/wechat-types.ts src/core/workbench/service.ts src/core/workbench/wechat-control.ts .dependency-cruiser.cjs scripts/workbench-service-ratchet.guard.test.ts
git commit -m "workbench service 拆分 1/n:三个微信类型挪到 wechat-types.ts,断 wechat-control↔service 环;棘轮守卫 + depcruise 规则(行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `service/types.ts` + `service/state.ts`(状态集中,引用不变)

**Files:**
- Create: `src/core/workbench/service/types.ts`
- Create: `src/core/workbench/service/state.ts`
- Create: `src/core/workbench/service/state.test.ts`
- Modify: `src/core/workbench/service.ts:81-140`(删 `Active`/`AcceptedContinuation`)、`:139-156`(删五个公共类型,改 re-export)、`:280-305`(七容器解构 + 六 `let` 改 `state.x`)

**Interfaces:**
- Produces:
  - `service/types.ts`:`InputMaterials`、`CreateTask`、`WorkbenchPhase`、`WorkbenchTaskView`、`EntryResult`(定义逐字不变)。
  - `service/state.ts`:`AcceptedContinuation`、`Active`(逐字不变,加 `export`)、
    ```ts
    export interface WorkbenchRuntimeState {
      runsByTask: Map<string, Active>
      reservations: Map<string, Active>
      queue: Active[]
      runningText: Map<string, string>
      collections: Set<Promise<void>>
      nativeDecisions: Map<string, AcceptedNativeResume>
      handoffDecisions: Map<string, {preview:HandoffPreview;sourceVersion:string;targetVersion:string|null;directoryIdentity:string;expiresAt:number}>
      order: number
      stopping: boolean
      shutdownComplete: boolean
      shutdownPromise: Promise<void> | undefined
      noticeWake: (context?:{ownerChatId:string;accountId:string}) => Promise<void>
      artifactDelivery: ((id:string)=>Promise<ArtifactDeliveryReceipt>) | undefined
    }
    export function makeRuntimeState(): WorkbenchRuntimeState
    ```
- Consumes: Task 1 的 `wechat-types.ts`(`TaskWaitingFor`)。

- [ ] **Step 1: 写 `service/state.test.ts`(红:模块不存在)**

```ts
import { describe, it, expect } from 'vitest'
import { makeRuntimeState } from './state'

describe('makeRuntimeState', () => {
  it('每次一份新的、空的运行时状态,初值与 service.ts 原来的 let/const 一致', () => {
    const a = makeRuntimeState(), b = makeRuntimeState()
    expect(a.runsByTask.size).toBe(0); expect(a.reservations.size).toBe(0); expect(a.queue).toEqual([])
    expect(a.runningText.size).toBe(0); expect(a.collections.size).toBe(0)
    expect(a.nativeDecisions.size).toBe(0); expect(a.handoffDecisions.size).toBe(0)
    expect(a.order).toBe(0); expect(a.stopping).toBe(false); expect(a.shutdownComplete).toBe(false)
    expect(a.shutdownPromise).toBeUndefined(); expect(a.artifactDelivery).toBeUndefined()
    expect(a.runsByTask).not.toBe(b.runsByTask)
  })
  it('缺省 noticeWake 是个不抛的空实现(setNotificationWake 之前的行为)', async () => {
    await expect(makeRuntimeState().noticeWake()).resolves.toBeUndefined()
  })
  it('容器是同一引用:解构出来的 Map 和 state 上的是同一个(service.ts 解构、域模块走 ctx.state)', () => {
    const state = makeRuntimeState()
    const { runsByTask } = state
    runsByTask.set('t', {} as never)
    expect(state.runsByTask.get('t')).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/core/workbench/service/state.test.ts`
Expected: FAIL,`Cannot find module './state'`。

- [ ] **Step 3: 新建 `service/types.ts`** —— 从 `service.ts:139-156` 逐字剪(`WorkbenchPhase` 上面那段注释一起):

```ts
/** service.ts 对外的公共类型。放在 service/ 里是为了让域模块能引用而不 import ../service(那会成环)。 */
import type { AgentRuntimeSnapshot } from '../../agent-provider'
import type { Task } from '../store'
import type { EntryReceipt } from '../task-entry'
import type { TaskWaitingFor } from '../wechat-types'

export interface InputMaterials {attachmentIds?:string[];draftId?:string;execution?:unknown}
export interface CreateTask extends InputMaterials { title?: string; path: string; providerId: string; text: string }
/**
 * 主人眼里的进度,两家执行者一致。持久化的 status 记的是这条 run 的生命周期
 * (Claude 会话保留时它永远是 running,Codex 自行收尾后是 completed),而主人要问的
 * 是「本轮做完没有、还能不能接着说」—— 那是 replied,与进程留不留无关。
 */
export type WorkbenchPhase='queued'|'working'|'replied'|'failed'|'cancelled'|'interrupted'
export interface WorkbenchTaskView extends Task { phase:WorkbenchPhase; importedOnly?:boolean; canArchive:boolean; waitingFor: TaskWaitingFor | null; pendingPermissionCount?: number; pendingQuestionCount?:number; runtime?:AgentRuntimeSnapshot }
export type EntryResult = {receipt: EntryReceipt; task: WorkbenchTaskView}
```

- [ ] **Step 4: 新建 `service/state.ts`** —— `Active`(`service.ts:81-137`,含每个字段的注释)和 `AcceptedContinuation`(`:138`)逐字剪过来加 `export`;`Active` 用到的类型按 `service.ts` 头部的 import 改成 `../` 路径:

```ts
/**
 * makeWorkbenchService 的共享可变状态(spec 2026-09-27-workbench-service-split §2)。
 * 这里只是把原来散在闭包里的 7 个容器 + 6 个 let 集中成一个对象,语义一个字不改:
 * service.ts 对容器解构(引用不变),对 6 个标量走 state.x;域模块经 ctx.state 看同一份。
 */
import type { AgentExecutionChoice, AgentSession } from '../../agent-provider'
import type { Attachment } from '../attachments'
import type { ArtifactSelection } from '../handoff'
import type { HandoffPreview } from '../handoff'
import type { AcceptedNativeResume } from '../native-adoption'
import type { GitBaseline } from '../git-review'
import type { RestartPreview } from '../continuation'
import type { PathReservation } from '../scheduler'
import type { RunPermissions } from '../permissions'
import type { RunUserInput } from '../user-input'
import type { LiveInput } from '../live-inputs'
import type { StoredTask } from '../store'
import type { ArtifactDeliveryReceipt } from '../artifact-deliveries'

export type AcceptedContinuation = { mode: 'new' } | { mode: 'resume'; sessionId: string } | { mode: 'restart'; preview: RestartPreview }

export interface Active extends PathReservation {
  // ……service.ts:82-137 逐字,一个字段、一条注释都不少……
}

export interface WorkbenchRuntimeState {
  runsByTask: Map<string, Active>
  /** 文件夹的占用:派发时写入,会话关闭(结算 / 隔离)时删除 —— 中间从不释放。 */
  reservations: Map<string, Active>
  queue: Active[]
  runningText: Map<string, string>
  collections: Set<Promise<void>>
  nativeDecisions: Map<string, AcceptedNativeResume>
  handoffDecisions: Map<string, {preview:HandoffPreview;sourceVersion:string;targetVersion:string|null;directoryIdentity:string;expiresAt:number}>
  order: number
  stopping: boolean
  shutdownComplete: boolean
  shutdownPromise: Promise<void> | undefined
  noticeWake: (context?:{ownerChatId:string;accountId:string}) => Promise<void>
  artifactDelivery: ((id:string)=>Promise<ArtifactDeliveryReceipt>) | undefined
}

export function makeRuntimeState(): WorkbenchRuntimeState {
  return {
    runsByTask: new Map(), reservations: new Map(), queue: [], runningText: new Map(), collections: new Set(),
    nativeDecisions: new Map(), handoffDecisions: new Map(),
    order: 0, stopping: false, shutdownComplete: false, shutdownPromise: undefined,
    noticeWake: async () => {}, artifactDelivery: undefined,
  }
}
```

- [ ] **Step 5: `service.ts` 接上**

1. 删 `:81-138`(`Active`、`AcceptedContinuation`)和 `:139-156` 里剩下的五个公共类型;加:
   ```ts
   export type { InputMaterials, CreateTask, WorkbenchPhase, WorkbenchTaskView, EntryResult } from './service/types'
   import type { InputMaterials, CreateTask, WorkbenchPhase, WorkbenchTaskView, EntryResult } from './service/types'
   import { makeRuntimeState, type Active, type AcceptedContinuation } from './service/state'
   ```
2. `:280-305` 那段改成:
   ```ts
   const state=makeRuntimeState()
   const {runsByTask,reservations,queue,runningText,collections,nativeDecisions,handoffDecisions}=state
   ```
   `quota` / `fallbackExecutor`(`:284-294`)与 `wakeNotices`(`:306`)留在原地不动;删掉 `let order=0` … `let artifactDelivery` 六行(`:300-305`)和 `reservations` 上那条注释(已搬进 state.ts)。
3. 跑 `bun run typecheck`,把它报的每一处 `Cannot find name 'order'|'stopping'|'shutdownComplete'|'shutdownPromise'|'noticeWake'|'artifactDelivery'` 改成 `state.<name>`。预期处数(6c455751):`order` 1(`order:++order` 里右边那个 → `order:++state.order`)、`stopping` 8、`shutdownComplete` 7、`shutdownPromise` 3、`noticeWake` 2、`artifactDelivery` 3。**不要用 sed 全局替换** —— `item.order` / `running.order` / `order:` 这些是 `Active` 的字段,不是这个 `let`。
4. `wakeNotices` 里的 `if(!stopping)void noticeWake(context)` 两个都要改。

- [ ] **Step 6: 验证**

Run: `bun run typecheck && bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts`
Expected: typecheck 0 错;service* 全部通过;守卫 4 通过(行数变小了,棘轮不动)。

Run: `bun run depcheck 2>&1 | tail -2`
Expected: `0 errors, 21 warnings`(`service/state.ts` 与 `service/types.ts` 都不 import `../service`,没有新环)。

- [ ] **Step 7: Commit**

```bash
git add src/core/workbench/service/types.ts src/core/workbench/service/state.ts src/core/workbench/service/state.test.ts src/core/workbench/service.ts
git commit -m "workbench service 拆分 2/n:公共类型进 service/types.ts,Active 与 11 项共享状态进 service/state.ts(解构接回,行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `service/ctx.ts` + review 域

**Files:**
- Create: `src/core/workbench/service/ctx.ts`
- Create: `src/core/workbench/service/review.ts`
- Create: `src/core/workbench/service/review.test.ts`
- Modify: `src/core/workbench/service.ts`(删 `:1266-1291` 四个帮手与 `:1853-1921` 三个方法;建 ctx;public 对象引用域;`service` 建好后 `actions.set`)

**Interfaces:**
- Consumes:`WorkbenchRuntimeState`/`Active`(Task 2)、`WorkbenchTaskView`/`InputMaterials`(Task 2)、`Ref`(`src/lib/lifecycle.ts`:`new Ref<T>(name)`, `.set(v)` 只许一次, `.deref(reason)` 未 set 即抛)。
- Produces:
  ```ts
  // service/ctx.ts
  export interface ServiceHub { touched(id:string,seq?:number):void; bumped(id:string):void }
  /** service.ts / 别的域提供、域模块在调用时才取的动作;后续 PR 往里加字段(execute/pump/cancelRun/…)。 */
  export interface ServiceActions {
    submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
    continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials,attachmentPolicy?:'owner'):WorkbenchTaskView
    isReplied(running:Active):boolean
  }
  export interface ServiceCtx {
    store: WorkbenchStore
    stateDir: string
    state: WorkbenchRuntimeState
    hub: ServiceHub
    log?: (tag:string,line:string)=>void
    now: () => number
    actions: Ref<ServiceActions>
  }
  // service/review.ts
  export interface ReviewDomain {
    reviewList(id:string):ReviewTurn[]
    markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark
    returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput>
  }
  export function makeReviewDomain(ctx:ServiceCtx):ReviewDomain
  ```

- [ ] **Step 1: 新建 `service/ctx.ts`**(只有类型,无运行时代码):

```ts
/**
 * 域模块看到的 service 上下文(spec 2026-09-27-workbench-service-split §2)。
 * 显式、只读、不含 service 对象本身:域需要「别的域 / service 的动作」一律 ctx.actions.deref() 在**调用时**取
 * —— Ref 由 service.ts 在 public 对象建好后 set 一次;工厂体里不许 deref(那时还没 set)。
 */
import type { Ref } from '../../../lib/lifecycle'
import type { WorkbenchStore } from '../store'
import type { LiveInput } from '../live-inputs'
import type { Active, WorkbenchRuntimeState } from './state'
import type { InputMaterials, WorkbenchTaskView } from './types'

export interface ServiceHub {
  /** store 的写方法把 seq 落库,但不知道 hub —— 这里把持久化 seq 送进去唤醒长轮询。 */
  touched(id:string,seq?:number):void
  /** 非 store 状态变化:先落库拿新 seq 再唤醒。 */
  bumped(id:string):void
}
export interface ServiceActions {
  submitInput(id:string,input:{runId:string;requestId:string;text:string}&InputMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
  continueTask(id:string,text:string,options?:{restartToken?:string;inputRequestId?:string}&InputMaterials,attachmentPolicy?:'owner'):WorkbenchTaskView
  isReplied(running:Active):boolean
}
export interface ServiceCtx {
  store: WorkbenchStore
  stateDir: string
  state: WorkbenchRuntimeState
  hub: ServiceHub
  log?: (tag:string,line:string)=>void
  now: () => number
  actions: Ref<ServiceActions>
}
```

- [ ] **Step 2: 写 `service/review.test.ts`(红:模块不存在)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { saveArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, serializeGitReview, type GitReview, type ReviewFile } from '../git-review'
import { derivedReturnRequestId } from '../review'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeReviewDomain } from './review'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: `@@ -1 +1 @@\n-老 ${path}\n+新 ${path}`, ...over })
const review = (files: ReviewFile[], over: Partial<GitReview> = {}): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: [], notes: [], files, ...over })

/** 最小 ctx:真 store(标记与成果要落库)、空运行时状态、假 hub、假 actions。不建 service。 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-review-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const task = store.create({ title: '做点事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn() }
  const actions = new Ref<ServiceActions>('test-actions')
  const ctx: ServiceCtx = { store, stateDir, state, hub, now: Date.now, actions }
  const domain = makeReviewDomain(ctx)
  const plant = (name: string, bytes: Buffer) => { saveArtifactSnapshot(store, task.id, { name, mime: GIT_REVIEW_MIME, bytes }, stateDir); return store.artifacts(task.id).find(a => a.name === name)!.id }
  const good = plant('代码变更-run1.json', serializeGitReview(review([file('src/a.ts'), file('src/big.bin', { kind: 'not_reviewed', reason: '二进制文件未展开', beforeSha256: undefined, afterSha256: undefined, diff: undefined })])))
  const broken = plant('代码变更-坏.json', Buffer.from('{这不是 JSON'))
  const view = { id: task.id } as never
  const stub = (over: Partial<ServiceActions> = {}) => actions.set({ submitInput: vi.fn(async () => ({ id: 'li' } as never)), continueTask: vi.fn(() => view), isReplied: () => false, ...over })
  return { store, task, state, hub, actions, domain, good, broken, stub }
}

describe('makeReviewDomain', () => {
  it('构造时不 deref actions(那时 service 还没建好)', () => {
    const { actions } = setup()
    expect(actions.current).toBeNull()
  })

  it('reviewList:好快照列文件,坏快照 unavailable', () => {
    const { domain, task, good, broken } = setup()
    const list = domain.reviewList(task.id)
    expect(list.map(t => t.artifactId)).toEqual([broken, good])
    expect(list[0]).toMatchObject({ status: 'unavailable', files: [] })
    expect(list[1]!.files.map(f => f.kind)).toEqual(['modified', 'not_reviewed'])
  })

  it('markReviewFile:落标记并 touched;not_reviewed 拒绝;超长意见拒绝', () => {
    const { domain, task, good, hub, store } = setup()
    const mark = domain.markReviewFile(task.id, { artifactId: good, path: 'src/a.ts', mark: 'accepted' })
    expect(mark).toMatchObject({ taskId: task.id, path: 'src/a.ts', mark: 'accepted', comment: '' })
    expect(hub.touched).toHaveBeenCalledWith(task.id)
    expect(store.reviewMarks.list(task.id)).toHaveLength(1)
    expect(() => domain.markReviewFile(task.id, { artifactId: good, path: 'src/big.bin', mark: 'accepted' })).toThrow('review_file_unmarkable')
    expect(() => domain.markReviewFile(task.id, { artifactId: good, path: 'src/a.ts', mark: 'returned', comment: 'x'.repeat(2001) })).toThrow('invalid_review_reference')
  })

  it('returnReviewFiles 没有在跑的 run ⇒ 走 continueTask,标记在它成功之后才落', () => {
    const { domain, task, good, store, actions, stub } = setup()
    stub()
    const result = domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改', inputRequestId: '11111111-1111-4111-8111-111111111111' })
    expect(result).toEqual({ id: task.id })
    const continueTask = actions.deref().continueTask as ReturnType<typeof vi.fn>
    expect(continueTask).toHaveBeenCalledTimes(1)
    const [id, text, options] = continueTask.mock.calls[0]!
    expect(id).toBe(task.id); expect(text).toContain('src/a.ts'); expect(text).toContain('再改改')
    expect(options).toMatchObject({ inputRequestId: '11111111-1111-4111-8111-111111111111' })
    expect(store.reviewMarks.list(task.id)).toMatchObject([{ path: 'src/a.ts', mark: 'returned', comment: '再改改' }])
  })

  it('continueTask 抛错 ⇒ 不落标记(标记只在续接成功之后)', () => {
    const { domain, task, good, store, stub } = setup()
    stub({ continueTask: vi.fn(() => { throw new Error('workbench_busy') }) })
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })).toThrow('workbench_busy')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })

  it('run 还在写 ⇒ workbench_busy,不投递不落标记', () => {
    const { domain, task, good, store, state, stub } = setup()
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    stub({ isReplied: () => false })
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })).toThrow('workbench_busy')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })

  it('run 已答复 ⇒ 走 submitInput(runId=identity,requestId 从打回本身派生),回执之后才落标记', async () => {
    const { domain, task, good, store, state, actions, stub } = setup()
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    stub({ isReplied: () => true })
    const pending = domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })
    expect(pending).toBeInstanceOf(Promise)
    expect(store.reviewMarks.list(task.id)).toEqual([])
    await pending
    const submitInput = actions.deref().submitInput as ReturnType<typeof vi.fn>
    const sha = store.artifact(task.id, good).sha256
    expect(submitInput).toHaveBeenCalledWith(task.id, { runId: 'run-1', requestId: derivedReturnRequestId(sha, ['src/a.ts'], '再改改', 'run-1'), text: expect.stringContaining('src/a.ts') })
    expect(store.reviewMarks.list(task.id)).toMatchObject([{ path: 'src/a.ts', mark: 'returned' }])
  })

  it('路径列表畸形 / 意见为空 ⇒ invalid_review_reference,且不碰 actions', () => {
    const { domain, task, good, store } = setup()
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: [], comment: '再改改' })).toThrow('invalid_review_reference')
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '   ' })).toThrow('invalid_review_reference')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })
})
```

`store.create` 的参数形状照 `service.ts` 里 `createTask` 那句 `store.create({title,path,providerId,ownerChatId})`;若 `store.create` 还要别的必填字段,以 `store.ts` 的类型为准补上,不要改 store。

- [ ] **Step 3: 跑,确认红**

Run: `bun --bun vitest run src/core/workbench/service/review.test.ts`
Expected: FAIL,`Cannot find module './review'`。

- [ ] **Step 4: 新建 `service/review.ts`** —— 四个帮手(`service.ts:1266-1291`)与三个方法(`:1853-1921`)**逐字**搬,注释全搬;只做这几处机械替换:`opts.stateDir`→`ctx.stateDir`、`touched(`→`ctx.hub.touched(`、`runsByTask`→`ctx.state.runsByTask`、`isReplied(`→`ctx.actions.deref('review').isReplied(`、`service.submitInput(`→`ctx.actions.deref('review').submitInput(`、`service.continueTask(`→`ctx.actions.deref('review').continueTask(`:

```ts
/**
 * review 域:逐文件标记(接受 / 打回)与「打回 = 续接要求 + 标记」。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 1 项);只认 ctx,
 * 续接与投递走 ctx.actions 晚绑定。
 */
import { randomUUID } from 'node:crypto'
import { readArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, type GitReview, type ReviewFile } from '../git-review'
import { normalizeInputRequestId, type LiveInput } from '../live-inputs'
import { composeReturnText, derivedReturnRequestId, parseGitReviewSnapshot, type ReviewTurn } from '../review'
import type { ReviewMark } from '../review-marks'
import type { ServiceCtx } from './ctx'
import type { WorkbenchTaskView } from './types'

export interface ReviewDomain {
  reviewList(id:string):ReviewTurn[]
  markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):ReviewMark
  returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string}):WorkbenchTaskView|Promise<LiveInput>
}

export function makeReviewDomain(ctx:ServiceCtx):ReviewDomain {
  const { store } = ctx
  /** 一件成果 ⇒ 它装的变更快照;不是 review mime、读不出、解析不出都是 null(坏快照不抛,由调用方标 unavailable)。 */
  function readReviewSnapshot(artifact:{mime:string;storagePath:string;sha256:string}):GitReview|null {
    if(artifact.mime!==GIT_REVIEW_MIME)return null
    try{return parseGitReviewSnapshot(readArtifactSnapshot(artifact.storagePath,ctx.stateDir,artifact.sha256))}catch{return null}
  }
  /** 标记的落点:成果必须属于该任务(否则 store.artifact 抛 not_found)且真是一份读得出的快照。 */
  function reviewTarget(id:string,artifactId:string) {
    const artifact=store.artifact(id,artifactId)
    const review=readReviewSnapshot(artifact)
    if(!review)throw new Error('invalid_review_reference')
    return {artifact,review}
  }
  function reviewComment(value:unknown,required:boolean):string {
    if(value===undefined&&!required)return ''
    if(typeof value!=='string'||value.length>2000)throw new Error('invalid_review_reference')
    const comment=value.trim()
    if(required&&!comment)throw new Error('invalid_review_reference')
    return comment
  }
  /** 门控:路径要在这份快照里,且不是「没展开」的那种 —— 没看过的文件不能说接受或打回。 */
  function markableFile(review:GitReview,path:string):ReviewFile {
    const file=review.files.find(candidate=>candidate.path===path)
    if(!file)throw new Error('invalid_review_reference')
    if(file.kind==='not_reviewed')throw new Error('review_file_unmarkable')
    return file
  }

  return {
    reviewList(id:string):ReviewTurn[] {
      // ……service.ts:1853-1867 逐字……
    },
    markReviewFile(id,input):ReviewMark {
      // ……service.ts:1868-1876 逐字;touched(id) → ctx.hub.touched(id)……
    },
    /**
     * ……service.ts:1877-1889 那整段注释逐字……
     */
    returnReviewFiles(id,input) {
      // ……service.ts:1890-1921 逐字;runsByTask → ctx.state.runsByTask;
      //   isReplied(running) → ctx.actions.deref('review').isReplied(running);
      //   service.submitInput(...) → ctx.actions.deref('review').submitInput(...);
      //   service.continueTask(...) → ctx.actions.deref('review').continueTask(...)……
    },
  }
}
```

(上面「……逐字……」处是给你省纸,实施时必须把原文整段贴进去;贴完 `git diff` 里 `service.ts` 删的行和 `review.ts` 加的行除了上面列的替换外应当逐字对得上。)

- [ ] **Step 5: `service.ts` 接上**

1. 头部加:
   ```ts
   import { Ref } from '../../lib/lifecycle'
   import { makeReviewDomain } from './service/review'
   import type { ServiceActions, ServiceCtx } from './service/ctx'
   ```
2. `bumped` 定义之后、`state` 建好之后(Task 2 的 `const state=makeRuntimeState()` 下面)加:
   ```ts
   const actions=new Ref<ServiceActions>('workbench-actions')
   const ctx:ServiceCtx={store,stateDir:opts.stateDir,state,hub:{touched,bumped},...(opts.log?{log:opts.log}:{}),now:Date.now,actions}
   const review=makeReviewDomain(ctx)
   ```
   (`log` 用条件展开是因为 `exactOptionalPropertyTypes` 可能开着;若 typecheck 不抱怨,直接 `log:opts.log` 也行。)
3. 删 `:1266-1291` 四个帮手;public 对象里三个方法整段删掉,换成:
   ```ts
    reviewList:review.reviewList,
    markReviewFile:review.markReviewFile,
    returnReviewFiles:review.returnReviewFiles,
   ```
4. `const wechatControl=…` 之前加一行:
   ```ts
   actions.set({submitInput:(id,input,policy)=>service.submitInput(id,input,policy),continueTask:(id,text,options,policy)=>service.continueTask(id,text,options,policy),isReplied})
   ```
   用箭头包一层而不是直接传 `service.submitInput`:原方法体里用了 `service.xxx` 自引用,不绑 this 也能跑,但包一层能让 `ServiceActions` 的签名与 `service` 的实际签名在 tsc 里对上(少参数就红)。
5. 删掉 `service.ts` 里因此不再使用的 import:`composeReturnText`、`derivedReturnRequestId`、`parseGitReviewSnapshot`、`type ReviewTurn`(`:17`)、`type ReviewMark`(`:18`)、`type GitReview` / `type ReviewFile`(`:16`,若无其它引用)、`readArtifactSnapshot`(`:15`,若无其它引用)。`randomUUID`、`normalizeInputRequestId`、`GIT_REVIEW_MIME` 别处还在用,留着。以 `grep -c` 为准,别猜。

- [ ] **Step 6: 验证**

Run: `bun --bun vitest run src/core/workbench/service/review.test.ts`
Expected: 8 通过。

Run: `bun run typecheck && bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts`
Expected: typecheck 0 错;`service-review.test.ts`、`service-review-boundary.test.ts` 与其余 service* 全绿(一行没改);守卫 4 通过。

Run: `bun run depcheck 2>&1 | tail -2`
Expected: `0 errors, 21 warnings`。

- [ ] **Step 7: Commit**

```bash
git add src/core/workbench/service/ctx.ts src/core/workbench/service/review.ts src/core/workbench/service/review.test.ts src/core/workbench/service.ts
git commit -m "workbench service 拆分 3/n:显式 ServiceCtx + review 域搬进 service/review.ts,续接投递走 ctx.actions 晚绑定(行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 棘轮下调 + 全量闸门 + spec 状态行

**Files:**
- Modify: `scripts/workbench-service-ratchet.guard.test.ts`(`MAX_LINES`、`MAX_INNER_FUNCTIONS`)
- Modify: `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(第 3 行「状态」)

- [ ] **Step 1: 量实际值**

Run: `wc -l src/core/workbench/service.ts && grep -cE '^  (async )?function \w+\(|^  const \w+ ?= ?(async ?)?\(' src/core/workbench/service.ts`
Expected: 行数明显低于 1965(review 域 + 类型 + Active 搬走,约 −150);内函数数比 Task 1 记的少 4。

- [ ] **Step 2: 把守卫常量改成量到的值(不留余量)**,并把注释里「Task 4 会把这两个数调成…」那句改成「搬走一个域就把这两个数往下调」。

- [ ] **Step 3: 跑全量闸门**

Run:
```bash
bun run test 2>&1 | tail -4
npm run test:node 2>&1 | tail -4
bun run typecheck
bun run depcheck 2>&1 | tail -2
```
Expected:bun 全绿(基线 693 files / 9224 tests,现在多 2 个文件、多约 11 条);node 全绿;typecheck 0 错;depcheck `0 errors, 21 warnings`。node 若只红 `service-one-session.test.ts` 且是满载竞态(记忆里登记过),单跑一次确认绿再算过。

- [ ] **Step 4: spec 状态行** —— `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md` 第 3 行「状态:设计稿,主人已在对话中批准;代码未动;……」改成:

```
状态:实施中。基线改为 dev `6c455751`(Codex #129 已合);§1 按新行号重画在 `docs/superpowers/plans/2026-09-28-workbench-service-split-pr1.md`;PR 1(地基 + review 域 + 断环)见该计划。同批:…(后文不变)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/workbench-service-ratchet.guard.test.ts docs/superpowers/specs/2026-09-27-workbench-service-split-design.md docs/superpowers/plans/2026-09-28-workbench-service-split-pr1.md
git commit -m "workbench service 拆分 4/n:棘轮下调到搬完 review 域的实际值;spec 状态改实施中、基线 6c455751

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 推分支、开 PR、CI、真机自检

**Files:** 无代码改动。

- [ ] **Step 1: 推分支**

Run: `git push -u origin sweep/workbench-service-split`

- [ ] **Step 2: 开 PR(打 dev)**

```bash
gh pr create --base dev --title "workbench service 拆分 PR 1:地基(types/state/ctx)+ review 域 + 断 wechat-control 环(行为不变)" --body "$(cat <<'EOF'
## 改了啥
spec `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md` §3 第 1 项,计划 `docs/superpowers/plans/2026-09-28-workbench-service-split-pr1.md`。
- `wechat-types.ts`:三个微信/等待行类型挪出 service.ts,`wechat-control.ts` 不再 import ./service ⇒ depcruise 环 22→21 warn;新增 2 条 error 规则(service 家族内不许有环、wechat-control 不许链 service)。
- `service/types.ts` + `service/state.ts`:公共类型、`Active`、11 项共享状态集中;service.ts 解构接回。
- `service/ctx.ts` + `service/review.ts`:显式 ServiceCtx;review 域逐字搬出,续接/投递走 `ctx.actions`(Ref 晚绑定)。
- `scripts/workbench-service-ratchet.guard.test.ts`:service.ts 行数 / 内函数只降不升 + 两条环守卫。
- **行为不变**:20 份 `service*.test.ts` 一行未改。

## 怎么验的
- [ ] bun 全量 / node 全量 / typecheck / depcheck(0 errors, 21 warnings)
- [ ] CI 三平台 + node
- [ ] 合 dev 后 `self deploy` + `selftest workbench --executor cursor --image --resume`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 看 CI**

Run: `wechat-cc ci triage --sha $(git rev-parse HEAD) --wait --rerun`(`wechat-cc` = 线上 .app 里的 `wechat-cc-cli`)
Expected: exit 0。3(登记 flake)会自动重跑一次;1 才是真红,回到对应任务修。

- [ ] **Step 4: 合并后真机**(合 dev 由主人或按既定流程 squash)

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy --binary apps/desktop/src-tauri/binaries/wechat-cc-cli-aarch64-apple-darwin
wechat-cc selftest workbench --executor cursor --image --resume
```
Expected: deploy 六步 ✓;selftest `PASS`(review 域没有 selftest 项,但 `resume_replied` 走的 `continue`/`input` 正是 `ctx.actions` 那两条路)。

---

## Self-Review

- **Spec 覆盖**:§2 的 `ctx.ts` / `state.ts` / `review.ts` / `wechat-types.ts` 四个文件 ✓(`types.ts` 是 spec 没列但断环必需的,§2 「域内不互相 import」推出来的);§3 第 1 项 ✓;§5 守卫 + depcruise 规则 ✓;§5 「每个域一份 `service/<domain>.test.ts`」✓;§5 真机 ✓(Task 5);§6 「按合入后的行号重画 §1」✓(本文件 §1 重画);§4 不做清单全部遵守。
- **占位符**:Task 3 Step 4 的「……逐字……」不是占位,是明确指向 `service.ts` 现有行段的搬家指令,并要求 diff 对得上。
- **类型一致**:`ServiceActions.submitInput/continueTask` 签名与 `service.ts:1474,1777` 的实际签名逐字一致;`ReviewDomain` 三个签名与原 public 方法一致;`WorkbenchRuntimeState` 字段名与原 `let/const` 名一致(解构才能不改引用)。
- **Review Focus** 五条各有归属:1→Task 3 测试「continueTask 抛错 ⇒ 不落标记」;2→Task 3 测试「构造时不 deref」+ ctx.ts 注释;3→Task 2 Step 5.3 以 tsc 为门;4→Task 1/2 typecheck;5→Task 2 `state.test.ts` 第三条 + Task 3 「run 还在写」用例。
