# CC 多项目任务并行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在 CC 同时管理不同文件夹的 Claude / Codex 任务，消息、停止、权限和成果归属各自任务；重叠文件夹按提交顺序等待。

**Architecture:** 后台拥有以任务和执行轮次标识的会话，页面只订阅、补充和操作指定任务。调度器将规范化后的相同或包含关系路径视为冲突，按冲突范围 FIFO，独立路径并行；执行程序确认退出并收集成果后才释放路径。界面保持现有两栏，仅增加真实等待原因与任务级操作隔离。

**Tech Stack:** TypeScript / Bun / SQLite / Vitest，原生 Claude Agent SDK 和 Codex app-server，现有桌面 JavaScript UI。

**Spec:** `docs/superpowers/specs/2026-09-12-cc-task-entry-scope.md` 第二段。基线 `ed4bc53c`，单任务闭环保持。

## Global Constraints

- 「日常管理 Claude / Codex 任务时，只打开 CC 就够。」本轮交付其第二段，不提前声明外部历史导入或跨执行者交接完成。
- 「不同项目的任务、草稿、文件、权限必须分别归属；不能把会话隔离误写成文件隔离。」
- 「普通文件夹也能用，不强制先创建 Git 仓库。」本轮冲突排队，不自动建工作副本。
- 「工作时保持专业、沉浸。」沿用收起全局导航的两栏，不加状态大盘、流程编辑器或配置表单。
- 不改冻结 CC 美术，不运行 `build-cc-asset-kit.mjs`，不写主工作树，不推送或合并。
- 保持原生权限策略：任务上下文与授权隔离不等于 OS 级文件读取沙箱；路径调度协调 CC 管理的任务，不管理用户在外部手动启动的程序。
- 服务重启不自动重放排队或运行中的请求；保留请求记录并标中断，提示检查原进程与输出后手动继续。

## API 合同

不增加端点或数据库表。现有 list 的每个 task 与 detail.task 可附加：

```ts
interface WaitingFor {
  taskId: string
  title: string
  reason: 'same_path' | 'nested_path' | 'writer_not_closed'
}
// waitingFor: WaitingFor | null
// pendingPermissionCount: number (list only, computed per task)
```

正在执行和无阻塞的任务 waitingFor 为 null。异常退出的阻塞优先显示 writer_not_closed，不能承诺自动完成。相同任务的再次 continue 保持 `workbench_busy` 409；不同任务接受为 queued。创建或继续返回仍为 202。已排队的用户请求只记录一次，取消不会派发，服务重启不会自动派发。

### Task 1: 后台执行与路径调度

**Files:**
- Modify: `src/core/workbench/service.ts`
- Create if useful: `src/core/workbench/scheduler.ts`
- Modify/Test: `src/core/workbench/service.test.ts`
- Create/Test: `src/core/workbench/scheduler.test.ts` if scheduler extracted
- Modify: `src/core/workbench/store.ts` only for additive runtime types or recovery wording; no migration required

**Interfaces:** Consumes existing provider registry, per-run permission broker, store, canonicalProject and artifact snapshots. Produces unchanged service endpoints with the API metadata above. Scheduler/path helpers stay internal.

- [x] Add failing integration tests with two deferred provider sessions: different folders both dispatch before either ends; each emits distinct text, session IDs and artifact bytes; continuing A resumes only A. Same task duplicate continue still fails before spawning.
- [x] Add failing conflict tests for equal paths, canonical symlink aliases, ancestor/descendant paths, and sibling names (`project` / `project-other`). A running child blocks a queued parent; a later overlapping child cannot overtake that parent, while an unrelated directory dispatches immediately.
- [x] Add failing lifecycle tests: queued cancel never spawns and permits next eligible task; cancel A rejects only A permissions and closes only A; B permission remains pending and rejects A's request ID; queue waits for native close and artifact capture; delayed spawn after cancellation is never dispatched; unresolved or rejected close quarantines only overlapping paths and advertises writer_not_closed; eventual confirmed close releases it. Shutdown cancels queued and running work, drains every run and prevents further starts; recovery never replays requests.
- [x] Run `bun --bun vitest run src/core/workbench/service.test.ts` and record the expected red cases before implementation.
- [x] Replace singleton active/global writer flag with per-run identity and path reservations. Reserve synchronously on acceptance and prevent duplicate same-task turns. Keep pending entries ordered by acceptance rather than updatedAt. Revalidate the canonical directory immediately before spawn; a moved/replaced queued directory fails without starting elsewhere.

```ts
// Structural algorithm; every accepted run has a unique identity.
// For each queued run in insertion order:
// 1. block on any conflicting active/unconfirmed reservation;
// 2. block on any earlier conflicting queued run (prevents overtaking);
// 3. otherwise reserve it synchronously and start in a microtask.
// Cancellation/late callbacks check run identity. A path is released only
// after its writer's close promise confirms exit and artifacts are captured.
```

- [x] Keep stop/timeout bounded. When startup or close remains unresolved, retain a path reservation after task interruption, reject all permissions, and revoke task credentials; clean late sessions without dispatch. Late callbacks after shutdown must not touch a closed database or start new work. Rejected close remains quarantined until explicit process inspection/restart; fulfilled late close can safely drain while the service is live.
- [x] Task shutdown takes a snapshot of all active runs, cancels queued entries before yielding, awaits bounded run completion, and never dispatches another queue entry while stopping. Keep per-run holdBusy/revoke balanced.
- [x] Run backend workbench tests, inspect actual failures rather than weakening assertions, and commit only backend changes.

### Task 2: 界面中的独立任务操作

**Files:**
- Modify: `apps/desktop/src/modules/workbench.js`
- Modify/Test: `apps/desktop/src/modules/workbench.test.ts`
- Modify if needed: existing workbench CSS only

**Interfaces:** Consumes WaitingFor metadata above and existing per-task pending permission list/count. Produces no new backend calls or navigation layout.

- [x] Add failing tests for overlapping POSTs on A/B, duplicate A suppression, stale list refresh success/error, draft retention on A/B completion order, genuine multiple permission badges, queued cancel IDs, and unrelated preview errors not disabling valid permissions.
- [x] Add queued rendering tests with escaped blocker title, separate normal/uncertain-exit text, and metadata-absent fallback. Ordinary text: `等待「标题」结束` plus same/nested folder explanation in selected task; uncertain: `等待执行程序退出确认` and explicit inspection guidance. Do not infer blocking from client paths, display invented ETA or progress.
- [x] Run `bun --bun vitest run apps/desktop/src/modules/workbench.test.ts` to confirm new tests fail on the old shared busy flag and refresh ordering.
- [x] Replace page busy boolean with mutation keys (`create`, `task:<id>`). Preserve current task identity captured before await, selected task draft scope, unchanged-submitted-text clearing, navigation generation, and focus/scroll restoration. Pending action on one task may not disable another task; duplicate/conflicting mutations within the same task remain suppressed.

```js
// A list refresh owns a generation just as detail reads already do.
const request = ++listRequest
try {
  const response = await api('/v1/workbench')
  if (request !== listRequest) return state
  // Commit response only when this refresh is still current.
} catch (error) {
  if (request === listRequest) throw error
}
```

- [x] Keep queued requests visible in conversation, follow-up draft editable but not sent until the accepted turn ends; Stop cancels queued work. Permit decisions are gated by task/request mutation, not unrelated error banners. Sidebar reflects only backend waitingFor and pendingPermissionCount.
- [x] Run workbench + navigation tests and commit only UI changes. Leave real-browser QA to task 3 after edits settle.

### Task 3: 接口、真实并行与审查

**Files:**
- Modify/Test: `src/daemon/internal-api/routes-workbench.test.ts` only if metadata serialization lacks coverage
- Add: `docs/superpowers/reports/2026-09-12-cc-task-concurrency-validation.md`
- Update this plan and scope delivery notes

**Interfaces:** Uses current local runner `scripts/dev-cc-workbench.ts`, real installed/authenticated native providers, and unchanged task endpoints. Use disposable isolated folders; never use personal files as probes.

- [x] Verify list/detail preserve waitingFor and task permission metadata through HTTP. Preserve strict ID validation and task-bound artifact/permission operations.
- [x] Record primary-source inspected commit/file links for Paseo, Orca and the retained CC Switch setup principle; explicitly distinguish adapted concepts from copied implementation and from untested features.
- [x] Restart only the owned preview runner after confirming no user task remains running. Start real Claude and Codex tasks in different disposable folders and observe overlap; create a same-folder queued task, switch among them, verify drafts and outcomes stay scoped, and cancel only the intended task. Check pending approvals and immutable outputs where native agents request them.
- [x] Inspect actual UI at 1440px and a narrower desktop width; capture evidence of two tasks running, truthful waiting, and continued access through collapsed navigation. Test failures discovered here get focused regression tests and review.
- [x] Run `bun --bun vitest run src/core/workbench src/core/claude-agent-provider.test.ts src/core/codex-agent-provider.test.ts src/daemon/bootstrap/wire-workbench.test.ts src/daemon/bootstrap/session-paths.test.ts src/daemon/internal-api/routes-workbench.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/token-registry.test.ts apps/desktop/src/modules/workbench.test.ts apps/desktop/src/modules/workbench-navigation.test.ts apps/desktop/src/modules/cc-life.test.ts apps/desktop/workbench-proxy.test.ts scripts/workbench-codex-config.test.ts scripts/workbench-claude-config.test.ts` and `bun run typecheck`.
- [x] Independent task reviews and final review cover spec compliance plus race/cleanup quality; address actionable findings and rerun only covering tests before final verification. Confirm frozen asset diff empty, record actual proof and limitations, commit locally and leave the preview open for the user.

## Decisions and limits

Use conflict-scoped FIFO instead of adding automatic worktrees or a concurrency settings form. This preserves ordinary-folder support; overlapping tasks wait even when they could have been read-only. No arbitrary global concurrency cap is introduced this round: every unrelated user-started task may run, subject to installed provider/system limits. Queue metadata is derived from live run ownership, not persisted promises of eventual execution. Recovery keeps stage-1 interruption semantics; external CLI processes are outside this scheduler's ownership.
