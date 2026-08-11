# daemon busy 登记处 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自我重启的空闲判定从"用户不在"修正为"没有工作在跑":busy 登记处 + poll 新鲜度闸门,关死 A2A 委派/ingest/客户回顾/觅食扇出四类盲区,并治好 scheduler 不等在途 tick 的旧伤。

**Architecture:** 新增 `src/core/busy-registry.ts`(引用计数,永不抛);`connection-health` 补 `lastSuccessAt`;`self-restart/wire.ts` 空闲判定加两个必填信号;五个持有点各包一层 try/finally;self-restart 接线搬进 `bootstrap/wire-self-restart.ts`。

**Tech Stack:** bun + vitest(注入式,不跑真 git/不真重启),TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-11-daemon-busy-registry-design.md`

## Global Constraints

- **失败方向必须是"不动作"**:任何信号取不到(busy 未注入、lastSuccessAt 为 null、health 缺失)⇒ 不空闲 ⇒ 不重启。
- busy 登记处**永不抛**;release 幂等;所有 hold/release 包 try/finally。
- 常量:`POLL_FRESH_MS = 120_000`;scheduler stop 等待上限 `4_000` ms。
- `SelfRestartDeps` 新字段是**必填**(汲取 `as never` 教训,编译器守门)。
- `bun run test`(vitest)不做类型检查 —— 每个任务末尾必须另跑 `bunx tsc --noEmit`(仓库根)。
- 跑测试用 `bun run test <file>`,不要 `bunx vitest`(node 会因 bun:sqlite 报错)。
- 既有基线红:`src/daemon/bootstrap.test.ts` social mailbox 超时,与本计划无关,不要修也不要被它吓到。
- TDD:每步先写测试跑 FAIL,再实现跑 PASS,commit。
- daemon↛cli 分层不可破;新接线进 `bootstrap/wire-*.ts` 不进 `bootstrap/index.ts`。

---

### Task 1: busy 登记处(纯模块)

**Files:**
- Create: `src/core/busy-registry.ts`
- Test: `src/core/busy-registry.test.ts`

**Interfaces:**
- Produces: `makeBusyRegistry(): BusyRegistry`,`BusyRegistry = { hold(label: string): () => void; busy(): boolean }`。后续任务全部消费这两个方法。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { makeBusyRegistry } from './busy-registry'

describe('makeBusyRegistry', () => {
  it('初始不忙', () => {
    expect(makeBusyRegistry().busy()).toBe(false)
  })
  it('hold 之后忙,release 之后不忙', () => {
    const r = makeBusyRegistry()
    const release = r.hold('test')
    expect(r.busy()).toBe(true)
    release()
    expect(r.busy()).toBe(false)
  })
  it('多个 holder:全部释放才不忙', () => {
    const r = makeBusyRegistry()
    const a = r.hold('a'); const b = r.hold('b')
    a()
    expect(r.busy()).toBe(true)
    b()
    expect(r.busy()).toBe(false)
  })
  it('release 幂等:重复调用不把别人的 token 放掉', () => {
    const r = makeBusyRegistry()
    const a = r.hold('a'); const b = r.hold('b')
    a(); a(); a()
    expect(r.busy()).toBe(true)  // b 还在
    b()
    expect(r.busy()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**(模块不存在)

Run: `bun run test src/core/busy-registry.test.ts` — Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
/**
 * busy-registry — "有工作在跑"的统一登记处(spec 2026-08-11 §1)。
 *
 * 自我重启的空闲判定原本只看 SessionManager 的会话 —— 它建模的是"用户
 * 在不在",而该建模的是"工作在不在"。所有不经 SessionManager 的长任务
 * (A2A 委派、ingest/introspect tick、客户回顾、觅食扇出)干活时在这里
 * 各持一个 token,空闲判定读 busy() 即可,一个概念覆盖整类。
 *
 * 永不抛;release 幂等。label 只存不读 —— 将来做诊断接口时再暴露。
 */
export interface BusyRegistry {
  /** 拿一个 token;返回 release。release 幂等,多次调用无害。 */
  hold(label: string): () => void
  busy(): boolean
}

export function makeBusyRegistry(): BusyRegistry {
  const holders = new Map<symbol, string>()
  return {
    hold(label) {
      const key = Symbol(label)
      holders.set(key, label)
      return () => { holders.delete(key) }
    },
    busy() {
      return holders.size > 0
    },
  }
}
```

- [ ] **Step 4: 跑测试确认 PASS**,再跑 `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/core/busy-registry.ts src/core/busy-registry.test.ts
git commit -m "feat(core): busy 登记处 —— 不经 SessionManager 的长任务的统一在途信号"
```

---

### Task 2: connection-health 补 lastSuccessAt

**Files:**
- Modify: `src/daemon/health/connection-health.ts`
- Test: `src/daemon/health/connection-health.test.ts`(追加用例)

**Interfaces:**
- Consumes: 既有 `makeConnectionHealth({now})`。
- Produces: `HealthState.lastSuccessAt: number | null` —— `recordSuccess` 置为 now,`recordFailure` 不动它(跨失败保留),初始 null。Task 6 的接线用 `health.get('wechat').lastSuccessAt` 计算新鲜度。

- [ ] **Step 1: 写失败测试**(追加到既有 describe 或新开一个)

```ts
describe('lastSuccessAt(自我重启的唤醒闸门,spec 2026-08-11 §4)', () => {
  it('初始为 null', () => {
    const h = makeConnectionHealth({ now: () => 1000 })
    expect(h.get('wechat').lastSuccessAt).toBeNull()
  })
  it('recordSuccess 置为当时时刻', () => {
    let t = 1000
    const h = makeConnectionHealth({ now: () => t })
    h.recordSuccess('wechat')
    expect(h.get('wechat').lastSuccessAt).toBe(1000)
    t = 5000
    h.recordSuccess('wechat')
    expect(h.get('wechat').lastSuccessAt).toBe(5000)
  })
  it('失败不清掉上一次成功时刻 —— 跨失败保留', () => {
    let t = 1000
    const h = makeConnectionHealth({ now: () => t })
    h.recordSuccess('wechat')
    t = 2000
    h.recordFailure('wechat', new Error('x'))
    h.recordFailure('wechat', new Error('y'))
    expect(h.get('wechat').lastSuccessAt).toBe(1000)
  })
})
```

- [ ] **Step 2: 跑 FAIL** → **Step 3: 实现**

`HealthState` 加字段 `lastSuccessAt: number | null`;`fresh()` 返回值加 `lastSuccessAt: null`;`recordSuccess` 现在是 `states.set(dep, fresh())` —— 改为保留时间戳:

```ts
recordSuccess(dep) {
  const next = fresh()
  next.lastSuccessAt = deps.now()
  states.set(dep, next)
},
```

`recordFailure` 不动 `lastSuccessAt`(它 mutate 现有 state,天然保留)。

- [ ] **Step 4: 跑该文件全部用例 PASS**(确认没破坏既有断言)+ `bunx tsc --noEmit`

注意:tsc 可能暴露别处构造 `HealthState` 字面量的地方(如测试 fixture)缺新字段 —— 补上 `lastSuccessAt: null` 即可,不改语义。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/health/
git commit -m "feat(health): HealthState.lastSuccessAt —— 唤醒闸门的数据源,跨失败保留"
```

---

### Task 3: 空闲判定接入两个新信号

**Files:**
- Modify: `src/daemon/self-restart/wire.ts`
- Test: `src/daemon/self-restart/wire.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `busy()`(以 `() => boolean` 形态注入,不 import 登记处本体)。
- Produces: `SelfRestartDeps` 新增**必填** `busy: () => boolean` 与 `lastPollSuccessAgoMs: (nowMs: number) => number | null`;导出 `POLL_FRESH_MS = 120_000`。Task 6 接线时必须传这两个字段(必填,漏传编译不过)。

- [ ] **Step 1: 写失败测试**(先在 `setup()` 基础字面量补默认值,否则全文件编译不过)

`setup()` 增加:
```ts
    busy: () => false,
    lastPollSuccessAgoMs: () => 0,
```

新用例:
```ts
  // spec 2026-08-11 §5 —— busy 登记处
  it('登记处有工作在跑 ⇒ 不重启,且不 spawn git', async () => {
    let spawned = 0
    const { restarts, check } = setup({ busy: () => true, readHead: async () => { spawned++; return 'bbb222' } })
    await check()
    expect(restarts).toEqual([])
    expect(spawned).toBe(0)
  })
  it('busy() 抛异常 ⇒ 吞掉,不重启', async () => {
    const { restarts, check } = setup({ busy: () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })
  it('git 调用期间登记处出现工作 ⇒ 临门复查拦下', async () => {
    let b = false
    const { restarts, check } = setup({ busy: () => b, readHead: async () => { b = true; return 'bbb222' } })
    await check()
    expect(restarts).toEqual([])
  })

  // spec 2026-08-11 §4 —— poll 新鲜度(唤醒闸门)
  it('poll 从未成功(null)⇒ 不重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => null })
    await check()
    expect(restarts).toEqual([])
  })
  it('上次 poll 成功已超过 2 分钟(如睡眠唤醒)⇒ 不重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => 120_001 })
    await check()
    expect(restarts).toEqual([])
  })
  it('恰好 2 分钟整 ⇒ 仍算新鲜,重启', async () => {
    const { restarts, check } = setup({ lastPollSuccessAgoMs: () => 120_000 })
    await check()
    expect(restarts).toHaveLength(1)
  })
```

- [ ] **Step 2: 跑 FAIL** → **Step 3: 实现**

`wire.ts`:
```ts
/** poll 新鲜度要求:最近这么久内 wechat poll 成功过(spec 2026-08-11 §4)。 */
export const POLL_FRESH_MS = 120_000
```
`SelfRestartDeps` 加(必填,带 doc 注释说明失败方向):
```ts
  busy: () => boolean
  /** 最近一次 wechat poll 成功距今 ms;null = 从未成功/取不到 ⇒ 不重启。 */
  lastPollSuccessAgoMs: (nowMs: number) => number | null
```
`check()` 内,把既有 `const idle = !deps.anyInFlight() && deps.quietFor(nowMs) >= IDLE_QUIET_MS` 扩为:
```ts
      const ago = deps.lastPollSuccessAgoMs(nowMs)
      const fresh = ago !== null && ago <= POLL_FRESH_MS
      const idle = !deps.anyInFlight() && !deps.busy() && deps.quietFor(nowMs) >= IDLE_QUIET_MS && fresh
```
临门复查同步扩为四条件(`nowMs2` 重新取 now):
```ts
      const nowMs2 = deps.now()
      const ago2 = deps.lastPollSuccessAgoMs(nowMs2)
      if (deps.anyInFlight() || deps.busy() || deps.quietFor(nowMs2) < IDLE_QUIET_MS || ago2 === null || ago2 > POLL_FRESH_MS) return
```

- [ ] **Step 4: 跑 wire.test.ts 全部 PASS** + `bunx tsc --noEmit`

tsc 此时会在 `bootstrap/index.ts` 报缺字段 —— **本任务顺手补上临时接线**(真正搬家在 Task 6):在既有 `makeSelfRestartCheck({...})` 调用处加 `busy: () => false, lastPollSuccessAgoMs: () => null`,并加一行注释 `// TEMP: Task 6 搬家时接真信号;null ⇒ 永不重启,失败方向安全`。**注意这会让自我重启临时失效(安全侧)**,Task 6 恢复。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/self-restart/ src/daemon/bootstrap/index.ts
git commit -m "feat(self-restart): 空闲判定加 busy 登记处 + poll 新鲜度两信号(暂以安全占位接线)"
```

---

### Task 4: 四个持有点

**Files:**
- Modify: `src/daemon/internal-api/index.ts`(分发层)、`src/daemon/internal-api/types.ts`
- Modify: `src/daemon/internal-api/routes-customer-review.ts`
- Modify: `src/daemon/bootstrap/delegate.ts`
- Modify: `src/daemon/bootstrap/wire-social.ts`
- Test: 各自邻近的既有测试文件追加用例

**Interfaces:**
- Consumes: 均以 `holdBusy?: (label: string) => (() => void)` 可选依赖形态注入(缺省 no-op,测试/嵌入零成本)。**统一这个名字**。
- Produces: 无新导出;Task 6 接线时把 `boot.holdBusy` 传进这四处。

- [ ] **Step 1: internal-api 分发层** —— `types.ts` 加可选 `holdBusy?: (label: string) => (() => void)`(doc 注释:非 GET 认证请求 await 期间持有);`index.ts` 在既有 `markInboundActivity` 打点旁,包住 handler 执行:

```ts
    // 非 GET 认证请求 await 期间持 busy token(spec 2026-08-11 §2)——
    // 打点只能证明"刚才有人来过",token 才能证明"现在还有活没干完"。
    const releaseBusy = method !== 'GET' ? (() => { try { return deps.holdBusy?.(`api:${routeKey}`) } catch { return undefined } })() : undefined
    try {
      /* 既有的 handler 调用 */
    } finally {
      try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
    }
```
测试(internal-api 既有测试文件):非 GET 期间 `holdBusy` 被调、handler resolve 后 release 被调;GET 全程不调;`holdBusy` 抛异常不影响请求。

- [ ] **Step 2: 客户回顾** —— `routes-customer-review.ts` 的 `launch()`:`inFlight.add(id)` 旁 `const release = deps.holdBusy?.('customer-review') `,既有 `.finally(() => inFlight.delete(id))` 扩为同时 `release?.()`。`CustomerReviewRoutesDeps`(或该文件的 deps 类型)加可选 `holdBusy`。测试:launch 后 busy 持有、finally 后释放(用注入的假 registry 断言)。

- [ ] **Step 3: A2A 委派** —— `delegate.ts` 的 `dispatchDelegate` 整体 try/finally 包 hold(label `'a2a-delegate'`),deps 加可选 `holdBusy`。测试:委派执行期间为真、结束(含抛异常路径)释放。

- [ ] **Step 4: 觅食扇出 + 异步应答** —— `wire-social.ts` 里构造 `social-broker` 与 `social-async-responder` 处,传 `schedule`:

```ts
      schedule: (fn) => {
        const release = holdBusy?.('social-forage')   // responder 处 label 'social-responder'
        void Promise.resolve().then(fn).finally(() => release?.())
      },
```
核实两者的 `schedule` 注入缝签名后照实调整。测试:wire-social 既有测试里断言 forage 运行期间注入的假 registry 为忙、完成后释放。

- [ ] **Step 5: 跑四处相关测试 + `bunx tsc --noEmit`** → **Step 6: Commit**

```bash
git add src/daemon/internal-api/ src/daemon/bootstrap/delegate.ts src/daemon/bootstrap/wire-social.ts
git commit -m "feat(daemon): 四个持有点 —— internal-api 非 GET / 客户回顾 / A2A 委派 / 觅食扇出"
```

---

### Task 5: scheduler 持 token + stop 等在途 tick

**Files:**
- Modify: `src/daemon/companion/scheduler.ts`
- Test: `src/daemon/companion/scheduler.test.ts`

**Interfaces:**
- Consumes: 可选 `holdBusy?`(同 Task 4 形态)。
- Produces: `stop()` 返回 `Promise<void>`(等在途 onTick,上限 `STOP_WAIT_CAP_MS = 4_000`);调用方(lifecycle 注册处)若同步用了 `stop`,改为 `void stop()` 或 await,视 `lc` 的 stop 协议而定 —— 核实 `Lifecycle` 是否本就支持异步 stop(`lc.stopAll()` 有 5s/项预算,大概率支持)。

- [ ] **Step 1: 写失败测试**:onTick 运行期间注入的假 registry 为忙;`stop()` 在 onTick 未完时等待其完成(fake timer 或受控 promise);onTick 超过 4 秒时 `stop()` 4 秒后放弃返回;onTick 抛异常时 token 仍释放。

- [ ] **Step 2: 跑 FAIL** → **Step 3: 实现**:每次触发时 `const release = holdBusy?.(label)`,记录 `current: Promise<void> | null = run().finally(release + 清 current)`;`stop()` = 清定时器 + `current ? Promise.race([current, sleep(4000)]) : resolve`。

- [ ] **Step 4: PASS + tsc + 跑 companion/ 全部测试**(确认 lifecycle 调用方兼容)→ **Step 5: Commit**

```bash
git add src/daemon/companion/
git commit -m "fix(companion): scheduler 持 busy token,stop 等在途 tick(上限 4s)—— 优雅关闭对 tick 真正优雅"
```

---

### Task 6: 接线搬家 + 真信号 + 共享常量 + 全量回归

**Files:**
- Create: `src/daemon/bootstrap/wire-self-restart.ts`
- Create: `src/core/supervised-env.ts`
- Modify: `src/daemon/bootstrap/index.ts`(削掉 self-restart 块,调 wire 函数;构造 busyRegistry 挂到 Bootstrap)
- Modify: `src/daemon/bootstrap/types.ts`(`Bootstrap` 加 `holdBusy`;`BootstrapDeps` 不变)
- Modify: `src/daemon/main.ts`、`src/cli/service-manager.ts`(常量引用)
- Test: `src/daemon/bootstrap.test.ts` 既有 self-restart 用例保持绿;新增一条钉住"真信号接上了"

**Interfaces:**
- Consumes: Task 1-5 全部。
- Produces: `wireSelfRestart(deps): { check, marker } | null`;`src/core/supervised-env.ts` 导出 `export const SUPERVISED_ENV = 'WECHAT_CC_SUPERVISED'`。

- [ ] **Step 1: 常量**:新建 `supervised-env.ts`,`main.ts` 的 `process.env.WECHAT_CC_SUPERVISED` 与 `service-manager.ts` 的两处模板字符串改用常量(模板里 `${SUPERVISED_ENV}`)。跑 `bun run test src/cli/service-manager.test.ts` 确认 plist/unit 生成内容逐字不变。

- [ ] **Step 2: 搬家**:`bootstrap/index.ts` 的 self-restart 块(`if (deps.requestRestart) {...}`,含两次 git 读、marker 构造、`makeSelfRestartCheck` 调用)整体搬进 `wire-self-restart.ts`,参数注入 `{ requestRestart, sessionManager, busy, lastPollSuccessAgoMs, log }`,index.ts 只留一次调用 + 60s tick 里那行 `void selfRestartCheck?.()` 不动。busyRegistry 在 bootstrap 构造:`const busyRegistry = makeBusyRegistry()`,`Bootstrap` 暴露 `holdBusy: busyRegistry.hold`,并把 `busy: busyRegistry.busy` 与真的 `lastPollSuccessAgoMs` 传给 wire-self-restart。

- [ ] **Step 3: 真信号**:`lastPollSuccessAgoMs` 的数据源是 health(`poll-loop.ts:399` 已 recordSuccess)。核实 health 实例在 bootstrap 可及(wire-health.ts 同目录);实现:
```ts
      lastPollSuccessAgoMs: (nowMs) => {
        try {
          const at = health?.get('wechat').lastSuccessAt ?? null
          return at === null ? null : nowMs - at
        } catch { return null }
      },
```
health 拿不到 ⇒ null ⇒ 不重启(安全侧,与 Global Constraints 一致)。同时把 Task 4 各持有点的 `holdBusy` 从 boot/main 传下去(internal-api 经 main.ts thunk:`holdBusy: (l) => bootRef?.holdBusy?.(l) ?? (() => {})`,与 `markInboundActivity` 既有模式一致)。删掉 Task 3 的 TEMP 占位注释。

- [ ] **Step 4: 新增接线测试**(`bootstrap.test.ts`,与既有 self-restart 用例相邻):`buildBootstrap` with `requestRestart` 后,`boot.holdBusy` 存在且调用后…(通过再次构造检查 busy 语义的可观察面;若 Bootstrap 不暴露 busy() 读端,则断言 holdBusy 返回可调用的 release 且不抛)。

- [ ] **Step 5: 全量** `bun run test`(worktree 内)+ `bunx tsc --noEmit`:除既有基线红外零失败。

- [ ] **Step 6: Commit**

```bash
git add src/ 
git commit -m "feat(self-restart): 接线搬进 wire-self-restart.ts,busy/poll 新鲜度接真信号,SUPERVISED 常量共享"
```
