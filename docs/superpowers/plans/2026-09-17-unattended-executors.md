# 免审执行者(agy / Cursor 进工作台)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已发现的 agy / Cursor 出现在工作台执行者列表并可用(标「免审」),第一次确认一次(daemon 侧持久化),微信也能 `用 @agy`;现有三家不变。

**Architecture:** 能力模型加第三种值 `permissions:'unattended'` + 常量 `UNATTENDED_CAPABILITIES`;服务层在 `requireInput` 设门(`unattended_ack_required`),开关持久化在 `agent-config.json`;spawn 时按能力决定 `permissionMode`;工作台注册处把 boot registry 里的 agy / cursor 同实例挂上免审能力;一条 ack 路由;微信文案;桌面标签 + 对话框。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest)、zod(agent-config)、桌面 vanilla JS(Tauri 2,Rust 放行清单)。

**Spec:** `docs/superpowers/specs/2026-09-17-unattended-executors-design.md`

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树 `…/wechat-cc`。
- 测试 `bun --bun vitest run <paths>`;全量 `bun run test`;Node `npm run test:node`;`bun run typecheck`;`bun run depcheck`(0 errors;7 warnings 既有)。业务代码不 import `bun:*`。
- **"不按品牌准入"不变式保留**:`src/core/workbench/service-capabilities.test.ts` 的 `does not admit a provider by brand` 必须原样通过;准入只看能力对象。
- 错误码 `unattended_ack_required` ⇒ HTTP 428;`unavailable_provider` 仍 422。
- 新路由要在四处登记:`route-tiers.ts`(admin)、`token-registry.ts` operator 放行、`token-registry.test.ts` 精确集合、`apps/desktop/src-tauri/src/lib.rs` 两处放行清单(`workbench_request_allowed` 的 `matches!` 与 ~1376 起的测试表)。
- 文案:桌面与微信都不再写死 "Claude Code／Codex";免审四条限制原文(桌面对话框与微信文案共用同一组措辞):①看不到、拦不下单步操作,没有权限卡和提问,只能停止;②它用的工具凭据不是按任务隔离的;③时间线只有文字,没有逐条工具调用;④不能带附件、不能选模型和推理档。
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。每任务:相关测试绿 → typecheck 干净 → 提交。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/core/workbench/executor-capabilities.ts` | `permissions` 联合类型、`UNATTENDED_CAPABILITIES`、`isUnattendedExecutor` |
| `src/lib/agent-config.ts` | `workbench_unattended_ack_at?: number` |
| `src/core/workbench/service.ts` | `Options.unattendedAck`、`requireInput` 设门、`acknowledgeUnattended()`、`list().unattendedAcknowledgedAt`、spawn `permissionMode` |
| `src/daemon/bootstrap/wire-workbench.ts` | 注册 agy / cursor(UNATTENDED)、接 `unattendedAck` |
| `src/daemon/internal-api/routes-workbench.ts` + tiers + token-registry + lib.rs | `POST /v1/workbench/unattended-ack`、428 映射 |
| `src/core/workbench/wechat-control.ts` | 两条文案 |
| `apps/desktop/src/modules/workbench.js` / `workbench-execution.js` / `workbench-unattended.js`(新) | 标签、空状态、对话框、重发、详情头一行 |
| `docs/cc-workbench.md` | 修订记录 |

---

### Task 1: 能力模型

**Files:**
- Modify: `src/core/workbench/executor-capabilities.ts`
- Test: `src/core/workbench/executor-capabilities.test.ts`(追加)

**Interfaces:**
- Produces: `WorkbenchExecutorCapabilities.permissions: 'task' | 'unattended'`;`export const UNATTENDED_CAPABILITIES: WorkbenchExecutorCapabilities`;`export const isUnattendedExecutor=(c:WorkbenchExecutorCapabilities)=>c.permissions==='unattended'`。

- [ ] **Step 1: 写失败的测试**(追加)

```ts
import { UNATTENDED_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES, isWorkbenchExecutorCapabilities, isUnattendedExecutor, requireWorkbenchInput } from './executor-capabilities'

describe('免审执行者能力', () => {
  it('permissions 认 task 与 unattended,拒绝别的值', () => {
    expect(isWorkbenchExecutorCapabilities(UNATTENDED_CAPABILITIES)).toBe(true)
    expect(isWorkbenchExecutorCapabilities(MANAGED_NATIVE_CAPABILITIES)).toBe(true)
    expect(isWorkbenchExecutorCapabilities({ ...UNATTENDED_CAPABILITIES, permissions: 'none' })).toBe(false)
    expect(isUnattendedExecutor(UNATTENDED_CAPABILITIES)).toBe(true); expect(isUnattendedExecutor(MANAGED_NATIVE_CAPABILITIES)).toBe(false)
  })
  it('免审执行者不收附件、不认执行设置,但能恢复原会话', () => {
    const execution = { defaults: 'provider' as const, model: null, reasoningEffort: null }
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [{}], execution })).toThrow('workbench_attachments_unsupported')
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [], execution: { ...execution, model: 'x' } })).toThrow('workbench_execution_unsupported')
    expect(() => requireWorkbenchInput(UNATTENDED_CAPABILITIES, { attachments: [], execution, resume: true })).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑,确认失败** — `bun --bun vitest run src/core/workbench/executor-capabilities.test.ts` ⇒ FAIL(导出不存在)

- [ ] **Step 3: 实现**

```ts
export interface WorkbenchExecutorCapabilities { version: 1; permissions: 'task' | 'unattended'; … }   // 其余不变
/** 免审:执行者自己的旁路开关启动(agy --dangerously-skip-permissions / cursor --yolo),daemon 拦不到单步;附件与执行设置它们的 dispatch 不收。 */
export const UNATTENDED_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'unattended',configuration:'task-policy',completion:'native',stop:'confirmed',background:'disabled',
  features:Object.freeze({nativeResume:true,attachments:false,executionSettings:false,modelCatalog:false}),
})
export const isUnattendedExecutor=(capabilities:WorkbenchExecutorCapabilities):boolean=>capabilities.permissions==='unattended'
// isWorkbenchExecutorCapabilities: 把 value.permissions!=='task' 改成 (value.permissions!=='task'&&value.permissions!=='unattended')
```

- [ ] **Step 4: 跑,确认通过** — 同上 + `bun --bun vitest run src/core/workbench/service-capabilities.test.ts`(不变式)+ typecheck
- [ ] **Step 5: 提交** — `工作台能力模型:加免审执行者(permissions:'unattended' + UNATTENDED_CAPABILITIES)`

---

### Task 2: 确认开关 + 服务层设门 + spawn permissionMode

**Files:**
- Modify: `src/lib/agent-config.ts`(接口 ~L11-50、zod ~L248-256、load ~L340-348)
- Modify: `src/core/workbench/service.ts`(`Options` L32-51、`requireInput` ~L263-266、spawn ~L540、`list()` ~L1173-1176、返回对象加 `acknowledgeUnattended`)
- Test: `src/core/workbench/service-unattended.test.ts`(新)

**Interfaces:**
- Consumes: Task 1。
- Produces:`AgentConfig.workbench_unattended_ack_at?: number`;`Options.unattendedAck?: { get(): number | null; set(at: number): void }`;`service.acknowledgeUnattended(): number`;`service.list().unattendedAcknowledgedAt: number | null`;错误 `unattended_ack_required`;spawn 上下文 `permissionMode` 免审 ⇒ `'dangerously'`。

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/workbench/service-unattended.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import { UNATTENDED_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'

function fakeProvider(spawned: unknown[]) {
  return { async spawn(_project: unknown, context: unknown) { spawned.push(context); return { async *dispatch() { yield { kind: 'text' as const, text: '好了' }; yield { kind: 'result' as const, sessionId: 's', numTurns: 1, durationMs: 1 } }, async cancel() {}, async close() {} } } }
}
function setup(acked: number | null = null) {
  const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = mkdtempSync(join(tmpdir(), 'wb-unatt-'))
  const registry = createProviderRegistry(), spawned: Array<{ permissionMode?: string }> = []
  registry.register('agy', fakeProvider(spawned) as never, { displayName: 'agy', workbench: UNATTENDED_CAPABILITIES } as never)
  registry.register('claude', fakeProvider(spawned) as never, { displayName: 'Claude', workbench: MANAGED_NATIVE_CAPABILITIES } as never)
  let ack = acked
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner', unattendedAck: { get: () => ack, set: at => { ack = at } } })
  return { service, store, stateDir, spawned, ackValue: () => ack }
}
const input = (stateDir: string, providerId: string) => ({ path: stateDir, providerId, text: '做点事', execution: { defaults: 'provider' as const, model: null, reasoningEffort: null } })

describe('免审执行者门', () => {
  it('未确认 ⇒ create 抛 unattended_ack_required;claude 不受影响', () => {
    const { service, stateDir } = setup()
    expect(() => service.create(input(stateDir, 'agy'))).toThrow('unattended_ack_required')
    expect(() => service.create(input(stateDir, 'claude'))).not.toThrow()
  })
  it('acknowledgeUnattended 写开关并返回时间;之后 create 通过;list 带 unattendedAcknowledgedAt', async () => {
    const { service, stateDir, ackValue, spawned } = setup()
    expect(service.list().unattendedAcknowledgedAt).toBeNull()
    const at = service.acknowledgeUnattended(); expect(ackValue()).toBe(at); expect(service.list().unattendedAcknowledgedAt).toBe(at)
    const task = service.create(input(stateDir, 'agy'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('dangerously')
    await service.shutdown()
  })
  it('claude 的 spawn 仍是 strict', async () => {
    const { service, stateDir, spawned } = setup(Date.now())
    const task = service.create(input(stateDir, 'claude'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('strict')
    await service.shutdown()
  })
  it('没接 unattendedAck(老接线)⇒ 免审执行者一律 unattended_ack_required', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = mkdtempSync(join(tmpdir(), 'wb-unatt-'))
    const registry = createProviderRegistry(); registry.register('agy', fakeProvider([]) as never, { displayName: 'agy', workbench: UNATTENDED_CAPABILITIES } as never)
    const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
    expect(() => service.create(input(stateDir, 'agy'))).toThrow('unattended_ack_required')
  })
})
```
(用 `removeTempDir` 清理 stateDir,照 `service-live.test.ts` 的写法。)

- [ ] **Step 2: 跑,确认失败** — `bun --bun vitest run src/core/workbench/service-unattended.test.ts`

- [ ] **Step 3: 实现**

```ts
// agent-config.ts —— 接口加  workbench_unattended_ack_at?: number
// zod:  workbench_unattended_ack_at: z.number().int().nonnegative().optional(),
// load: ...(typeof parsed.workbench_unattended_ack_at === 'number' ? { workbench_unattended_ack_at: parsed.workbench_unattended_ack_at } : {}),
// service.ts Options:
  /** 免审执行者的一次性确认(daemon 侧持久化);不传 ⇒ 免审执行者永远要求确认。 */
  unattendedAck?: { get(): number | null; set(at: number): void }
// requireInput:
  function requireInput(providerId:string,attachments:readonly unknown[],execution:AgentExecutionChoice,resume=false){
    const entry=provider(providerId)
    if(isUnattendedExecutor(entry.opts.workbench)&&(opts.unattendedAck?.get()??null)===null)throw new Error('unattended_ack_required')
    requireWorkbenchInput(entry.opts.workbench,{attachments,execution,resume})
    return entry
  }
// spawn(~L540):  tierProfile:TIER_PROFILES.trusted,permissionMode:isUnattendedExecutor(entry.opts.workbench)?'dangerously':'strict',…
// list():  …,defaultProvider:…,unattendedAcknowledgedAt:opts.unattendedAck?.get()??null,…
// 返回对象:
    acknowledgeUnattended(){ const at=Date.now(); if(!opts.unattendedAck)throw new Error('unattended_ack_unavailable'); opts.unattendedAck.set(at); return at },
```

- [ ] **Step 4: 跑** — 新测试 + `bun --bun vitest run src/core/workbench src/lib/agent-config.test.ts` + typecheck
- [ ] **Step 5: 提交** — `工作台 service:免审执行者设门(unattended_ack_required)、一次性确认持久化到 agent-config、免审 spawn 用 dangerously`

---

### Task 3: 注册 agy / cursor 进工作台 registry

**Files:**
- Modify: `src/daemon/bootstrap/wire-workbench.ts`(L85-118)
- Test: `src/daemon/bootstrap/wire-workbench.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 `UNATTENDED_CAPABILITIES`;Task 2 `Options.unattendedAck`。

- [ ] **Step 1: 写失败的测试**:构造 `opts.boot.registry` 含 `agy`/`cursor`(假 provider,`displayName:'Gemini (agy)'`/`'Cursor'`)⇒ `wireWorkbench(...).list().providers` 含两者且 `capabilities.permissions==='unattended'`,`displayName` 沿用;boot registry 没有 ⇒ 列表没有;`unattendedAcknowledgedAt` 读的是 `agent-config.json` 的 `workbench_unattended_ack_at`(先写一个值再断言)。照本文件已有用例的 `opts` 建法(看它怎么伪造 `boot`)。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现**

```ts
  // 免审执行者:boot 时发现了就进工作台,同一个 provider 实例,只换能力对象(spec §4)。
  for(const id of ['agy','cursor'] as const){const entry=opts.boot.registry.get(id);if(entry)registry.register(id,entry.provider,{...entry.opts,workbench:UNATTENDED_CAPABILITIES})}
  …
  return makeWorkbenchService({
    …,
    unattendedAck:{
      get:()=>loadAgentConfig(opts.stateDir).workbench_unattended_ack_at??null,
      set:at=>{const current=loadAgentConfig(opts.stateDir);saveAgentConfig(opts.stateDir,{...current,workbench_unattended_ack_at:at})},
    },
  })
```
- [ ] **Step 4: 跑** — `bun --bun vitest run src/daemon/bootstrap` + typecheck
- [ ] **Step 5: 提交** — `工作台注册:boot 发现的 agy / cursor 以免审能力进工作台;确认开关接 agent-config`

---

### Task 4: 路由 + 四处登记 + 428 映射

**Files:**
- Modify: `src/daemon/internal-api/routes-workbench.ts`(`mappedError` ~L55-63、新路由)、`route-tiers.ts`、`token-registry.ts`(~L176-190)、`token-registry.test.ts`(~L83-105 精确集合)、`apps/desktop/src-tauri/src/lib.rs`(`matches!` 与 ~L1376 表)
- Test: `routes-workbench.test.ts`(追加)、`token-registry.test.ts`

- [ ] **Step 1: 写失败的测试**:`POST /v1/workbench/unattended-ack` ⇒ 200 `{acknowledgedAt}` 且调用 `svc.acknowledgeUnattended`;trusted token ⇒ 403;`create` 时 service 抛 `unattended_ack_required` ⇒ 428 `{error:'unattended_ack_required'}`;`minTierFor('POST /v1/workbench/unattended-ack')==='admin'`;token-registry 精确集合加这条(放在 `'POST /v1/workbench/archive'` 之后)。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现**

```ts
// mappedError:  if (code === 'unattended_ack_required') return { status: 428, body: { error: code } }
    'POST /v1/workbench/unattended-ack': async () => {
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try { return { status: 200, body: { acknowledgedAt: deps.workbench.acknowledgeUnattended() } } } catch (err) { return mappedError(err) }
    },
// route-tiers: 'POST /v1/workbench/unattended-ack': 'admin',
// token-registry: 'POST /v1/workbench/unattended-ack', (紧跟 archive)
// lib.rs 两处各加 | ("POST", "/v1/workbench/unattended-ack")  /  ("POST", "/v1/workbench/unattended-ack"),
```
`cd apps/desktop/src-tauri && cargo check`。
- [ ] **Step 4: 跑** — `bun --bun vitest run src/daemon/internal-api` + typecheck
- [ ] **Step 5: 提交** — `内部 API:POST /v1/workbench/unattended-ack;unattended_ack_required ⇒ 428;四处放行`

---

### Task 5: 微信文案

**Files:**
- Modify: `src/core/workbench/wechat-control.ts`(`failure()` ~L147-150)
- Test: `src/core/workbench/wechat-control.test.ts`(L33/41 附近的文案断言 + 新增)

- [ ] **Step 1: 写失败的测试**:`createWechat` 抛 `unattended_ack_required` ⇒ 回复含「免审」「桌面」「只能停止」;`unavailable_provider` 回复不再含「Claude Code／Codex」但仍含「连接或管理」、不含「安装」。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现**

```ts
  if(code==='unattended_ack_required')return 'agy / Cursor 是免审执行者：跑任务时看不到、拦不下单步操作，没有权限卡和提问，只能停止；它用的工具凭据不是按任务隔离的；时间线只有文字；不能带附件、不能选模型。请先在桌面工作台确认一次，之后微信也能直接用。没有开始工作。'
  if(code==='unavailable_provider')return '暂时没有可用的工作执行者，没有开始工作。请在桌面连接或管理一个支持工作任务的执行者。'
```
- [ ] **Step 4: 跑** — `bun --bun vitest run src/core/workbench/wechat-control.test.ts` + typecheck
- [ ] **Step 5: 提交** — `微信任务命令:免审执行者未确认的说明;可用执行者文案去掉写死的品牌`

---

### Task 6: 桌面

**Files:**
- Create: `apps/desktop/src/modules/workbench-unattended.js`(纯函数 + 对话框)
- Modify: `apps/desktop/src/modules/workbench.js`(`providerLabel` L28-33;空状态 L300;`mutate`/create 提交 ~L968-980 与 continue 处的错误分支;任务详情头部)、`apps/desktop/src/modules/workbench-execution.js`(L32 文案)
- Test: `apps/desktop/src/modules/workbench-unattended.test.js`(新)、`workbench-execution.test.js`(L74-75 文案)、`workbench.test.ts`(controller 级:428 ⇒ ack ⇒ 重发)

**Interfaces(`workbench-unattended.js`):**
```js
export const UNATTENDED_NOTES = ['看不到、拦不下单步操作:没有权限卡和提问,只能停止。','它用的工具凭据不是按任务隔离的。','时间线只有文字,没有逐条工具调用。','不能带附件,不能选模型和推理档。']
export function isUnattendedProvider(provider)           // provider.capabilities?.permissions === 'unattended'
export function unattendedLabelSuffix(provider)          // '（免审）' | ''
export function isAckRequiredError(error)                // error?.message / error?.error === 'unattended_ack_required' 或 status 428(看 invokeWorkbenchApi 抛错的形状,在 api.js 里确认)
export function renderUnattendedDialog()                 // 返回 <dialog> 的 innerHTML 字符串:标题「免审执行者」、四条、两个按钮 data-unattended="ack"|"cancel"
export function mountUnattendedDialog(onAck)             // 建 dialog、showModal、按钮绑定;ack ⇒ await onAck() 后关闭;cancel/close ⇒ 关闭
```

- [ ] **Step 1: 写失败的测试**(纯函数:标签、判错、对话框 HTML 含四条与两个按钮;controller 级:`invokeWorkbenchApi` 假件第一次 create 抛 428 错误 ⇒ 调用 `deps.confirmUnattended`(注入的确认函数,测试里返回 true)⇒ 调 `POST /v1/workbench/unattended-ack` ⇒ 再次 create 成功;返回 false ⇒ 不重发)。
- [ ] **Step 2: 跑,确认失败** — `bun --bun vitest run apps/desktop/src/modules/workbench-unattended.test.js apps/desktop/src/modules/workbench.test.ts`
- [ ] **Step 3: 实现**:`providerLabel` 在 quota/usage 之外追加 `unattendedLabelSuffix(p)`;空状态文案「还没有可用的执行者。装好 Claude Code、Codex、agy 或 Cursor 后再开始任务。」;`workbench-execution.js:32` 同步;create/continue 的提交处:`catch (error) { if (isAckRequiredError(error) && await deps.confirmUnattended?.()) { await deps.invokeWorkbenchApi('POST','/v1/workbench/unattended-ack'); return retry() } throw error }`,`deps.confirmUnattended` 默认实现 = `mountUnattendedDialog` 返回的 Promise<boolean>;任务详情头部:选中任务的 provider 是免审 ⇒ `<p class="wb-task-unattended">免审执行者 · 看不到单步,只能停止</p>`。
- [ ] **Step 4: 跑** — `bun --bun vitest run apps/desktop` + typecheck + `cd apps/desktop && bun x playwright test`(118 不变)
- [ ] **Step 5: 提交** — `桌面工作台:免审执行者标签、一次性确认对话框、428 后自动确认重发、详情头提示`

---

### Task 7: 文档、全量、推送、CI(部署与真机由控制者做)

- [ ] `docs/cc-workbench.md` 修订记录末尾加:
```md
- **2026-09-17**：免审执行者。boot 时发现的 agy / Cursor 进工作台执行者列表（标「免审」）：用它们自己的跳过审批开关启动，daemon 仍守文件夹租约、目录身份、成果收集、diff 快照与停止；看不到、拦不下单步，没有权限卡与提问，工具凭据非按任务隔离，时间线只有文字，不能带附件与选模型。第一次选到要在桌面确认一次（`POST /v1/workbench/unattended-ack`，持久化在 `agent-config.json` 的 `workbench_unattended_ack_at`），未确认时 `create`/`continue`/微信 `用 @agy` 都返回 `unattended_ack_required`（428）。设计：`docs/superpowers/specs/2026-09-17-unattended-executors-design.md`。
```
- [ ] `bun run test` → `npm run test:node` → `bun run typecheck` → `bun run depcheck`(负载抖动单跑即绿,报告里列出)
- [ ] 提交、`git push origin dev`、`gh run watch`(Windows 20 s hook 超时 ⇒ `gh run rerun --failed` 至多两次)

---

## Self-review

- 覆盖:§1 T1;§2 T2+T3;§3 T2;§4 T3;§5 T4;§6 T5;§7 T6;错误处理(ack 写盘失败 ⇒ `acknowledgeUnattended` 抛 ⇒ 500)T4;测试各任务;文档 T7。
- 类型一致:`unattendedAck.get(): number|null`(T2/T3);`acknowledgeUnattended(): number`(T2/T4);`unattendedAcknowledgedAt`(T2 list / T6 桌面读取);`UNATTENDED_CAPABILITIES`(T1/T3);错误码字符串三处一致(T2/T4/T5/T6)。
- 未决:桌面 `invokeWorkbenchApi` 抛错的形状(api.js 里 `JSON.parse` 后的 `{error}` 还是 Error(message))—— T6 实施者先看 `apps/desktop/src/api.js:115-127` 与 Rust 代理对非 2xx 的处理(`lib.rs` ~1078:非 2xx 返回 `Err(message)` 其中 message = body.error),据此写 `isAckRequiredError`。
