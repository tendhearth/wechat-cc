# Subsystem 降级启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 可选子系统启动失败不再拖垮整个 daemon——降级、上报、重启恢复;核心收发链失败仍拒绝启动。

**Architecture:** 新增一个极简 `SubsystemSupervisor`(内存状态表,三态 ok/degraded/off),包住 main.ts 的 6 个可选 lifecycle 注册和 buildBootstrap 的 5 个可选 wire 块;状态经 `GET /v1/health` 暴露,degraded 时给管理员发一条汇总微信。核心链保持顺序代码不抽象。

**Tech Stack:** bun + TypeScript,vitest(单测)+ `vitest.e2e.config.ts`(e2e harness),zod(internal-api schema)。

**Spec:** `docs/superpowers/specs/2026-08-17-subsystem-degraded-boot-design.md`

## Global Constraints

- 测试一律 `import { describe, it, expect } from 'vitest'`,**绝不** `bun:test`(`test-runner-guard.test.ts` 会 fail 整个构建)。
- 测试不得触碰真实 state dir(`src/lib/config.ts:20-33` 已有 guard;e2e 一律走 harness 的 mkdtemp)。
- 单测:`bunx vitest run <file>`;e2e:`bunx vitest run --config vitest.e2e.config.ts <file>`。
- `LifecycleSet` 的注册顺序 = 停止的逆序(LIFO),包装后各 `lc.register` 的相对顺序必须与现状逐字一致。
- supervisor 的 catch 分支只做内存写 + log,不做任何可能再抛错的事(spec §4)。
- 核心链(internal-api、buildBootstrap 核心、pipeline、ilink、sessions、polling)**不包**,失败照旧 `shutdown(); throw`。
- 子系统命名固定(spec §1):`companion.push` `companion.introspect` `companion.ingest` `guard` `mailbox-poller` `customer-review` `knowledge` `social` `a2a-server` `pairing` `self-restart`。
- 每个 task 结束提交一次,commit message 尾行:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: SubsystemSupervisor

**Files:**
- Create: `src/daemon/subsystems.ts`
- Test: `src/daemon/subsystems.test.ts`

**Interfaces:**
- Produces: `SubsystemState`(`'ok' | 'degraded' | 'off'`)、`SubsystemStatus { name; state; error?; sinceIso }`、`class SubsystemSupervisor { constructor(log: (tag: string, line: string) => void); start<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined>; statuses(): SubsystemStatus[]; degraded(): SubsystemStatus[] }`。后续所有 task 依赖这些确切名字。

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/subsystems.test.ts
import { describe, it, expect } from 'vitest'
import { SubsystemSupervisor } from './subsystems'

const noopLog = () => {}

describe('SubsystemSupervisor', () => {
  it('value ⇒ ok, returns the value', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    const v = await sup.start('a', () => ({ x: 1 }))
    expect(v).toEqual({ x: 1 })
    expect(sup.statuses()).toMatchObject([{ name: 'a', state: 'ok' }])
    expect(sup.statuses()[0]!.sinceIso).toMatch(/^\d{4}-/)
  })

  it('null/undefined ⇒ off, returns undefined', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    expect(await sup.start('a', () => null)).toBeUndefined()
    expect(await sup.start('b', () => undefined)).toBeUndefined()
    expect(sup.statuses().map(s => s.state)).toEqual(['off', 'off'])
    expect(sup.degraded()).toEqual([])
  })

  it('sync throw and async reject ⇒ degraded with message only, never propagates', async () => {
    const lines: string[] = []
    const sup = new SubsystemSupervisor((tag, line) => lines.push(`${tag} ${line}`))
    expect(await sup.start('boom', () => { throw new Error('bind EADDRINUSE') })).toBeUndefined()
    expect(await sup.start('boom2', async () => { throw new Error('late') })).toBeUndefined()
    expect(sup.degraded()).toMatchObject([
      { name: 'boom', state: 'degraded', error: 'bind EADDRINUSE' },
      { name: 'boom2', state: 'degraded', error: 'late' },
    ])
    expect(lines.some(l => l.startsWith('SUBSYS') && l.includes('boom'))).toBe(true)
  })

  it('non-Error throw is stringified', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    await sup.start('weird', () => { throw 'plain string' })
    expect(sup.degraded()[0]!.error).toBe('plain string')
  })

  it('duplicate start(name) throws — programming error, fail fast', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    await sup.start('dup', () => 1)
    await expect(sup.start('dup', () => 2)).rejects.toThrow(/duplicate/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/daemon/subsystems.test.ts`
Expected: FAIL — cannot resolve `./subsystems`

- [ ] **Step 3: Write the implementation**

```ts
// src/daemon/subsystems.ts
/**
 * SubsystemSupervisor — 可选子系统的启动降级边界
 * (spec docs/superpowers/specs/2026-08-17-subsystem-degraded-boot-design.md)。
 *
 * 只包"允许失败"的子系统;核心链(internal-api/bootstrap 核心/pipeline/
 * ilink/polling)保持朴素顺序代码,失败照旧拒绝启动。状态只在内存——
 * 每次启动重新推导,没有陈旧状态;刻意不复用 health/incident-store
 * (那是连接健康的领域模型,Dependency/FailureKind 枚举不适配子系统名)。
 */
export type SubsystemState = 'ok' | 'degraded' | 'off'

export interface SubsystemStatus {
  name: string
  state: SubsystemState
  /** 仅 degraded:err.message 一行摘要;完整 stack 走 log('SUBSYS')。 */
  error?: string
  sinceIso: string
}

export class SubsystemSupervisor {
  private readonly entries = new Map<string, SubsystemStatus>()
  constructor(private readonly log: (tag: string, line: string) => void) {}

  /**
   * 语义(spec §1):fn 抛错 ⇒ degraded + 返回 undefined,绝不外抛;
   * fn 返回 null/undefined ⇒ off(未配置,沿用 "undefined ⇒ 惰性" 约定);
   * 其余 ⇒ ok,原样返回。同名重复 start 是编程错误,直接 throw。
   */
  async start<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    if (this.entries.has(name)) {
      throw new Error(`SubsystemSupervisor: duplicate start('${name}')`)
    }
    const sinceIso = new Date().toISOString()
    try {
      const value = await fn()
      if (value === null || value === undefined) {
        this.entries.set(name, { name, state: 'off', sinceIso })
        return undefined
      }
      this.entries.set(name, { name, state: 'ok', sinceIso })
      return value
    } catch (err) {
      // 保护机制不能成为新的故障源:这个分支只做内存写 + log。
      const message = err instanceof Error ? err.message : String(err)
      this.entries.set(name, { name, state: 'degraded', error: message, sinceIso })
      this.log('SUBSYS', `${name} failed to start — running degraded: ${
        err instanceof Error ? (err.stack ?? message) : message}`)
      return undefined
    }
  }

  statuses(): SubsystemStatus[] { return [...this.entries.values()] }
  degraded(): SubsystemStatus[] { return this.statuses().filter(s => s.state === 'degraded') }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/daemon/subsystems.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/daemon/subsystems.ts src/daemon/subsystems.test.ts
git commit -m "feat(daemon): SubsystemSupervisor — degraded-boot state table (spec 2026-08-17)"
```

---

### Task 2: main.ts 可选 lifecycle 走 supervisor

**Files:**
- Modify: `src/daemon/main.ts`(supervisor 创建 ~`:144`;customer-review 块 `:362-374`;register 块 `:409-425`)

**Interfaces:**
- Consumes: Task 1 的 `SubsystemSupervisor`。
- Produces: `bootDaemon` 作用域内的 `const sup: SubsystemSupervisor`(Task 3/4/5 直接使用这个变量名)。

- [ ] **Step 1: 创建 supervisor**

`src/daemon/main.ts` 顶部 import 区加:

```ts
import { SubsystemSupervisor } from './subsystems'
```

在 `const lc = new LifecycleSet(...)`(`:144`)之后加:

```ts
// Subsystem degraded-boot (spec 2026-08-17) — 只包可选子系统;核心链不经它。
const sup = new SubsystemSupervisor((t, l) => log(t, l))
```

- [ ] **Step 2: 收编 customer-review**

把 `:362-374` 的:

```ts
    const customerReview = await startCustomerReviewRuntime({
      stateDir,
      db,
      registry: boot.registry,
      defaultProviderId: boot.defaultProviderId,
      log: (tag, line) => log(tag, line),
    })
    if (customerReview) {
      internalApi.setCustomerReview(customerReview.service)
      lc.register(customerReview)
    }
```

改为(原有"返回 null ⇒ 可选"姿势由 supervisor 的 null ⇒ off 承接;runtime 自己 throw 则落 degraded):

```ts
    const customerReview = await sup.start('customer-review', () => startCustomerReviewRuntime({
      stateDir,
      db,
      registry: boot.registry,
      defaultProviderId: boot.defaultProviderId,
      log: (tag, line) => log(tag, line),
    }))
    if (customerReview) {
      internalApi.setCustomerReview(customerReview.service)
      lc.register(customerReview)
    }
```

- [ ] **Step 3: 包 5 个可选 register(保持注册相对顺序逐字不变)**

把 `:409-425` 的 register 块:

```ts
    lc.register(registerCompanionPush(wired.companionPushDeps))
    lc.register(registerCompanionIntrospect(wired.companionIntrospectDeps))
    const ingestLc = registerIngest(wired.companionIngestDeps)
    lc.register(ingestLc)
    wireRef(wired.refs.ingestNudge, ingestLc.nudge)   // inbound path nudges ingestion on fresh activity
    const guardLc = registerGuard(wired.guardDeps); wireRef(wired.refs.guard, guardLc); lc.register(guardLc)
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wireRef(wired.refs.polling, pollingLc); lc.register(pollingLc); pollingLcRef = pollingLc
```

改为(sessions/ilink/polling 是核心链,**不包**):

```ts
    const pushLc = await sup.start('companion.push', () => registerCompanionPush(wired.companionPushDeps))
    if (pushLc) lc.register(pushLc)
    const introspectLc = await sup.start('companion.introspect', () => registerCompanionIntrospect(wired.companionIntrospectDeps))
    if (introspectLc) lc.register(introspectLc)
    const ingestLc = await sup.start('companion.ingest', () => registerIngest(wired.companionIngestDeps))
    if (ingestLc) {
      lc.register(ingestLc)
      wireRef(wired.refs.ingestNudge, ingestLc.nudge)   // inbound path nudges ingestion on fresh activity
    }
    const guardLc = await sup.start('guard', () => registerGuard(wired.guardDeps))
    if (guardLc) { wireRef(wired.refs.guard, guardLc); lc.register(guardLc) }
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wireRef(wired.refs.polling, pollingLc); lc.register(pollingLc); pollingLcRef = pollingLc
```

紧随其后的 mailbox 块:

```ts
    if (boot.mailboxPollerDeps) lc.register(registerMailboxPoller(boot.mailboxPollerDeps))
```

改为(deps 缺失 ⇒ fn 返回 undefined ⇒ off,spec §2a):

```ts
    const mailboxLc = await sup.start('mailbox-poller',
      () => boot.mailboxPollerDeps ? registerMailboxPoller(boot.mailboxPollerDeps) : undefined)
    if (mailboxLc) lc.register(mailboxLc)
```

- [ ] **Step 4: Typecheck + 回归**

Run: `bunx tsc --noEmit`
Expected: 0 errors
Run: `bunx vitest run --config vitest.e2e.config.ts src/daemon/__e2e__/internal-api-tier-authz.e2e.test.ts`
Expected: PASS(核心链行为未变的抽样回归;全量 e2e 在 Task 7 跑)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(daemon): optional lifecycles boot through SubsystemSupervisor"
```

---

### Task 3: /v1/health 暴露 subsystems

**Files:**
- Modify: `src/daemon/internal-api/schema.ts:18-27`(HealthResponse)
- Modify: `src/daemon/internal-api/types.ts`(InternalApiDeps,`incidents?` 字段附近)
- Modify: `src/daemon/internal-api/routes.ts:75-87`(GET /v1/health)
- Modify: `src/daemon/main.ts:213-258`(registerInternalApi 调用)

**Interfaces:**
- Consumes: Task 1 的 `SubsystemStatus`;Task 2 的 `sup`。
- Produces: `GET /v1/health` 响应新增 `subsystems: SubsystemStatus[]`(Task 6 的 e2e 断言依赖字段名 `subsystems` 与 `state: 'degraded'`)。

- [ ] **Step 1: schema.ts**

`HealthResponse` 定义处加:

```ts
export const SubsystemStatusSchema = z.object({
  name: z.string(),
  state: z.enum(['ok', 'degraded', 'off']),
  error: z.string().optional(),
  sinceIso: z.string(),
})

export const HealthResponse = z.object({
  ok: z.boolean(),
  daemon_pid: z.number(),
  // Ops fields (added with the admin self-diagnosis tools). Optional so older
  // consumers and the minimal-deps path still validate.
  turns_store_wired: z.boolean().optional(),
  sessions_live: z.number().optional(),
  heartbeat_fresh: z.boolean().nullable().optional(),
  // Subsystem degraded-boot (spec 2026-08-17) — 启动降级状态表。
  subsystems: z.array(SubsystemStatusSchema).optional(),
})
```

- [ ] **Step 2: types.ts**

`InternalApiDeps` 里(`incidents?` 附近)加:

```ts
  /**
   * Subsystem degraded-boot (spec 2026-08-17) — supervisor 状态表快照,
   * GET /v1/health 的 `subsystems` 字段。undefined ⇒ 字段输出空数组
   * (minimal-deps 测试路径)。
   */
  subsystems?: () => import('../subsystems').SubsystemStatus[]
```

- [ ] **Step 3: routes.ts**

`'GET /v1/health'` 的 body 加一行:

```ts
        heartbeat_fresh: deps.heartbeatFresh?.() ?? null,
        subsystems: deps.subsystems?.() ?? [],
```

- [ ] **Step 4: main.ts**

`registerInternalApi({...})` 参数里(`heartbeatFresh` 一行之后)加:

```ts
      // Subsystem degraded-boot (spec 2026-08-17) — sup 在本调用之前创建,
      // 直接传引用,无需 thunk-over-bootRef 姿势。
      subsystems: () => sup.statuses(),
```

- [ ] **Step 5: Typecheck + 回归**

Run: `bunx tsc --noEmit && bunx vitest run src/daemon/internal-api/`
Expected: 0 errors,internal-api 单测全绿(行为断言在 Task 6 的 e2e 落地)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/schema.ts src/daemon/internal-api/types.ts src/daemon/internal-api/routes.ts src/daemon/main.ts
git commit -m "feat(internal-api): GET /v1/health exposes subsystem degraded-boot statuses"
```

---

### Task 4: buildBootstrap 可选 wire 块走 supervisor

**Files:**
- Modify: `src/daemon/bootstrap/types.ts`(BootstrapDeps + Bootstrap['a2aDeps'])
- Modify: `src/daemon/bootstrap/index.ts`(knowledge `:406-554`;self-restart `:811-822`;social `:984-1006`;a2a `:1008-1023`;pairing `:1033-1041`;return `:1114-1132`)
- Modify: `src/daemon/main.ts`(buildBootstrap 调用 + `setA2A` 门)

**Interfaces:**
- Consumes: Task 1 的 `SubsystemSupervisor`;Task 2 的 `sup`。
- Produces: `BootstrapDeps.supervisor: SubsystemSupervisor`(必传);`Bootstrap.a2aDeps` 变为可选。

- [ ] **Step 1: types.ts**

`BootstrapDeps` 加必传字段:

```ts
  /**
   * Subsystem degraded-boot (spec 2026-08-17) — 可选 wire 块(knowledge/
   * social/a2a-server/pairing/self-restart)经它拉起;失败 ⇒ 对应产物
   * undefined,类型上等同"未配置"。核心块不经它。
   */
  supervisor: import('../subsystems').SubsystemSupervisor
```

`Bootstrap` 的 `a2aDeps`(`:221`)改为可选:`a2aDeps?: { ... }`(结构不动,只加 `?`),doc comment 补一句:`undefined ⇔ a2a-server 子系统降级(wireA2aServer 抛错)`。

- [ ] **Step 2: index.ts — knowledge 块**

`buildBootstrap` 开头(`hydrateClaudeAuthEnvFromUserSettings` 之后)加 `const sup = deps.supervisor`。

`:406-554` 现状:

```ts
  let knowledge: Bootstrap['knowledge']
  if (configuredAgent.knowledge_enabled) {
    /* …块体:knowledgeStore/semanticSearch/embedder/timer 构造… */
  } else {
    deps.log('BOOT', 'knowledge: disabled (knowledge_enabled not set)')
  }
```

改为(块体逐字搬进 fn;唯一新增是部分构造清理,spec §2b):

```ts
  const knowledge: Bootstrap['knowledge'] = await sup.start('knowledge', async () => {
    if (!configuredAgent.knowledge_enabled) {
      deps.log('BOOT', 'knowledge: disabled (knowledge_enabled not set)')
      return undefined
    }
    /* …原 if 块体逐字搬入,直到 knowledgeStore 构造完成的那一行为止… */
    try {
      /* …块体其余部分(semanticSearch/embedder/runKnowledgeAdapter/
         setTimeout×2/setInterval),原样… */
      return {
        store: knowledgeStore,
        search: semanticSearch,
        ...(embedder ? { embedder, embedQuery: (t: string) => embedder.embed([t]).then(v => v[0]!) } : {}),
        graph: makeGraphQueryApi(knowledgeStore),
        facts: makeFactsApi(knowledgeStore),
        person: makePersonApi(knowledgeStore),
      }
    } catch (err) {
      // 部分构造清理:store 已开,后续失败必须关掉再冒错,否则 sqlite 句柄
      // 泄漏到 daemon 生命周期之外(main.ts shutdown 只关 boot.knowledge)。
      try { knowledgeStore.close() } catch { /* best-effort */ }
      throw err
    }
  })
```

注意:原块体里 `knowledge = { ... }` 的赋值改成 `return { ... }`(字段原样);catch 里不需要关 embedder——它在 try 内构造,构造失败即不存在,构造成功后剩余步骤(闭包定义、timer)不会 throw。

- [ ] **Step 3: index.ts — self-restart**

`:811-822` 的 `const wiredSelfRestart = await wireSelfRestart({...})` 改为:

```ts
  const wiredSelfRestart = (await sup.start('self-restart', () => wireSelfRestart({
    requestRestart: deps.requestRestart,
    anyInFlight: () => sessionManager.anyInFlight(),
    busy: () => busyRegistry.busy(),
    lastPollSuccessAgoMs: (nowMs) => {
      try {
        const at = health?.health.get('wechat').lastSuccessAt ?? null
        return at === null ? null : nowMs - at
      } catch { return null }
    },
    log: deps.log,
  }))) ?? null
```

(wireSelfRestart 在 requestRestart 未传时返回 null ⇒ off,语义自然对齐。)

- [ ] **Step 4: index.ts — social**

`:984-1006` 改为(inert 兜底对象承接降级,下游 `socialWiring.onIntent` 等访问全部照旧;`SocialWiring` 的 handler 字段类型本就含 undefined):

```ts
  // 降级兜底:social 抛错时的 inert wiring — 与 wireSocial 未配置时的内部
  // 状态同形(全 handler undefined),下游 a2a/mailbox/return 的门原样生效。
  const inertSocialWiring: import('./wire-social').SocialWiring = {
    onIntent: undefined, onEcho: undefined, onReveal: undefined, onLetter: undefined,
    resumeForaging: () => {},
  }
  const socialWiring = (await sup.start('social', async () => {
    const w = await wireSocial({
      /* …原参数逐字不动… */
    })
    // 未配置 / 无 cheapEval ⇒ wireSocial 返回 inert 对象(social 字段缺席)
    // ⇒ 映射为 null ⇒ supervisor 记 off。
    return w.social ? w : null
  })) ?? inertSocialWiring
```

- [ ] **Step 5: index.ts — a2a-server + pairing**

`:1008-1023` 改为:

```ts
  const a2aWiring = await sup.start('a2a-server', () => wireA2aServer({
    log: deps.log,
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    a2aClient,
    a2aEventsStore,
    dispatchDelegate,
    resolveOperatorChatId,
    sendAssistantText,
    onIntent: socialWiring.onIntent,
    onEcho: socialWiring.onEcho,
    onReveal: socialWiring.onReveal,
    onLetter: socialWiring.onLetter,
  }))
  const a2aDeps = a2aWiring?.a2aDeps
  a2aServer = a2aWiring?.a2aServer ?? null
```

(`a2a-server` 在 a2a_listen 未配置时仍记 ok——wireA2aServer 总是返回 wiring 对象,a2aDeps 服务出站 /v1/a2a/send;监听器开关本就写在 a2a-info.json。spec §1 的 off 规则不受影响。)

`:1033-1041` 的 pairing 改为(wirePairing 无 relays 时返回 undefined ⇒ off):

```ts
  const pairingEngine = await sup.start('pairing', () => wirePairing({
    stateDir: deps.stateDir,
    configuredAgent,
    a2aRegistry,
    selfId,
    url: a2aServer ? a2aServer.baseUrl() : undefined,
    notify: (msg) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, msg) },
    log: deps.log,
  }))
```

`socialWiring.resumeForaging()`(`:1049`)保留原样(inert 兜底是 no-op)。

- [ ] **Step 6: index.ts — return 对象**

`:1114-1132` 附近,`a2aDeps,` 改为 `...(a2aDeps ? { a2aDeps } : {}),`;其余字段(`a2aServer` 已是 `| null`、social/pairing/knowledge 的展开门)不动。

- [ ] **Step 7: 消费方加门**

Run: `grep -rn "\.a2aDeps" --include="*.ts" src cli.ts | grep -v "bootstrap/" | grep -v test`
对每个命中处,`boot.a2aDeps` 的消费加 `if (boot.a2aDeps)` 门。已知一处:`src/daemon/main.ts:351` 的 `internalApi.setA2A(boot.a2aDeps)` 改为:

```ts
    if (boot.a2aDeps) internalApi.setA2A(boot.a2aDeps)
```

main.ts 的 `buildBootstrap({...})` 调用(`:261`)加 `supervisor: sup,`。

- [ ] **Step 8: 更新测试侧 buildBootstrap 调用方**

Run: `grep -rln "buildBootstrap(" --include="*.test.ts" src eval`
每个命中文件的调用参数加:

```ts
      supervisor: new SubsystemSupervisor(() => {}),
```

(import 自 `src/daemon/subsystems`,相对路径按文件位置。)

- [ ] **Step 9: Typecheck + 回归**

Run: `bunx tsc --noEmit && bunx vitest run src/daemon/bootstrap/`
Expected: 0 errors,bootstrap 相关单测全绿

- [ ] **Step 10: Commit**

```bash
git add src/daemon/bootstrap/ src/daemon/main.ts src/daemon/subsystems.ts $(git diff --name-only | grep test)
git commit -m "feat(bootstrap): optional wire blocks boot through SubsystemSupervisor"
```

---

### Task 5: 管理员降级汇总消息

**Files:**
- Modify: `src/daemon/main.ts:428-431`(`didStartup = true` 之前的日志块之后)

**Interfaces:**
- Consumes: Task 2 的 `sup`;main.ts 既有的 `ilink.sendMessage` / `resolveAdminChatId` / `loadAccess` / `loadCompanionConfig`(均已 import)。
- Produces: degraded 非空时,管理员 chat 收到一条以 `⚠️ 本次启动有` 开头、含各子系统名的消息(Task 6 断言依赖这两点)。

- [ ] **Step 1: 实现**

`didStartup = true`(`:431`)之前插入:

```ts
    // Subsystem degraded-boot (spec 2026-08-17 §3) — 启动完成后的一次性
    // 管理员汇总。只报 degraded(off 是常态,不扰人);发送失败只落日志,
    // 绝不影响启动结果。
    const degradedSubsystems = sup.degraded()
    if (degradedSubsystems.length > 0) {
      log('SUBSYS', `boot completed degraded: ${degradedSubsystems.map(d => `${d.name}(${d.error ?? '?'})`).join(', ')}`)
      const adminChatId = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      if (adminChatId) {
        const lines = degradedSubsystems.map(d => `- ${d.name}:${d.error ?? 'unknown'}`).join('\n')
        void ilink.sendMessage(adminChatId,
          `⚠️ 本次启动有 ${degradedSubsystems.length} 个子系统未能启动:\n${lines}\n核心收发不受影响;重启守护进程可重试。`,
        ).catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors(行为断言在 Task 6)

- [ ] **Step 3: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(daemon): one-shot admin summary when boot completes degraded"
```

---

### Task 6: e2e — 可选子系统失败,bot 照常服务

**Files:**
- Create: `src/daemon/__e2e__/degraded-boot.e2e.test.ts`

**Interfaces:**
- Consumes: harness 的 `startTestDaemon({ stateDirOverride })`(caller 拥有 stateDir,可预写 agent-config.json);`/v1/health` 的 `subsystems` 字段(Task 3);管理员汇总消息文案(Task 5)。

注入手法:真实故障,零新缝——先占住一个端口,再把 `a2a_listen` 指向它,`wireA2aServer` 的 `Bun.serve` 抛 EADDRINUSE ⇒ `a2a-server` 降级。改动前这正是"整个 daemon 拒启"的场景。

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/__e2e__/degraded-boot.e2e.test.ts
// 可选子系统(a2a-server)启动失败 ⇒ daemon 照常服务(spec 2026-08-17):
// 核心收发不受影响、/v1/health 报 degraded、管理员收到一条汇总、shutdown 干净。
// 故障注入是真实的 EADDRINUSE:先占端口,再让 a2a_listen 指向它。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTestDaemon } from './harness'

describe('e2e: degraded boot — optional subsystem failure does not take the bot down', () => {
  it('a2a EADDRINUSE ⇒ boot ok, replies flow, health reports degraded, admin notified', async () => {
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('occupied') })
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-degraded-'))
    mkdirSync(join(stateDir, 'accounts'), { recursive: true })
    // a2a_listen 指向已被占用的端口 — harness 只在 opts.agentConfig 给出时写
    // agent-config.json,这里预写的文件在 stateDirOverride 模式下原样生效。
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      a2a_listen: { host: '127.0.0.1', port: blocker.port },
    }, null, 2))
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | null = null
    try {
      // 1. boot 正常 resolve — 改动前这里直接 throw EADDRINUSE。
      daemon = await startTestDaemon({
        stateDirOverride: stateDir,
        knownUsers: { chat1: 'testuser', testadmin: 'admin_user' },
        claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'hello back' } } },
      })

      // 2. 核心收发完好。
      daemon.sendText('chat1', 'hi')
      const replies = await daemon.waitForReplyTo('chat1')
      expect(replies.some(m => m.text?.includes('hello back'))).toBe(true)

      // 3. /v1/health 报 a2a-server degraded。
      const info = JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string; tokenFilePath: string }
      const token = readFileSync(info.tokenFilePath, 'utf8').trim()
      const health = await fetch(`${info.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` } })
      expect(health.status).toBe(200)
      const body = await health.json() as { subsystems: Array<{ name: string; state: string; error?: string }> }
      const a2a = body.subsystems.find(s => s.name === 'a2a-server')
      expect(a2a?.state).toBe('degraded')
      expect(a2a?.error).toBeTruthy()

      // 4. 管理员收到一条降级汇总。
      const outbound = await daemon.waitForOutbound(msgs =>
        msgs.some(m => m.chatId === 'testadmin' && !!m.text?.includes('a2a-server')))
      const summary = outbound.find(m => m.chatId === 'testadmin' && m.text?.includes('a2a-server'))
      expect(summary?.text).toContain('⚠️ 本次启动有')
    } finally {
      // 5. shutdown 干净(降级子系统未注册 lifecycle,stop 不报错)。
      await daemon?.stop()
      blocker.stop(true)
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30_000)
})
```

- [ ] **Step 2: Run test to verify it currently fails at the RIGHT step**

Run: `bunx vitest run --config vitest.e2e.config.ts src/daemon/__e2e__/degraded-boot.e2e.test.ts`
Expected: 若 Task 2-5 已全部落地 ⇒ PASS。若在 Task 2-5 之前预跑 ⇒ FAIL 于第 1 步(startTestDaemon throw EADDRINUSE)——这就是被消灭的旧行为。

- [ ] **Step 3: 修复暴露的问题(如有)**

若 PASS 直接过。若 FAIL:按失败断言回到对应 task 的文件修(常见:`resolveAdminChatId` 需要 access.admins 含 `testadmin`——harness 默认就有;或 waitForOutbound 超时 ⇒ 检查 Task 5 的插入位置是否在 `didStartup = true` 之前、`sendMessage` 的 chatId 路由是否需要 knownUsers 预置——已在 opts 里给出)。

- [ ] **Step 4: Commit**

```bash
git add src/daemon/__e2e__/degraded-boot.e2e.test.ts
git commit -m "test(e2e): degraded boot — a2a EADDRINUSE no longer takes the daemon down"
```

---

### Task 7: Ref 审计 + 全量回归 + 文档收尾

**Files:**
- Verify: `src/daemon/wiring/pipeline-deps.ts:369,399`
- Modify: `docs/ops/2026-06-07-reliability-backlog.md`(条目 #1)
- Modify: `docs/architecture.md`(债务登记里若含 all-or-nothing boot 相关条目则更新状态)

- [ ] **Step 1: Ref 消费方审计(spec §4)**

Run: `grep -rn "refs\.guard\.deref\|refs\.ingestNudge\.deref" --include="*.ts" src`
Expected: 0 命中(现状已是 `refs.guard.current?.current() ?? {...}` 与 `refs.ingestNudge.current?.()`,均 null 安全)。若有命中,改为 `.current ?? 兜底` 形式。

- [ ] **Step 2: 全量回归**

Run: `bunx vitest run`
Expected: 全绿(含 `test-runner-guard` / `injectable-default-seams` / `migration-order` 三个元测试)
Run: `bunx vitest run --config vitest.e2e.config.ts`
Expected: 全绿

- [ ] **Step 3: 文档收尾**

`docs/ops/2026-06-07-reliability-backlog.md` 条目 #1 标注:

```markdown
> **RESOLVED 2026-08-17** — SubsystemSupervisor(spec
> 2026-08-17-subsystem-degraded-boot-design.md):可选子系统
> (companion×3/guard/mailbox/customer-review/knowledge/social/a2a-server/
> pairing/self-restart)启动失败降级不拒启;核心链(internal-api/bootstrap
> 核心/pipeline/ilink/polling)仍 fail-fast。状态见 GET /v1/health.subsystems。
```

`docs/architecture.md` 的债务登记/主题若提及 all-or-nothing boot,同样标注 RESOLVED + spec 指针(按该文档既有的状态标注格式)。

- [ ] **Step 4: Commit**

```bash
git add docs/ops/2026-06-07-reliability-backlog.md docs/architecture.md
git commit -m "docs: mark reliability backlog #1 (all-or-nothing boot) resolved"
```
