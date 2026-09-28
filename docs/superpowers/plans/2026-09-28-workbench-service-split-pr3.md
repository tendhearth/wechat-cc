# workbench service 拆分 · PR 3(quota 域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 quota 域(额度登记处 `quota`、`fallbackExecutor`、三个 public 入口)逐字搬进 `src/core/workbench/service/quota.ts`;顺手把 PR 2 评审留下的 `materials` 改名成 `attachmentsDomain`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1/2。`ServiceCtx.deps` 加 `registry`(执行者登记处)与 `usage`(订阅额度快照,可选)—— quota 域和后面的 admission/notices 域都要它们。`quota` 登记处对象由域建、`service.ts` 解构拿回(`execute`/`requireInput`/`attention` 仍直接用 `quota.note/clear/exhausted`,调用点不改)。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 3 项)。基线 dev `88263c09`。

## Global Constraints

- 分支 `sweep/workbench-service-split-3`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、文案。逐字搬,注释一起搬。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。`service/review.test.ts`、`service/attachments.test.ts` 是前两个 PR 自己的,允许为 ctx 新字段补字段。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`quota` 是同一个实例**:域里建的登记处必须就是 `execute` 里 `quota.note(...)` / `quota.clear(...)` 用的那个,否则「认出额度错误 → 登记 → 下次 requireInput 拒绝」这条链断在中间还全绿(单测只看各自一段)。Task 2 域单测「note 之后 quotaExhausted 非空且 fallbackExecutor 跳过它」+ 既有 `service-quota.test.ts`(走完整链)钉住。
2. **`fallbackExecutor` 的四道过滤缺一不可**:排除 `exhaustedId`、`isWorkbenchProviderId`、`background==='tracked'`、`quota.exhausted` —— Task 2 域单测四条各一。
3. **`ctx.deps.usage` 可选**:没传时 `makeQuotaRegistry(Date.now,undefined)` 行为与原来一致(`opts.usage` 本来就可选)—— Task 2 域单测「不传 usage 也能建、snapshot 为空」钉住;`exactOptionalPropertyTypes` 下 `usage:opts.usage` 直传 `undefined` 是否报错,以 typecheck 为准(报了就条件展开)。
4. **`materials`→`attachmentsDomain` 改名不能漏**:`grep -n '\bmaterials\.' service.ts` 改名后只剩局部变量那三处(1445/1502/1564 附近,是 `Attachment[]`/`InputMaterials` 类型的局部量,不是域)。Task 1 以 typecheck + 19 份测试为门。
5. **`providerQuota()` 返回的是快照不是内部 Map** —— 搬家后仍走 `quota.snapshot()`。Task 2 域单测「改快照不影响下一次 snapshot」钉住。

---

### Task 1: `ctx.deps` 加 `registry` / `usage`;`materials` 改名

**Files:**
- Modify: `src/core/workbench/service/ctx.ts`(`ServiceDeps` 加两字段)
- Modify: `src/core/workbench/service.ts`(ctx 字面量;`materials`→`attachmentsDomain` 共 8 处)
- Modify: `src/core/workbench/service/review.test.ts`、`src/core/workbench/service/attachments.test.ts`(fixture 的 `deps` 补 `registry`)

**Interfaces:**
- Produces:
  ```ts
  export interface ServiceDeps {
    ownerChatId: () => string | null
    /** 执行者登记处:quota 的候选、admission 的准入、notices 的显示名都从这里查。 */
    registry: ProviderRegistry
    /** 订阅执行者的真实额度快照(subscription-usage.ts 的监视器缓存);可选,不传就只靠失败信息判耗尽。 */
    usage?: (providerId: string) => UsageSnapshot | null
  }
  ```

- [ ] **Step 1: 改 `ctx.ts`**:import `type { ProviderRegistry } from '../../provider-registry'`、`type { UsageSnapshot } from '../../subscription-usage'`;`ServiceDeps` 加上面两个字段(注释照抄)。

- [ ] **Step 2: typecheck 先红**

Run: `bun run typecheck 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "Found [0-9]+ error"`
Expected: `Found 3 errors`(service.ts 的 ctx 字面量、两份域单测的 fixture 各缺 `registry`)。

- [ ] **Step 3: `service.ts`**
  1. ctx 字面量 `deps:{ownerChatId:opts.ownerChatId}` → `deps:{ownerChatId:opts.ownerChatId,registry:opts.registry,...(opts.usage?{usage:opts.usage}:{})}`。
  2. `const materials=makeAttachmentsDomain(ctx)` → `const attachmentsDomain=makeAttachmentsDomain(ctx)`;下一行解构的右侧同改;public 对象里六处 `materials.xxx` → `attachmentsDomain.xxx`。用 `sed -i '' -E 's/\bmaterials\.(uploadAttachment|uploadAttachmentChunk|attachmentUploadStatus|discardAttachmentUpload|readAttachment|discardAttachment)\b/attachmentsDomain.\1/g'` 只改这六个方法引用,不碰局部变量。

- [ ] **Step 4: 两份域单测 fixture**:`deps: { ownerChatId: () => owner }` → `deps: { ownerChatId: () => owner, registry: createProviderRegistry() }`(`review.test.ts` 是 `() => 'owner'`),并 `import { createProviderRegistry } from '../../provider-registry'`。

- [ ] **Step 5: 验证**

Run: `bun run typecheck 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "Found [0-9]+ error" || echo 0; grep -c "\bmaterials\." src/core/workbench/service.ts; bun --bun vitest run src/core/workbench/service 2>&1 | grep -E "Test Files|Tests "`
Expected: `0`;`0`(六处方法引用都改了;局部变量 `materials` 不带点号调用域方法);22 文件 260 条全过。

- [ ] **Step 6: Commit**

```bash
git add src/core/workbench/service/ctx.ts src/core/workbench/service.ts src/core/workbench/service/review.test.ts src/core/workbench/service/attachments.test.ts
git commit -m "workbench service 拆分 8/n:ctx.deps 加 registry/usage;attachments 域变量改名 attachmentsDomain(评审 minor,行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: quota 域

**Files:**
- Create: `src/core/workbench/service/quota.ts`
- Create: `src/core/workbench/service/quota.test.ts`
- Modify: `src/core/workbench/service.ts`(删 `quota`/`fallbackExecutor` 闭包 10 行与三个 public 方法 6 行;建域并解构)

**Interfaces:**
- Produces:
  ```ts
  export interface QuotaDomain {
    /** 登记处本体:execute / requireInput / attention 直接用 note / clear / exhausted。 */
    quota: ReturnType<typeof makeQuotaRegistry>
    fallbackExecutor(exhaustedId:string): string|null
    providerQuota(): Record<string,QuotaState>
    quotaExhausted(providerId:string): QuotaState|null
  }
  export function makeQuotaDomain(ctx:ServiceCtx): QuotaDomain
  ```
  public 对象里 `fallbackExecutor(exhaustedId){return fallbackExecutor(exhaustedId)}` 这一层包装原样保留在 `service.ts`(它是 public 签名的一部分,搬不搬无差别;保留最省事,也让 diff 只删不改)。

- [ ] **Step 1: 写 `service/quota.test.ts`(红)**

```ts
import { describe, it, expect, vi } from 'vitest'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { MANAGED_NATIVE_CAPABILITIES, MANAGED_API_CAPABILITIES } from '../executor-capabilities'
import type { AgentProvider } from '../../agent-provider'
import { makeRuntimeState } from './state'
import { makeQuotaDomain } from './quota'
import type { ServiceActions, ServiceCtx, ServiceDeps } from './ctx'

const CODEX_QUOTA = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:00"
const provider: AgentProvider = { async spawn() { throw new Error('not spawned in this test') } }

/** 最小 ctx:不需要 store 的真功能(quota 域不碰 store),但 ServiceCtx 要求有;给个 never 就行。 */
function setup(usage?: ServiceDeps['usage']) {
  const registry = createProviderRegistry()
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('openai', provider, { displayName: 'OpenAI', canResume: () => true, workbench: MANAGED_API_CAPABILITIES })   // background:'disabled'
  registry.register('kimi', provider, { displayName: 'Kimi', canResume: () => true })                                             // 没有 workbench 能力
  const state = makeRuntimeState()
  const ctx: ServiceCtx = { store: {} as never, stateDir: '/nowhere', state, hub: { touched: vi.fn(), bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry, ...(usage ? { usage } : {}) }, ensureAccepting: () => {}, now: Date.now, actions: new Ref<ServiceActions>('t') }
  return { domain: makeQuotaDomain(ctx), registry }
}

describe('makeQuotaDomain', () => {
  it('不传 usage 也能建;一开始谁都没耗尽、快照为空', () => {
    const { domain } = setup()
    expect(domain.providerQuota()).toEqual({})
    expect(domain.quotaExhausted('codex')).toBeNull()
  })
  it('fallbackExecutor:跳过 exhaustedId、跳过 background≠tracked、跳过没有 workbench 能力的;按登记顺序取第一个', () => {
    const { domain } = setup()
    expect(domain.fallbackExecutor('codex')).toBe('claude')
    expect(domain.fallbackExecutor('claude')).toBe('codex')
    expect(domain.fallbackExecutor('openai')).toBe('codex')
  })
  it('note 认出额度错误 ⇒ quotaExhausted 非空、快照里有它、fallbackExecutor 跳过它;clear 之后恢复(同一个登记处实例)', () => {
    const { domain } = setup()
    expect(domain.quota.note('claude', CODEX_QUOTA)).toBe('quota')
    expect(domain.quotaExhausted('claude')).toMatchObject({ kind: 'quota' })
    expect(Object.keys(domain.providerQuota())).toEqual(['claude'])
    expect(domain.fallbackExecutor('codex')).toBeNull()
    domain.quota.clear('claude')
    expect(domain.quotaExhausted('claude')).toBeNull()
    expect(domain.fallbackExecutor('codex')).toBe('claude')
  })
  it('usage 快照说耗尽 ⇒ 没 note 也算耗尽', () => {
    const { domain } = setup(id => id === 'codex' ? { providerId: 'codex', plan: null, windows: [{ name: '5h', usedPercent: 100, resetsAt: Date.now() + 3600_000 }], exhausted: true, fetchedAt: Date.now() } as never : null)
    expect(domain.quotaExhausted('codex')).toMatchObject({ kind: 'quota' })
    expect(domain.quotaExhausted('claude')).toBeNull()
    expect(domain.fallbackExecutor('claude')).toBeNull()
  })
  it('providerQuota 是快照:改返回值不影响下一次', () => {
    const { domain } = setup()
    domain.quota.note('codex', CODEX_QUOTA)
    const snap = domain.providerQuota(); delete snap['codex']
    expect(Object.keys(domain.providerQuota())).toEqual(['codex'])
  })
})
```

`UsageSnapshot` 的字段以 `src/core/subscription-usage.ts:16` 为准;`as never` 是为了不把 `UsageProviderId` 的联合搬进测试。

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/core/workbench/service/quota.test.ts`
Expected: FAIL,`Cannot find module './quota'`。

- [ ] **Step 3: 新建 `service/quota.ts`** —— 用脚本从 `service.ts` 抠 `/** 各执行者的额度/限流状态` 起到 `fallbackExecutor` 闭合 `}` 的 10 行,以及 public 对象里 `/** 各执行者的额度/限流状态快照` 到 `quotaExhausted(...)` 的 4 行;替换只有 `opts.usage`→`ctx.deps.usage`、`opts.registry`→`ctx.deps.registry`:

```ts
/**
 * quota 域:各执行者的额度/限流登记处 + 「交给谁继续」的候选。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 3 项);只认 ctx。
 * 登记处本体交回 service.ts(execute / requireInput / attention 直接 note / clear / exhausted),
 * 所以这里返回的是**同一个实例**,不是快照。
 */
import { makeQuotaRegistry, type QuotaState } from '../../provider-quota'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from '../executor-capabilities'
import type { ServiceCtx } from './ctx'

export interface QuotaDomain {
  quota: ReturnType<typeof makeQuotaRegistry>
  fallbackExecutor(exhaustedId:string): string|null
  providerQuota(): Record<string,QuotaState>
  quotaExhausted(providerId:string): QuotaState|null
}

export function makeQuotaDomain(ctx:ServiceCtx):QuotaDomain {
  // ……闭包 10 行逐字(opts.usage→ctx.deps.usage,opts.registry→ctx.deps.registry)……
  return {
    quota,fallbackExecutor,
    // ……providerQuota / quotaExhausted 两方法逐字(含各自注释)……
  }
}
```

- [ ] **Step 4: `service.ts` 接上**
  1. import `makeQuotaDomain`。
  2. 在 attachments 解构之后加:`const quotaDomain=makeQuotaDomain(ctx)` + `const {quota,fallbackExecutor}=quotaDomain`。
  3. 删闭包 10 行;public 对象里 `providerQuota` / `quotaExhausted` 两个方法(连各自注释)换成 `providerQuota:quotaDomain.providerQuota,` `quotaExhausted:quotaDomain.quotaExhausted,`;`fallbackExecutor(exhaustedId){…}` 那行**保留**。
  4. `makeQuotaRegistry` import 若 service.ts 不再用就删;`classifyProviderError`、`type QuotaState`、`isWorkbenchProviderId`、`isWorkbenchExecutorCapabilities` 别处还在用,以 `grep -c` 为准。

- [ ] **Step 5: 验证**

Run: `bun --bun vitest run src/core/workbench/service/quota.test.ts` → 5 通过。
Run: `bun run typecheck …` → 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` → 24 文件全过(其中 `service-quota.test.ts` 走完整链);`bun run depcheck | tail -1` → `0 errors, 21 warnings`。

- [ ] **Step 6: Commit**

```bash
git add src/core/workbench/service/quota.ts src/core/workbench/service/quota.test.ts src/core/workbench/service.ts
git commit -m "workbench service 拆分 9/n:quota 域搬进 service/quota.ts(登记处 + fallbackExecutor + 两个入口,行为不变)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量 `wc -l` 与内函数数(预期 ≈1749 行 / 60),改 `scripts/workbench-service-ratchet.guard.test.ts` 两个常量与注释「当前值 = PR 3 搬完 quota 域之后的实际值」。数字手抄,别拼 `bun -e` 的输出。
- [ ] **Step 2**:全量 `bun run test` / `npm run test:node` / typecheck / depcheck。Expected:bun 698 文件 / 9254 条(PR 2 之后 697/9249 + 1 文件 5 条);node 全绿;0;`0 errors, 21 warnings`。
- [ ] **Step 3: Commit**(含本计划文件)

```bash
git add scripts/workbench-service-ratchet.guard.test.ts docs/superpowers/plans/2026-09-28-workbench-service-split-pr3.md
git commit -m "workbench service 拆分 10/n:棘轮下调到搬完 quota 域的实际值;附 PR 3 计划

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 2 Task 4:push → `gh pr create --base dev`(标题「workbench service 拆分 PR 3:quota 域(行为不变)」)→ `ci triage --wait --rerun` → 合 dev 后 build-sidecar → `self deploy` → `selftest workbench --executor cursor --image --resume` PASS。

---

## Self-Review

- **Spec 覆盖**:§3 第 3 项 quota ✓;§2 `service/quota.ts` ✓;§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 3「逐字」指向 service.ts 具体行段,脚本抠、diff 核对。
- **类型一致**:`ctx.deps.registry/usage` Task 1 产、Task 2 消费;`QuotaDomain.quota` 与 service.ts 解构名 `quota`、`fallbackExecutor` 同名(调用点不改)。
- **Review Focus** 五条归属:1→Task 2 第 3 条用例 + service-quota.test;2→第 2 条;3→第 1 条 + typecheck;4→Task 1 Step 5 的 grep;5→第 5 条。
