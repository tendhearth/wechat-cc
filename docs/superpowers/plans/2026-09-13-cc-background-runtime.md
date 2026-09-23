# CC Background Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Retain owned background execution and late replies in the same task, with honest input receipts and confirmed teardown.

**Architecture:** An optional native runtime stream survives parent results once background work is observed. One runtime owns one immutable run epoch and writer reservation. Legacy chat and ordinary no-background work keep their existing completion contracts.

**Tech Stack:** TypeScript/Bun/Vitest, Claude Agent SDK, Codex app-server, SQLite, existing vanilla desktop UI.

**Spec:** `docs/superpowers/specs/2026-09-13-cc-background-runtime.md`

## Global Constraints

- Worktree `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`; branch `codex/cc-workbench-v1`; no push/merge or real bot replacement.
- No quiet timer, child count or generic result may prove full native quiescence.
- Same runtime epoch retains directory, permissions, credentials and accepted model settings until confirmed close.
- Native probes use owned temporary homes, loopback synthetic models and owned tools only.
- Ordinary chat protocol remains unchanged; frozen art and `build-cc-asset-kit.mjs` remain untouched.

### Task 1: Protocol evidence and shared contract

Files: create `scripts/workbench-claude-background-smoke.ts`, `scripts/workbench-codex-background-smoke.ts`; modify `src/core/agent-provider.ts`; add durable reports alongside this plan.

- [x] Reproduce parent result followed by live child output on both installed native executors.
- [x] Reproduce two Claude notifications where the first automatic result is not the last, and Codex parent interrupt leaving a child active.
- [x] Verify explicit Claude input UUID acknowledgement and Codex same-thread subsequent turn; record native limitations.
- [x] Introduce the additive contract, with no activation before service integration:

```ts
export interface AgentRuntimeSnapshot {
  retained:boolean
  foreground:'running'|'idle'|'unknown'
  backgroundCount:number
  input:'steer'|'send'|'queue'
}
export interface AgentWorkbenchRuntime {
  events:AsyncIterable<AgentEvent>
  start(text:string,attachments?:readonly AgentAttachment[]):void
  submit(requestId:string,text:string,attachments?:readonly AgentAttachment[]):Promise<void>
  snapshot():AgentRuntimeSnapshot
}
```

`AgentSession.workbenchRuntime?`, `SpawnContext.workbenchLifecycle?` and `AgentActivity.output?` are additive. Test projection keeps only public output, caps at 40,000 and never promotes it to top-level text.

### Task 2: Codex owned runtime

Files: `src/core/workbench/codex-app-server.ts`, a focused native runtime helper if needed, corresponding `codex-app-server*.test.ts`, `scripts/workbench-codex-background-smoke.ts`.

- [x] Add failing tests: parent completion with active child keeps lifetime stream; late child output remains child-attributed; same child with another turn creates a distinct occurrence.
- [x] Route only descendants with verified root lineage; match native request/turn IDs for child permissions and questions. Unowned/wrong-turn requests fail closed.
- [x] Implement runtime `start`, acknowledged `submit` using turn/steer or same-thread turn/start, sticky retained state and exact occurrence lifecycle.
- [x] Test child failures stay activity failures, parent model/session remains authoritative, cancellation interrupts all owned turns and process-group close remains required.
- [x] Run corresponding Vitest suites and rerun the real native probe through the production adapter. Native late child output, both V1/V2 operations, same-thread continuation and teardown must match.

### Task 3: Claude lifetime query

Files: `src/core/claude-agent-provider.ts`, focused runtime helper/tests, `scripts/workbench-claude-background-smoke.ts`.

- [x] Add failing replay fixtures for the measured two-child race, task_started versus Agent launch acknowledgement, and child public text versus parent text.
- [x] Maintain one query reader, emitting lifetime events beyond parent result for opt-in only; process real task lifecycle fields without requiring the private state flag.
- [x] Implement snapshot and sticky retained state. Terminal child events update an occurrence once; duplicate/start-after-terminal cannot regress. Observe background commands as well as agents.
- [x] Implement submit only against verified UUID acknowledgement; ambiguous acknowledgement never retries. Unknown/unavailable send capability returns a declared queue state.
- [x] Test ordinary chat first-result behavior remains unchanged, owned stop closes all work, automatic replies cannot overwrite the parent execution identity.
- [x] Run adapter suites and production-path native probes including two simultaneous children and user input during automatic reply.

### Task 4: Service ownership and public output

Files: `src/core/workbench/service.ts`, `timeline-events.ts`, `service-background.test.ts`, timeline tests, existing live input tests.

- [x] Add a fake-runtime regression sequence: start → main result → child late output → second automatic result. Assert one run, no early close/revoke/snapshot/path release, and another project can proceed.
- [x] Activate `workbenchLifecycle:true`; use optional runtime start/events instead of legacy dispatch. Expose a copied snapshot in list/detail, still deriving ownership from Active.
- [x] Keep first-result identity updates but finalization only at stream end/stop/failure. Pause idle watchdog only for retained observed-idle runtime, not actual executing work.
- [x] Persist input receipt before runtime.submit; bind it to original task/run and immutable material/settings. Test stop racing acknowledgement/rejection and never resurrect held input or replay ambiguous delivery.
- [x] Preserve final artifact capture only after positive close; test uncertain-close reservation, queued sibling task and stale permission/answer denial.
- [x] Project child `activity.output` separately with 40,000 character cap and escape on display; WeChat latest reply remains parent-only.

### Task 5: Minimal desktop/WeChat integration and evidence

Files: `apps/desktop/src/modules/workbench*.js`, adjacent focused UI tests, `src/core/workbench/wechat-control.ts` and tests, a browser smoke case in existing owned harness.

- [x] Show “会话保留中” for retained observed idle, actual executing state otherwise, and known child count without claiming global completion.
- [x] Reuse existing input controls for same-epoch input and stop; keep model settings disabled while ownership is retained. Do not add a panel or process graph.
- [x] Render child output inside expandable activity details; preserve order and completed activity folding around main replies.
- [x] Browser verification: main answer visible before child completion, child result expanded, continued input has durable receipt, stop releases next same-path task. Inspect captured screenshots.
- [x] Run relevant backend/desktop/WeChat tests, whole typecheck, independent review, and native teardown proof. Record known full-suite HTTP environment failures accurately if still present.
- [x] Commit independently verified changes locally and update the unified scope/report; goal remains active for remaining native capabilities.
