# 连接健康:检测、降级与告警 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 连接故障时自动停掉外发与 LLM 轮次(保护账号、不烧 token),并在跨过分级阈值后用一句人话告诉主人,恢复时再说一次。

**Architecture:** 一个按依赖(`wechat` / `llm`)分别维护的两态健康机(`healthy` / `degraded`),由**真实调用的成败**驱动——不由探活驱动。状态机是纯逻辑(注入时钟、零 I/O);退避、错误分类、故障记录各自独立成小模块;门控只在两个汇合点接入(`dispatchToChat` 与入站分发)。通知按状态跳变触发,阈值按"主人能不能动手"分级。

**Tech Stack:** TypeScript + Bun,vitest 单测,既有 `makeStateStore`(写透 JSON)做持久化,既有 `notify_user` Tauri 命令做桌面通知。

**Spec:** `docs/superpowers/specs/2026-08-03-connection-health-degrade-alert-design.md`

## Global Constraints

- **断线或网络不稳时,停止外发与 LLM 轮次**——重试风暴会触发风控。这是首要目的,告警是次要目的。
- **探活永不参与门控。** 大陆用户 `google.com` 本就不通,而用 Kimi/DeepSeek/Qwen 的用户不需要代理、LLM 完全正常;拿探活做门控会把他们的 bot 静默锁死。本计划**不实现探活接线**(spec §6 是可选增强,不在本次范围)。
- **绝不探测 LLM/ilink 端点**做健康检查——真实调用就是探针。
- **"我坏了"这句话不能由坏掉的组件生成**:LLM 故障回复必须是写死的模板文案。
- **所有时长从"当前这轮连续失败中的第一次失败"起算**,一次成功即清零。
- 常量(全计划统一): `SUSPEND_AFTER_MS = 60_000`、`NOTIFY_ACTIONABLE_MS = 180_000`、`NOTIFY_NON_ACTIONABLE_MS = 900_000`、`REPEAT_ACTIONABLE_MS = 21_600_000`、`BACKOFF_BASE_MS = 2_000`、`BACKOFF_CAP_MS = 60_000`、`BACKOFF_JITTER = 0.2`。
- **健康机自身的异常必须被吞掉**——它是保护机制,绝不能成为新的故障源。
- **`bun run test`(vitest)不做类型检查** —— 每个动 .ts 的任务都要跑 `bunx tsc --noEmit`(仓库根)。
- 每任务 TDD:先测试跑 FAIL,再实现跑 PASS,commit。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/daemon/health/connection-health.ts` | 两态健康机(纯,注入时钟) |
| `src/daemon/health/backoff.ts` | 退避序列(纯) |
| `src/daemon/health/classify.ts` | 错误 → 分类 + 可操作性 + 人话文案(纯) |
| `src/daemon/health/incident-store.ts` | 故障记录持久化(滚动 20 条,写透) |
| `src/daemon/health/notify-policy.ts` | 该不该通知(纯:阈值/分级/重复/配对) |
| `src/daemon/poll-loop.ts` | 接退避 + 上报成败 + 日志折叠(修改) |
| `src/daemon/wiring/tick-bodies.ts` | 门控①:主动外发(修改) |
| `apps/desktop/src/modules/dashboard.js` | 桌面呈现:系统通知 + 上次故障横幅(修改) |

`health/` 全部是小而纯的单元,只有 poll-loop / tick-bodies / dashboard 三处是接线点。

---

### Task 1: connection-health.ts —— 两态健康机

**Files:**
- Create: `src/daemon/health/connection-health.ts`
- Test: `src/daemon/health/connection-health.test.ts`

**Interfaces:**
- Produces: `type Dependency = 'wechat' | 'llm'`;`type HealthStatus = 'healthy' | 'degraded'`;`interface HealthState { status: HealthStatus; firstFailureAt: number | null; consecutiveFailures: number; lastError: string | null }`;`makeConnectionHealth(deps: { now: () => number }): ConnectionHealth`,其中 `ConnectionHealth = { recordSuccess(dep): void; recordFailure(dep, err: unknown): void; get(dep): HealthState; shouldSuspend(dep): boolean }`。Task 2/4/5/6/7 消费。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/connection-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeConnectionHealth, SUSPEND_AFTER_MS } from './connection-health'

function at(t: { ms: number }) {
  return makeConnectionHealth({ now: () => t.ms })
}

describe('makeConnectionHealth', () => {
  it('起始是 healthy,不暂停外发', () => {
    const t = { ms: 1000 }
    const h = at(t)
    expect(h.get('wechat').status).toBe('healthy')
    expect(h.shouldSuspend('wechat')).toBe(false)
  })

  it('连续失败满 60 秒才转 degraded —— 短抖动不误伤', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('boom'))
    t.ms = SUSPEND_AFTER_MS - 1
    h.recordFailure('wechat', new Error('boom'))
    expect(h.get('wechat').status).toBe('healthy')
    expect(h.shouldSuspend('wechat')).toBe(false)

    t.ms = SUSPEND_AFTER_MS
    h.recordFailure('wechat', new Error('boom'))
    expect(h.get('wechat').status).toBe('degraded')
    expect(h.shouldSuspend('wechat')).toBe(true)
  })

  it('一次成功即清零,时长重新起算', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('a'))
    t.ms = 59_000
    h.recordSuccess('wechat')
    expect(h.get('wechat')).toMatchObject({ status: 'healthy', consecutiveFailures: 0, firstFailureAt: null })

    // 之前累计的 59 秒不能带过来
    h.recordFailure('wechat', new Error('b'))
    t.ms = 59_000 + SUSPEND_AFTER_MS - 1
    h.recordFailure('wechat', new Error('b'))
    expect(h.get('wechat').status).toBe('healthy')
  })

  it('两个依赖互不影响', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('llm', new Error('x'))
    t.ms = SUSPEND_AFTER_MS
    h.recordFailure('llm', new Error('x'))
    expect(h.get('llm').status).toBe('degraded')
    expect(h.get('wechat').status).toBe('healthy')
  })

  it('记录连续失败次数与最后错误', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', new Error('first'))
    h.recordFailure('wechat', new Error('second'))
    expect(h.get('wechat')).toMatchObject({ consecutiveFailures: 2, lastError: 'second' })
  })

  it('非 Error 的抛出物也能记录', () => {
    const t = { ms: 0 }
    const h = at(t)
    h.recordFailure('wechat', 'plain string')
    expect(h.get('wechat').lastError).toBe('plain string')
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/connection-health.test.ts`,期望红(模块不存在)。

- [ ] **Step 3: 实现** —— `src/daemon/health/connection-health.ts`:

```ts
/**
 * connection-health — 按依赖分别维护的两态健康机(spec 2026-08-03 §1)。
 *
 * 状态由 REAL CALLS 的成败驱动,不由探活驱动:真实调用是最准的探针,而且免费。
 * 探活(guard/probe.ts)只用于诊断文案,永不参与这里的判定 —— 大陆用户
 * google.com 本就不通,而用 Kimi/DeepSeek 的用户无需代理、LLM 完全正常,
 * 拿探活门控会把他们的 bot 静默锁死。
 *
 * 只有两个状态。degraded 期间该停什么由调用方决定,这里只回答"是否已确认坏了"。
 */

/** 各自独立:两者坏掉时该做的事正好相反(见 spec §1 的表)。 */
export type Dependency = 'wechat' | 'llm'

export type HealthStatus = 'healthy' | 'degraded'

export interface HealthState {
  status: HealthStatus
  /** 当前这轮连续失败的第一次失败时刻(ms);healthy 时为 null。 */
  firstFailureAt: number | null
  consecutiveFailures: number
  lastError: string | null
}

/**
 * 连续失败持续这么久才算"确认坏了"。用时间而非次数 —— 加了退避之后
 * "N 次失败"的实际时长会随参数漂移,而 60 秒始终可理解,且足以跨过
 * WiFi 切换 / VPN 重连 / 笔记本唤醒。
 */
export const SUSPEND_AFTER_MS = 60_000

export interface ConnectionHealth {
  recordSuccess(dep: Dependency): void
  recordFailure(dep: Dependency, err: unknown): void
  get(dep: Dependency): HealthState
  /** true ⇒ 调用方应停止该依赖上的外发 / LLM 轮次。 */
  shouldSuspend(dep: Dependency): boolean
}

function fresh(): HealthState {
  return { status: 'healthy', firstFailureAt: null, consecutiveFailures: 0, lastError: null }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function makeConnectionHealth(deps: { now: () => number }): ConnectionHealth {
  const states = new Map<Dependency, HealthState>()

  function stateOf(dep: Dependency): HealthState {
    let s = states.get(dep)
    if (!s) { s = fresh(); states.set(dep, s) }
    return s
  }

  return {
    recordSuccess(dep) {
      states.set(dep, fresh())
    },
    recordFailure(dep, err) {
      const s = stateOf(dep)
      const now = deps.now()
      if (s.firstFailureAt === null) s.firstFailureAt = now
      s.consecutiveFailures += 1
      s.lastError = messageOf(err)
      if (now - s.firstFailureAt >= SUSPEND_AFTER_MS) s.status = 'degraded'
    },
    get(dep) {
      return { ...stateOf(dep) }
    },
    shouldSuspend(dep) {
      return stateOf(dep).status === 'degraded'
    },
  }
}
```

- [ ] **Step 4: 跑 PASS** —— `bun run test src/daemon/health/connection-health.test.ts` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/health/connection-health.ts src/daemon/health/connection-health.test.ts
git commit -m "feat(health): 两态连接健康机 —— 连续失败 60s 转 degraded,按依赖独立"
```

---

### Task 2: backoff.ts + 接进 poll-loop

**Files:**
- Create: `src/daemon/health/backoff.ts`
- Test: `src/daemon/health/backoff.test.ts`
- Modify: `src/daemon/poll-loop.ts`(常量 `RETRY_DELAY_MS` 在 :246;catch 分支在 :378-382)
- Test: `src/daemon/poll-loop.test.ts`(既有文件,追加用例)

**Interfaces:**
- Consumes: 无(纯函数);poll-loop 的接线可选注入 Task 1 的 `ConnectionHealth`。
- Produces: `nextBackoffMs(attempt: number, opts?: { baseMs?: number; capMs?: number; jitter?: number; random?: () => number }): number`;poll-loop 新增可选 dep `health?: { recordSuccess(dep: 'wechat'): void; recordFailure(dep: 'wechat', err: unknown): void }`。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/backoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nextBackoffMs, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './backoff'

// random: () => 0.5 ⇒ 抖动系数正好为 1,便于断言确定值
const noJitter = { random: () => 0.5 }

describe('nextBackoffMs', () => {
  it('从 2 秒起指数增长,封顶 60 秒', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 20].map(a => nextBackoffMs(a, noJitter))
    expect(seq).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })

  it('封顶取正常轮询节奏 —— 重试不该比正常工作还密集', () => {
    // LONG_POLL_TIMEOUT_MS = 35_000;封顶必须不小于它。
    expect(BACKOFF_CAP_MS).toBeGreaterThanOrEqual(35_000)
    expect(BACKOFF_BASE_MS).toBe(2_000)
  })

  it('抖动落在 ±20% 内', () => {
    const lo = nextBackoffMs(10, { random: () => 0 })
    const hi = nextBackoffMs(10, { random: () => 1 })
    expect(lo).toBe(Math.round(BACKOFF_CAP_MS * 0.8))
    expect(hi).toBe(Math.round(BACKOFF_CAP_MS * 1.2))
  })

  it('负数 attempt 当作 0', () => {
    expect(nextBackoffMs(-3, noJitter)).toBe(2_000)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/backoff.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/health/backoff.ts`:

```ts
/**
 * backoff — 重试间隔(spec 2026-08-03 §3)。
 *
 * 封顶 60s 的依据:正常工作时长轮询就是 35 秒一次
 * (LONG_POLL_TIMEOUT_MS)。故障时每 2 秒打一次、比正常还密集,既无意义
 * 又是触发风控的形状 —— 2026-08-02 那次 10.5 小时故障因此产生了 4211 次
 * 连续失败请求,还把 10MB 日志刷爆触发轮转。
 *
 * 抖动防止多账号/多实例在恢复瞬间同时冲上去。
 */

export const BACKOFF_BASE_MS = 2_000
export const BACKOFF_CAP_MS = 60_000
export const BACKOFF_JITTER = 0.2

/** attempt 从 0 开始:0→2s, 1→4s, 2→8s … 封顶 60s,再叠 ±20% 抖动。 */
export function nextBackoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; jitter?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? BACKOFF_BASE_MS
  const cap = opts.capMs ?? BACKOFF_CAP_MS
  const jitter = opts.jitter ?? BACKOFF_JITTER
  const random = opts.random ?? Math.random
  const n = Math.max(0, Math.floor(attempt))
  // 2^n 在 n 很大时会溢出成 Infinity,先封顶再算抖动。
  const raw = Math.min(cap, base * 2 ** Math.min(n, 30))
  const factor = 1 + (random() * 2 - 1) * jitter
  return Math.round(raw * factor)
}
```

- [ ] **Step 4: 跑 PASS** —— `bun run test src/daemon/health/backoff.test.ts` 全绿。

- [ ] **Step 5: 写 poll-loop 的失败测试** —— 追加到 `src/daemon/poll-loop.test.ts`:

```ts
it('失败时按退避重试,并把成败上报给健康机', async () => {
  const delays: number[] = []
  const events: string[] = []
  let calls = 0
  const abort = new AbortController()

  const handle = startLongPollLoops({
    onInbound: async () => {},
    parse: () => [],
    // 前 4 次失败,第 5 次成功后停掉
    ilink: {
      getUpdates: async () => {
        calls += 1
        if (calls <= 4) throw new Error('unknown certificate verification error')
        abort.abort()
        return { sync_buf: 'x', items: [] } as never
      },
    } as never,
    sleepFn: async (ms: number) => { delays.push(ms) },
    health: {
      recordFailure: () => { events.push('fail') },
      recordSuccess: () => { events.push('ok') },
    },
  } as never)

  handle.addAccount({ id: 'a', baseUrl: 'u', token: 't', syncBuf: '' } as never)
  await handle.stop()

  // 2,4,8,16(抖动关掉时) —— 关键是递增且不再是固定 2 秒
  expect(delays).toHaveLength(4)
  expect(delays[0]).toBeLessThan(delays[3]!)
  expect(events).toEqual(['fail', 'fail', 'fail', 'fail', 'ok'])
})
```

> 注:`startLongPollLoops` 目前没有 `sleepFn` / `health` 注入口,Step 6 要加。测试里用 `as never` 是因为该文件既有测试就是这么绕类型的;实现完成后可去掉。

- [ ] **Step 6: 跑 FAIL,然后改 poll-loop** —— 三处改动:

1) `poll-loop.ts:246` 删掉 `const RETRY_DELAY_MS = 2_000`,改为 `import { nextBackoffMs } from './health/backoff'`。

2) `PollLoopOptions` 增加两个可选注入(放在 `clearExpired` 之后):

```ts
  /**
   * 上报每次 getUpdates 的成败。degraded 判定与外发门控都由它驱动 ——
   * 真实调用就是最准的探针,不需要额外探活。可选:省略即不做健康追踪。
   */
  health?: {
    recordSuccess(dep: 'wechat'): void
    recordFailure(dep: 'wechat', err: unknown): void
  }
  /** 测试注入点;默认就是本文件的 sleep()。 */
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>
```

3) `runLoop` 里:成功分支上报 success 并清零计数;catch 分支用退避,并折叠日志。把 `recordHeartbeat?.(...)` 之后加一行,并替换整个 catch:

```ts
        recordHeartbeat?.(account.id, new Date().toISOString())
        clearExpired?.(account.id)
        // 成功即清零 —— 时长与退避都从下一轮的第一次失败重新起算。
        if (failStreak > 0) {
          log('POLL', `recovered for ${account.id} after ${failStreak} consecutive failures`)
          failStreak = 0
        }
        health?.recordSuccess('wechat')
      } catch (err) {
        if (sig.aborted) break
        health?.recordFailure('wechat', err)
        // 日志折叠:前 3 次逐条,之后每 20 次一条汇总。2026-08-02 那次
        // 4211 行 ERROR 把 10MB 日志刷爆触发轮转,故障起点的上下文因此永久丢失。
        if (failStreak < 3 || failStreak % 20 === 0) {
          log('ERROR', `getUpdates failed (${failStreak + 1}x): ${err}`)
        }
        const delay = nextBackoffMs(failStreak)
        failStreak += 1
        await sleep(delay, sig)
      }
```

其中 `failStreak` 在 `runLoop` 开头声明:`let failStreak = 0`(与 `let syncBuf = account.syncBuf` 同处),`sleep` 取 `const sleep = opts.sleepFn ?? sleepImpl`(把现有导出的 `sleep` 重命名为内部 `sleepImpl` 并继续 `export { sleepImpl as sleep }` 以免破坏既有导入)。

- [ ] **Step 7: 跑 PASS** —— `bun run test src/daemon/poll-loop.test.ts src/daemon/health/` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 8: Commit**

```bash
git add src/daemon/health/backoff.ts src/daemon/health/backoff.test.ts src/daemon/poll-loop.ts src/daemon/poll-loop.test.ts
git commit -m "fix(health): 轮询改指数退避(2s→60s+抖动)+ 日志折叠 + 上报健康机"
```

---

### Task 3: classify.ts —— 错误分类与可操作性

**Files:**
- Create: `src/daemon/health/classify.ts`
- Test: `src/daemon/health/classify.test.ts`

**Interfaces:**
- Produces: `type FailureKind = 'login_taken_over' | 'llm_auth' | 'network' | 'unknown'`;`interface FailureClass { kind: FailureKind; actionable: boolean; title: string; body: string }`;`classifyFailure(err: unknown): FailureClass`。Task 6/7 消费。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyFailure } from './classify'

describe('classifyFailure', () => {
  it('被接管 → 可操作(要主人去扫码)', () => {
    const c = classifyFailure(new Error('ilink/getupdates errcode=-14: session replaced'))
    expect(c).toMatchObject({ kind: 'login_taken_over', actionable: true })
    expect(c.body).toMatch(/扫码|重新绑定/)
  })

  it('LLM 认证失败 → 可操作', () => {
    expect(classifyFailure(new Error('HTTP 401 Unauthorized'))).toMatchObject({ kind: 'llm_auth', actionable: true })
    expect(classifyFailure(new Error('403 forbidden: invalid api key'))).toMatchObject({ kind: 'llm_auth', actionable: true })
  })

  it('网络/TLS/超时 → 不可操作(等它自愈)', () => {
    for (const msg of [
      'unknown certificate verification error',
      'Unable to connect. Is the computer able to access the url?',
      'The operation timed out.',
      'getaddrinfo ENOTFOUND api.example.com',
      'ECONNRESET',
    ]) {
      expect(classifyFailure(new Error(msg)), msg).toMatchObject({ kind: 'network', actionable: false })
    }
  })

  it('认不出来的一律当不可操作 —— 不要用猜测去打扰主人', () => {
    expect(classifyFailure(new Error('something weird'))).toMatchObject({ kind: 'unknown', actionable: false })
  })

  it('非 Error 也能分类,不抛', () => {
    expect(() => classifyFailure(undefined)).not.toThrow()
    expect(classifyFailure(undefined).kind).toBe('unknown')
  })

  it('文案里不出现原始错误码 —— 给主人看的是结论', () => {
    const c = classifyFailure(new Error('unknown certificate verification error'))
    expect(c.title + c.body).not.toMatch(/certificate|errcode|ECONN/i)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/classify.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/health/classify.ts`:

```ts
/**
 * classify — 把一个抛出物变成"给主人看的结论"(spec 2026-08-03 §5)。
 *
 * `actionable` 决定通知阈值(3 分钟 vs 15 分钟)与是否重复提醒:
 * 主人能动手的故障不通知就永远不会好,而网络问题他收到也做不了什么。
 *
 * 判定全部是确定性规则 —— LLM 不参与检测,它必须比被监控对象更可靠。
 * 认不出来时一律当"不可操作",宁可晚说,不要用猜测去打扰。
 */

export type FailureKind = 'login_taken_over' | 'llm_auth' | 'network' | 'unknown'

export interface FailureClass {
  kind: FailureKind
  /** 主人能不能立刻动手解决。决定 3min/15min 阈值与是否 6 小时重复提醒。 */
  actionable: boolean
  title: string
  body: string
}

const NETWORK_RE = /certificate|tls|ssl|ENOTFOUND|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETDOWN|timed out|timeout|Unable to connect|fetch failed|socket hang up/i
const LLM_AUTH_RE = /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i

export function classifyFailure(err: unknown): FailureClass {
  const msg = err instanceof Error ? err.message : String(err ?? '')

  if (/errcode=-14/.test(msg)) {
    return {
      kind: 'login_taken_over',
      actionable: true,
      title: '微信登录已失效',
      body: '这个微信账号在别处被重新绑定了。打开 wechat-cc 桌面端重新扫码即可恢复。',
    }
  }
  if (LLM_AUTH_RE.test(msg)) {
    return {
      kind: 'llm_auth',
      actionable: true,
      title: '模型登录已失效',
      body: '消息还能收到,但暂时没法生成回复。重新登录一下模型账号即可恢复。',
    }
  }
  if (NETWORK_RE.test(msg)) {
    return {
      kind: 'network',
      actionable: false,
      title: '网络连接有问题',
      body: '暂时连不上服务器,通常会自行恢复,你不需要做什么。',
    }
  }
  return {
    kind: 'unknown',
    actionable: false,
    title: '连接出现问题',
    body: '暂时无法正常工作,恢复后会再通知你。',
  }
}
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/health/classify.ts src/daemon/health/classify.test.ts
git commit -m "feat(health): 错误分类 —— 可操作性决定阈值,文案只给结论不给错误码"
```

---

### Task 4: 门控① —— 主动外发在 dispatchToChat 停住

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts`(`TickDeps` 约 :46-73;`dispatchToChat` 在 :258)
- Test: `src/daemon/wiring/tick-bodies.test.ts`(既有文件,追加用例)

**Interfaces:**
- Consumes: Task 1 的 `ConnectionHealth`(只用 `shouldSuspend`)。
- Produces: `TickDeps` 新增可选字段 `health?: { shouldSuspend(dep: 'wechat'): boolean }`。

**为什么落在这里:** `dispatchToChat` 是 pushTick / gapCheckin / hunt 三条主动外发路径的**唯一汇合点**(调用于 :359 / :378 / :397),而且它内部会**先跑 LLM 生成文案再发送** —— 在入口处拦下,token 也一并省了。

- [ ] **Step 1: 写失败测试** —— 追加到 `src/daemon/wiring/tick-bodies.test.ts`。该文件已有 `setupDeps(opts)`(:117)构造完整 deps,直接复用并覆盖 `health`:

```ts
it('wechat degraded 时不发主动消息,而且不调 LLM', async () => {
  const base = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] 明天回访' })
  const dispatch = vi.fn(async () => {})
  const bodies = buildTickBodies({
    ...base.deps,
    coordinator: { ...base.deps.coordinator, dispatch },
    health: { shouldSuspend: () => true },
  })

  await bodies.pushTick({ nowIso: '2026-08-03T02:00:00.000Z' })

  // 断言"省 token":LLM 轮次根本没被发起
  expect(dispatch).not.toHaveBeenCalled()
})

it('healthy 时照常发', async () => {
  const base = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] 明天回访' })
  const dispatch = vi.fn(async () => {})
  const bodies = buildTickBodies({
    ...base.deps,
    coordinator: { ...base.deps.coordinator, dispatch },
    health: { shouldSuspend: () => false },
  })

  await bodies.pushTick({ nowIso: '2026-08-03T02:00:00.000Z' })

  expect(dispatch).toHaveBeenCalled()
})
```

> `setupDeps` 的返回形状与 `coordinator` 字段名以该文件既有用法为准 —— 照抄相邻测试里 `buildTickBodies(...)` 的调用写法,只把 `health` 与 `dispatch` 替换掉。若既有测试断言 LLM 轮次的方式不是 `coordinator.dispatch`,改用它实际使用的那个 spy,断言语义不变:**degraded 时该 spy 零调用**。

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/wiring/tick-bodies.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `TickDeps` 里加(紧挨 `log:` 之后):

```ts
  /**
   * 连接健康。degraded 时主动外发全部停手 —— 这是保护账号的措施:
   * 往断掉的链路上反复重试是触发风控的形状(memory: no-retry-storm-when-disconnected)。
   * 可选:省略即永不暂停(测试与 e2e 用)。
   */
  health?: { shouldSuspend(dep: 'wechat'): boolean }
```

`dispatchToChat` 函数体最前面(`const snapshot = deps.ilink.loadProjects()` 之前)插入:

```ts
    // 在 LLM 生成之前就拦下:degraded 时这条消息既发不出去,生成它也是白烧
    // token,而且等链路恢复后内容早已过时 —— 所以直接丢弃,不排队。
    if (deps.health?.shouldSuspend('wechat')) {
      deps.log('COMPANION', `chat=${chatId} skipped: wechat connection degraded`)
      return
    }
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "fix(health): 门控主动外发 —— wechat degraded 时在 LLM 生成之前就停手"
```

---

### Task 5: incident-store.ts —— 故障记录持久化

**Files:**
- Create: `src/daemon/health/incident-store.ts`
- Test: `src/daemon/health/incident-store.test.ts`

**Interfaces:**
- Consumes: 既有 `makeStateStore(filePath, { debounceMs })`(`src/daemon/state-store.ts`),接口是 `get/set/delete/all/flush`,值均为 `string`。
- Produces: `interface Incident { id: string; dependency: Dependency; kind: FailureKind; actionable: boolean; startedAt: string; endedAt: string | null; notifiedAt: string | null; lastError: string | null }`;`makeIncidentStore(deps: { stateDir: string; store?: StateStore }): IncidentStore`,其中 `IncidentStore = { open(input): Incident; close(dep, endedAtIso): Incident | null; markNotified(dep, atIso): void; openOf(dep): Incident | null; list(): Incident[] }`。Task 6/7 消费。

**为什么不进 db:** 仓库既有约定"关键低频状态写透"(architecture-conventions §5,同 `context_tokens.json`)。故障是低频事件,滚动 20 条足够,不值得为它做一次 schema 迁移。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/incident-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIncidentStore } from './incident-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-')) })

describe('makeIncidentStore', () => {
  it('开一条故障后能取回,未结束时 endedAt 为 null', () => {
    const s = makeIncidentStore({ stateDir: dir })
    const inc = s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: 'tls' })
    expect(inc).toMatchObject({ dependency: 'wechat', endedAt: null, notifiedAt: null })
    expect(s.openOf('wechat')?.id).toBe(inc.id)
    expect(s.openOf('llm')).toBeNull()
  })

  it('close 写入结束时刻,之后不再是 open', () => {
    const s = makeIncidentStore({ stateDir: dir })
    s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: null })
    const closed = s.close('wechat', '2026-08-03T01:08:00.000Z')
    expect(closed?.endedAt).toBe('2026-08-03T01:08:00.000Z')
    expect(s.openOf('wechat')).toBeNull()
  })

  it('markNotified 记下通知时刻(通知配对规则要用)', () => {
    const s = makeIncidentStore({ stateDir: dir })
    s.open({ dependency: 'llm', kind: 'llm_auth', actionable: true, startedAt: '2026-08-03T00:00:00.000Z', lastError: null })
    s.markNotified('llm', '2026-08-03T00:03:00.000Z')
    expect(s.openOf('llm')?.notifiedAt).toBe('2026-08-03T00:03:00.000Z')
  })

  it('跨实例持久化 —— 重启后仍读得到', () => {
    const a = makeIncidentStore({ stateDir: dir })
    a.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: '2026-08-02T14:33:00.000Z', lastError: null })
    const b = makeIncidentStore({ stateDir: dir })
    expect(b.openOf('wechat')).not.toBeNull()
  })

  it('只保留最近 20 条,最新的在前', () => {
    const s = makeIncidentStore({ stateDir: dir })
    for (let i = 0; i < 25; i += 1) {
      s.open({ dependency: 'wechat', kind: 'network', actionable: false, startedAt: `2026-08-0${1 + (i % 9)}T00:00:${String(i).padStart(2, '0')}.000Z`, lastError: null })
      s.close('wechat', '2026-08-09T00:00:00.000Z')
    }
    const list = s.list()
    expect(list).toHaveLength(20)
    expect(list[0]!.startedAt > list[19]!.startedAt || list.length === 20).toBe(true)
  })

  it('文件损坏时不抛,当作空历史', () => {
    const s = makeIncidentStore({
      stateDir: dir,
      store: { get: () => '{{{ not json', set: () => {}, delete: () => {}, all: () => ({}), flush: async () => {} },
    })
    expect(() => s.list()).not.toThrow()
    expect(s.list()).toEqual([])
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/incident-store.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/health/incident-store.ts`:

```ts
/**
 * incident-store — 故障记录(spec 2026-08-03 §7)。
 *
 * 用 state-store 的写透模式(debounceMs:0,tmp+rename),不新增 db 表:
 * 这正是仓库既有约定说的"关键低频状态写透"(architecture-conventions §5,
 * 同 context_tokens.json)。故障是低频事件,滚动 20 条足够,不值得一次迁移。
 *
 * 存在的意义:桌面没开时通知无处可去,记下来,等主人下次打开桌面再告诉他
 * "过去 X 小时你的 bot 是断的"。
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from '../state-store'
import type { Dependency } from './connection-health'
import type { FailureKind } from './classify'

export interface Incident {
  id: string
  dependency: Dependency
  kind: FailureKind
  actionable: boolean
  startedAt: string
  /** null ⇒ 仍在进行中。 */
  endedAt: string | null
  /** 通知发出的时刻;null ⇒ 从未通知过(恢复时也就不该通知)。 */
  notifiedAt: string | null
  lastError: string | null
}

export interface IncidentStore {
  open(input: Omit<Incident, 'id' | 'endedAt' | 'notifiedAt'>): Incident
  close(dep: Dependency, endedAtIso: string): Incident | null
  markNotified(dep: Dependency, atIso: string): void
  openOf(dep: Dependency): Incident | null
  list(): Incident[]
}

const KEY = 'incidents'
const MAX_KEPT = 20

export function makeIncidentStore(deps: { stateDir: string; store?: StateStore }): IncidentStore {
  const store = deps.store ?? makeStateStore(join(deps.stateDir, 'health-incidents.json'), { debounceMs: 0 })

  function read(): Incident[] {
    const raw = store.get(KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed as Incident[] : []
    } catch {
      return []   // 损坏就当空历史 —— 保护机制不能成为新的故障源
    }
  }

  function write(list: Incident[]): void {
    store.set(KEY, JSON.stringify(list.slice(0, MAX_KEPT)))
  }

  return {
    open(input) {
      const incident: Incident = { ...input, id: `${input.dependency}-${input.startedAt}`, endedAt: null, notifiedAt: null }
      const list = read().filter(i => !(i.dependency === input.dependency && i.endedAt === null))
      write([incident, ...list])
      return incident
    },
    close(dep, endedAtIso) {
      const list = read()
      const idx = list.findIndex(i => i.dependency === dep && i.endedAt === null)
      if (idx === -1) return null
      const closed = { ...list[idx]!, endedAt: endedAtIso }
      list[idx] = closed
      write(list)
      return closed
    },
    markNotified(dep, atIso) {
      const list = read()
      const idx = list.findIndex(i => i.dependency === dep && i.endedAt === null)
      if (idx === -1) return
      list[idx] = { ...list[idx]!, notifiedAt: atIso }
      write(list)
    },
    openOf(dep) {
      return read().find(i => i.dependency === dep && i.endedAt === null) ?? null
    },
    list() {
      return read()
    },
  }
}
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/health/incident-store.ts src/daemon/health/incident-store.test.ts
git commit -m "feat(health): 故障记录持久化(写透 JSON,滚动 20 条,不做 db 迁移)"
```

---

### Task 6: notify-policy.ts —— 该不该通知

**Files:**
- Create: `src/daemon/health/notify-policy.ts`
- Test: `src/daemon/health/notify-policy.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `FailureClass`,Task 5 的 `Incident`。
- Produces: 常量 `NOTIFY_ACTIONABLE_MS = 180_000`、`NOTIFY_NON_ACTIONABLE_MS = 900_000`、`REPEAT_ACTIONABLE_MS = 21_600_000`;`shouldNotifyDown(incident: Incident, nowMs: number): boolean`;`shouldNotifyRecovery(incident: Incident): boolean`。Task 7 消费。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/notify-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  shouldNotifyDown, shouldNotifyRecovery,
  NOTIFY_ACTIONABLE_MS, NOTIFY_NON_ACTIONABLE_MS, REPEAT_ACTIONABLE_MS,
} from './notify-policy'
import type { Incident } from './incident-store'

const T0 = Date.parse('2026-08-02T14:33:00.000Z')
function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'i', dependency: 'wechat', kind: 'network', actionable: false,
    startedAt: new Date(T0).toISOString(), endedAt: null, notifiedAt: null, lastError: null,
    ...over,
  }
}

describe('shouldNotifyDown', () => {
  it('不可操作的要等 15 分钟 —— 短故障不打扰', () => {
    const inc = incident()
    expect(shouldNotifyDown(inc, T0 + NOTIFY_NON_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, T0 + NOTIFY_NON_ACTIONABLE_MS)).toBe(true)
  })

  it('可操作的 3 分钟就说 —— 不说就永远不会好', () => {
    const inc = incident({ actionable: true, kind: 'login_taken_over' })
    expect(shouldNotifyDown(inc, T0 + NOTIFY_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, T0 + NOTIFY_ACTIONABLE_MS)).toBe(true)
  })

  it('不可操作的通知过一次就不再重复 —— 你已经知道且无能为力', () => {
    const inc = incident({ notifiedAt: new Date(T0 + NOTIFY_NON_ACTIONABLE_MS).toISOString() })
    expect(shouldNotifyDown(inc, T0 + 10 * 3600_000)).toBe(false)
  })

  it('可操作的每 6 小时提醒一次(自上一条通知起算)', () => {
    const notifiedAt = T0 + NOTIFY_ACTIONABLE_MS
    const inc = incident({ actionable: true, notifiedAt: new Date(notifiedAt).toISOString() })
    expect(shouldNotifyDown(inc, notifiedAt + REPEAT_ACTIONABLE_MS - 1)).toBe(false)
    expect(shouldNotifyDown(inc, notifiedAt + REPEAT_ACTIONABLE_MS)).toBe(true)
  })

  it('已结束的故障不再发 down', () => {
    const inc = incident({ endedAt: new Date(T0 + 1000).toISOString() })
    expect(shouldNotifyDown(inc, T0 + 10 * 3600_000)).toBe(false)
  })
})

describe('shouldNotifyRecovery', () => {
  it('通知过"坏了"才通知"恢复"', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: 'x', notifiedAt: 'y' }))).toBe(true)
  })

  it('没通知过就别冒出一句"已恢复" —— 会让人莫名其妙', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: 'x', notifiedAt: null }))).toBe(false)
  })

  it('还没结束的不发恢复', () => {
    expect(shouldNotifyRecovery(incident({ endedAt: null, notifiedAt: 'y' }))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/notify-policy.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/health/notify-policy.ts`:

```ts
/**
 * notify-policy — 该不该打扰主人(spec 2026-08-03 §2 / §5)。
 *
 * 只在状态跳变时通知,不在每次失败时通知:一次持续 10 小时的故障因此只产生
 * 一条"坏了"和一条"恢复了"。报警系统最容易死在刷屏上 —— 发多了就会被无视,
 * 那还不如不发。
 */
import type { Incident } from './incident-store'

/** 主人能动手的:3 分钟。不说就永远不会好,每拖一分钟都是白白少服务。 */
export const NOTIFY_ACTIONABLE_MS = 180_000
/** 主人做不了什么的:15 分钟。足以滤掉绝大多数会自愈的抖动。 */
export const NOTIFY_NON_ACTIONABLE_MS = 900_000
/** 可操作的故障每 6 小时提醒一次(自上一条通知起算)。 */
export const REPEAT_ACTIONABLE_MS = 21_600_000

export function shouldNotifyDown(incident: Incident, nowMs: number): boolean {
  if (incident.endedAt !== null) return false
  const threshold = incident.actionable ? NOTIFY_ACTIONABLE_MS : NOTIFY_NON_ACTIONABLE_MS
  const startedMs = Date.parse(incident.startedAt)
  if (!Number.isFinite(startedMs)) return false

  if (incident.notifiedAt === null) return nowMs - startedMs >= threshold

  // 已经通知过:不可操作的不再重复;可操作的每 6 小时一次。
  if (!incident.actionable) return false
  const notifiedMs = Date.parse(incident.notifiedAt)
  if (!Number.isFinite(notifiedMs)) return false
  return nowMs - notifiedMs >= REPEAT_ACTIONABLE_MS
}

/** 恢复通知必须与 down 通知配对 —— 没说过坏就别说恢复。 */
export function shouldNotifyRecovery(incident: Incident): boolean {
  return incident.endedAt !== null && incident.notifiedAt !== null
}
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/health/notify-policy.ts src/daemon/health/notify-policy.test.ts
git commit -m "feat(health): 通知策略 —— 分级阈值/重复间隔/恢复配对"
```

---

### Task 7: 接线 —— daemon 把五个模块串起来

**Files:**
- Create: `src/daemon/health/index.ts`
- Test: `src/daemon/health/index.test.ts`
- Modify: `src/daemon/bootstrap/index.ts`(构造并注入,跟随该文件既有的 wire-* 写法)

**Interfaces:**
- Consumes: Task 1/3/5/6 的全部导出。
- Produces: `makeHealthRuntime(deps: { stateDir: string; now: () => number; log: (tag: string, line: string) => void; notify: (n: { title: string; body: string; actionable: boolean }) => void }): { health: ConnectionHealth; onFailure(dep: Dependency, err: unknown): void; onSuccess(dep: Dependency): void }`。Task 8 的桌面侧读 `health-incidents.json`。

- [ ] **Step 1: 写失败测试** —— `src/daemon/health/index.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHealthRuntime } from './index'
import { SUSPEND_AFTER_MS } from './connection-health'
import { NOTIFY_NON_ACTIONABLE_MS } from './notify-policy'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-rt-')) })

function setup() {
  const t = { ms: Date.parse('2026-08-02T14:33:00.000Z') }
  const notes: Array<{ title: string; body: string }> = []
  const rt = makeHealthRuntime({
    stateDir: dir,
    now: () => t.ms,
    log: () => {},
    notify: n => { notes.push({ title: n.title, body: n.body }) },
  })
  return { t, notes, rt }
}

describe('makeHealthRuntime', () => {
  it('复刻 2026-08-02 那次:10.5 小时故障只产生 2 条通知', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    // 每 60 秒一次失败,持续 10.5 小时
    for (let elapsed = 0; elapsed <= 10.5 * 3600_000; elapsed += 60_000) {
      t.ms = start + elapsed
      rt.onFailure('wechat', new Error('unknown certificate verification error'))
    }
    expect(notes).toHaveLength(1)          // 15 分钟时那一条
    expect(notes[0]!.title).toMatch(/网络/)

    t.ms = start + 10.5 * 3600_000 + 60_000
    rt.onSuccess('wechat')
    expect(notes).toHaveLength(2)          // 恢复
    expect(notes[1]!.body).toMatch(/恢复/)
  })

  it('30 秒抖动:一条都不发,也不算故障', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    rt.onFailure('wechat', new Error('ECONNRESET'))
    t.ms = start + 30_000
    rt.onFailure('wechat', new Error('ECONNRESET'))
    t.ms = start + 31_000
    rt.onSuccess('wechat')
    expect(notes).toEqual([])
    expect(rt.health.get('wechat').status).toBe('healthy')
  })

  it('可操作故障 3 分钟就通知', () => {
    const { t, notes, rt } = setup()
    const start = t.ms
    for (let e = 0; e <= 200_000; e += 20_000) {
      t.ms = start + e
      rt.onFailure('wechat', new Error('ilink/getupdates errcode=-14: replaced'))
    }
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toMatch(/微信登录/)
  })

  it('degraded 之前不开故障记录 —— 60 秒确认期内不算数', () => {
    const { t, rt } = setup()
    rt.onFailure('wechat', new Error('boom'))
    t.ms += SUSPEND_AFTER_MS - 1
    rt.onFailure('wechat', new Error('boom'))
    expect(rt.health.shouldSuspend('wechat')).toBe(false)
  })

  it('notify 抛异常不会把上报打断 —— 保护机制不能成为新故障源', () => {
    const t = { ms: Date.parse('2026-08-02T14:33:00.000Z') }
    const rt = makeHealthRuntime({
      stateDir: dir, now: () => t.ms, log: () => {},
      notify: () => { throw new Error('desktop not running') },
    })
    const start = t.ms
    expect(() => {
      for (let e = 0; e <= NOTIFY_NON_ACTIONABLE_MS + 60_000; e += 60_000) {
        t.ms = start + e
        rt.onFailure('wechat', new Error('tls'))
      }
    }).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/health/index.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/health/index.ts`:

```ts
/**
 * health runtime —— 把健康机 / 分类 / 故障记录 / 通知策略串起来的薄接线层。
 *
 * 全部对外行为只有两个入口:onFailure / onSuccess。poll-loop 调它们,
 * 其余模块只读 health.shouldSuspend()。
 */
import { makeConnectionHealth, type ConnectionHealth, type Dependency } from './connection-health'
import { classifyFailure } from './classify'
import { makeIncidentStore } from './incident-store'
import { shouldNotifyDown, shouldNotifyRecovery } from './notify-policy'

export interface HealthNotification {
  title: string
  body: string
  actionable: boolean
}

export interface HealthRuntime {
  health: ConnectionHealth
  onFailure(dep: Dependency, err: unknown): void
  onSuccess(dep: Dependency): void
}

export function makeHealthRuntime(deps: {
  stateDir: string
  now: () => number
  log: (tag: string, line: string) => void
  notify: (n: HealthNotification) => void
}): HealthRuntime {
  const health = makeConnectionHealth({ now: deps.now })
  const incidents = makeIncidentStore({ stateDir: deps.stateDir })

  /** 通知投递失败不重试、不阻塞 —— 记一行就够,故障记录已经落盘。 */
  function safeNotify(n: HealthNotification): void {
    try { deps.notify(n) } catch (err) {
      deps.log('HEALTH', `notify failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onFailure(dep: Dependency, err: unknown): void {
    try {
      health.recordFailure(dep, err)
      if (!health.shouldSuspend(dep)) return   // 60 秒确认期内不算故障

      const nowMs = deps.now()
      const nowIso = new Date(nowMs).toISOString()
      const klass = classifyFailure(err)
      let open = incidents.openOf(dep)
      if (!open) {
        const state = health.get(dep)
        open = incidents.open({
          dependency: dep,
          kind: klass.kind,
          actionable: klass.actionable,
          startedAt: new Date(state.firstFailureAt ?? nowMs).toISOString(),
          lastError: state.lastError,
        })
        deps.log('HEALTH', `${dep} degraded (${klass.kind})`)
      }
      if (shouldNotifyDown(open, nowMs)) {
        safeNotify({ title: klass.title, body: klass.body, actionable: klass.actionable })
        incidents.markNotified(dep, nowIso)
      }
    } catch (err) {
      deps.log('HEALTH', `onFailure swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onSuccess(dep: Dependency): void {
    try {
      const wasDegraded = health.shouldSuspend(dep)
      health.recordSuccess(dep)
      if (!wasDegraded) return

      const nowIso = new Date(deps.now()).toISOString()
      const closed = incidents.close(dep, nowIso)
      deps.log('HEALTH', `${dep} recovered`)
      if (closed && shouldNotifyRecovery(closed)) {
        const mins = Math.round((Date.parse(closed.endedAt!) - Date.parse(closed.startedAt)) / 60_000)
        const span = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`
        safeNotify({
          title: '已恢复',
          body: `刚才断了约 ${span},现在已经恢复正常,你不需要做什么。`,
          actionable: false,
        })
      }
    } catch (err) {
      deps.log('HEALTH', `onSuccess swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { health, onFailure, onSuccess }
}

export { SUSPEND_AFTER_MS } from './connection-health'
export type { Dependency } from './connection-health'
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿。

- [ ] **Step 5: 接进 bootstrap** —— 在 `src/daemon/bootstrap/index.ts` 构造 `makeHealthRuntime`(`notify` 先传一个只写日志的实现,Task 8 再换成真通知),并把 `{ recordSuccess, recordFailure }` 传给 `startLongPollLoops` 的 `health`、把 `{ shouldSuspend }` 传给 `buildTickBodies` 的 `health`。跟随该文件既有的 wire 写法,不要在 index 里堆逻辑。

- [ ] **Step 6: 全量验证** —— `bun run test` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/health/index.ts src/daemon/health/index.test.ts src/daemon/bootstrap/index.ts
git commit -m "feat(health): 接线 —— poll-loop 上报、tick 门控、故障记录与分级通知串起来"
```

---

### Task 8: 桌面呈现 —— 系统通知 + "上次故障"

**Files:**
- Create: `src/daemon/internal-api/routes-health.ts`
- Test: `src/daemon/internal-api/routes-health.test.ts`
- Modify: `src/daemon/internal-api/route-tiers.ts`(新增路由的 tier)
- Modify: `apps/desktop/src/modules/dashboard.js`(拉取 + 横幅 + 系统通知)

**Interfaces:**
- Consumes: Task 5 的 `makeIncidentStore().list()`。
- Produces: `GET /v1/health/incidents` → `{ incidents: Incident[] }`。

**tier 必须是 `trusted`:** 桌面与 CLI 持有的是 daemon 全域 0600 文件 token = trusted,不是 admin。历史上多次因为把路由标成 admin 导致桌面静默 403、整页显示"未启用"(见 route-tiers.ts 里既有的 RELEASE-REVIEW FLAG 注释)。

- [ ] **Step 1: 写失败测试** —— `src/daemon/internal-api/routes-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeHealthRoutes } from './routes-health'

describe('GET /v1/health/incidents', () => {
  it('返回故障列表', async () => {
    const routes = makeHealthRoutes({
      incidents: { list: () => [{
        id: 'i1', dependency: 'wechat', kind: 'network', actionable: false,
        startedAt: '2026-08-02T14:33:00.000Z', endedAt: '2026-08-03T01:08:00.000Z',
        notifiedAt: '2026-08-02T14:48:00.000Z', lastError: null,
      }] } as never,
    })
    const res = await routes['GET /v1/health/incidents']!({} as never)
    expect(await res.json()).toEqual({
      incidents: [expect.objectContaining({ dependency: 'wechat', endedAt: '2026-08-03T01:08:00.000Z' })],
    })
  })

  it('未接线时返回空列表而不是 503 —— 没有故障记录是正常状态', async () => {
    const routes = makeHealthRoutes({ incidents: null } as never)
    const res = await routes['GET /v1/health/incidents']!({} as never)
    expect(await res.json()).toEqual({ incidents: [] })
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/internal-api/routes-health.test.ts`,期望红。

- [ ] **Step 3: 实现路由** —— `src/daemon/internal-api/routes-health.ts` 照该目录既有 `routes-*.ts` 的 `(ctx) => RouteTable` 形状写,返回 `Response.json({ incidents: deps.incidents?.list() ?? [] })`;在 `route-tiers.ts` 的表里加一行:

```ts
  // 桌面读故障记录以显示"上次故障"横幅。trusted:桌面/CLI 的唯一凭据是
  // 0600 文件 token;内容只有时间戳与分类,不含聊天数据。
  'GET /v1/health/incidents': 'trusted',
```

并在 `internal-api` 的装配处把 `makeIncidentStore` 注入(跟随既有 `setX()` 写法)。

- [ ] **Step 4: 跑 PASS** —— 同命令 + `bun run test src/daemon/internal-api/` 全绿。

- [ ] **Step 5: 桌面侧** —— `apps/desktop/src/modules/dashboard.js` 增加:

```js
/**
 * 上次故障横幅。桌面没开着时通知无处可去,所以下次打开必须补上 ——
 * 否则主人永远不知道 bot 曾经断过(2026-08-02 那次断了 10.5 小时,
 * 他只有翻日志才发现)。
 */
async function loadLastIncident(deps) {
  const res = await deps.invokeApi("GET", "/v1/health/incidents").catch(err => {
    console.warn("[health] incidents load failed:", err)
    return null
  })
  const list = res && Array.isArray(res.incidents) ? res.incidents : []
  const banner = document.getElementById("dash-health-banner")
  if (!banner) return
  const latest = list[0]
  if (!latest) { banner.hidden = true; return }

  const started = new Date(latest.startedAt)
  const ended = latest.endedAt ? new Date(latest.endedAt) : null
  const mins = ended ? Math.round((ended - started) / 60000) : null
  const span = mins === null ? "仍在进行" : mins >= 60 ? `约 ${Math.round(mins / 60)} 小时` : `约 ${mins} 分钟`
  banner.textContent = ended
    ? `你的 bot 在 ${started.toLocaleString()} 前后断开过 ${span}，现已恢复。`
    : `你的 bot 从 ${started.toLocaleString()} 起处于断开状态（${span}）。`
  banner.hidden = false
}
```

`index.html` 在仪表盘 hero 区(`dash-rail-text` 所在容器之后)加 `<p id="dash-health-banner" class="dash-health-banner" hidden></p>`,并在 `styles.css` 给它一个与既有告警色一致的样式。

- [ ] **Step 6: 把 daemon 的 notify 换成真通知** —— Task 7 Step 5 里 `notify` 传的是只写日志的实现;现在改为同时投递到桌面。最小实现:daemon 侧仍只写日志与故障记录,**桌面在 `loadLastIncident` 发现有未读的新故障时调用既有的 `invoke("notify_user", { title, body })`**(`main.js:312` 已有用法)。这样不需要 daemon→桌面的推送通道。

- [ ] **Step 7: 验证** —— `bunx vitest run apps/desktop/`(2 个既有 dashboard 失败可接受)、`bun run test`、`bunx tsc --noEmit` 全绿。

- [ ] **Step 8: Commit**

```bash
git add src/daemon/internal-api/routes-health.ts src/daemon/internal-api/routes-health.test.ts src/daemon/internal-api/route-tiers.ts apps/desktop/src/modules/dashboard.js apps/desktop/src/index.html apps/desktop/src/styles.css
git commit -m "feat(health): 桌面呈现 —— /v1/health/incidents(trusted)+ 上次故障横幅 + 系统通知"
```

---

### Task 9: 门控② —— LLM 轮次与模板回复

**Files:**
- Create: `src/daemon/inbound/mw-llm-health.ts`
- Test: `src/daemon/inbound/mw-llm-health.test.ts`
- Modify: 入站管线装配处(与 `mw-dispatch` 相邻,插在它**之前**)

**Interfaces:**
- Consumes: Task 1 的 `ConnectionHealth`(`shouldSuspend` / `get`),Task 2 的 `nextBackoffMs`。仅依赖这两个任务,与 Task 5-8 无关。
- Produces: `makeMwLlmHealth(deps: { health: { shouldSuspend(dep: 'llm'): boolean; get(dep: 'llm'): { consecutiveFailures: number } }; sendMessage(chatId: string, text: string): Promise<{ msgId: string }>; now: () => number; log: (tag: string, line: string) => void }): Middleware`。

**为什么是中间件、为什么插在 mw-dispatch 之前:** `mw-dispatch` 是终端中间件(`await deps.coordinator.dispatch(ctx.msg)`,从不调 `next()`),LLM 轮次就在它后面发生。在它之前拦下,就是在烧 token 之前拦下。回消息的写法照搬既有的 `mw-guard.ts`(它已有 `sendMessage(chatId, text)` 依赖,并在网络探测失败时发模板话)。

**这一侧与 wechat 侧相反:入站是收得到的**,所以每条新消息都会驱动一次 LLM 轮次然后失败 —— 这才是"反复调用失败的 API"真正会发生的地方(微信断时反而不会,因为压根收不到消息)。

- [ ] **Step 1: 写失败测试** —— `src/daemon/inbound/mw-llm-health.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwLlmHealth } from './mw-llm-health'
import type { InboundCtx } from './types'

function ctx(chatId = 'chat-1'): InboundCtx {
  return { msg: { chatId, text: 'hi' } as never, receivedAtMs: 0, requestId: 'r1' }
}

function harness(over: { suspend?: boolean; failures?: number; nowMs?: number } = {}) {
  const sent: string[] = []
  const t = { ms: over.nowMs ?? 0 }
  const mw = makeMwLlmHealth({
    health: {
      shouldSuspend: () => over.suspend ?? false,
      get: () => ({ consecutiveFailures: over.failures ?? 5 }),
    },
    sendMessage: async (_c, text) => { sent.push(text); return { msgId: 'm' } },
    now: () => t.ms,
    log: () => {},
  })
  return { mw, sent, t }
}

describe('mw-llm-health', () => {
  it('healthy 时透明放行', async () => {
    const { mw, sent } = harness({ suspend: false })
    const next = vi.fn(async () => {})
    await mw(ctx(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('degraded 时不进入 LLM 轮次,改回模板话', async () => {
    const { mw, sent } = harness({ suspend: true })
    const next = vi.fn(async () => {})
    await mw(ctx(), next)
    expect(next).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/没法|暂时/)
  })

  it('模板话是写死的 —— 坏掉的组件不能生成自己的讣告', async () => {
    const { mw, sent } = harness({ suspend: true })
    await mw(ctx(), vi.fn(async () => {}))
    // 不含任何模型生成痕迹:纯静态文案,不调 next 也就没有 provider 参与
    expect(sent[0]).not.toMatch(/undefined|\[object/)
  })

  it('同一 degraded 区间内每个 chat 只回一次,不刷屏', async () => {
    const { mw, sent } = harness({ suspend: true })
    for (let i = 0; i < 5; i += 1) await mw(ctx('chat-1'), vi.fn(async () => {}))
    expect(sent).toHaveLength(1)
  })

  it('不同 chat 各自回一次', async () => {
    const { mw, sent } = harness({ suspend: true })
    await mw(ctx('chat-1'), vi.fn(async () => {}))
    await mw(ctx('chat-2'), vi.fn(async () => {}))
    expect(sent).toHaveLength(2)
  })

  it('达到退避间隔后放行一次真实尝试(探测恢复)', async () => {
    const { mw, sent, t } = harness({ suspend: true, failures: 0 })  // 退避 = 2s
    const next = vi.fn(async () => {})
    await mw(ctx(), next)                 // 第一条:拦下并回模板
    expect(next).not.toHaveBeenCalled()

    t.ms = 2_000                          // 到达退避间隔
    await mw(ctx(), next)                 // 放行一次真实尝试
    expect(next).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)          // 放行的这次不回模板
  })

  it('sendMessage 失败不把管线打断', async () => {
    const sendMessage = vi.fn(async () => { throw new Error('wechat also down') })
    const mw = makeMwLlmHealth({
      health: { shouldSuspend: () => true, get: () => ({ consecutiveFailures: 5 }) },
      sendMessage: sendMessage as never,
      now: () => 0,
      log: () => {},
    })
    await expect(mw(ctx(), vi.fn(async () => {}))).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/inbound/mw-llm-health.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/inbound/mw-llm-health.ts`:

```ts
/**
 * mw-llm-health — LLM 降级时不再为每条消息发起轮次(spec 2026-08-03 §4)。
 *
 * 插在 mw-dispatch 之前:那是终端中间件,LLM 轮次就在它后面发生,所以在这里
 * 拦下就是在烧 token 之前拦下。
 *
 * 与 wechat 侧相反:LLM 坏掉时入站仍然收得到,每条消息都会驱动一次注定失败的
 * 调用 —— 这才是"反复打一个失败的 API"真正发生的地方。
 *
 * 恢复检测由入站消息本身驱动并受退避约束:距上次尝试不足当前退避间隔就直接
 * 回模板话;达到间隔则放行一次真实尝试。
 */
import { nextBackoffMs } from '../health/backoff'
import type { Middleware } from './types'

/**
 * 写死的文案 —— 坏掉的正是 LLM,不能指望它写自己的讣告。
 * 这听起来显然,但实现时很容易顺手就调了。
 */
const DEGRADED_REPLY = '我现在暂时没法思考(模型连接有问题),你的消息我收到了。等我恢复了会继续。'

export interface MwLlmHealthDeps {
  health: {
    shouldSuspend(dep: 'llm'): boolean
    get(dep: 'llm'): { consecutiveFailures: number }
  }
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  now: () => number
  log: (tag: string, line: string) => void
}

export function makeMwLlmHealth(deps: MwLlmHealthDeps): Middleware {
  /** 每个 chat 在当前 degraded 区间内是否已回过模板话。 */
  const notified = new Set<string>()
  let lastAttemptMs: number | null = null

  return async (ctx, next) => {
    if (!deps.health.shouldSuspend('llm')) {
      notified.clear()
      lastAttemptMs = null
      await next()
      return
    }

    const now = deps.now()
    const delay = nextBackoffMs(deps.health.get('llm').consecutiveFailures)
    if (lastAttemptMs === null || now - lastAttemptMs >= delay) {
      // 放行一次真实尝试:成功与否由下游上报给健康机,这里不做判断。
      lastAttemptMs = now
      await next()
      return
    }

    if (!notified.has(ctx.msg.chatId)) {
      notified.add(ctx.msg.chatId)
      try {
        await deps.sendMessage(ctx.msg.chatId, DEGRADED_REPLY)
      } catch (err) {
        // 微信可能也断了 —— 记一行就够,绝不能把入站管线打断。
        deps.log('HEALTH', `degraded reply failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    ctx.consumedBy = 'guard'
  }
}
```

> 注:`lastAttemptMs` 在首次 degraded 时为 null,所以**第一条消息会被拦下并回模板**(而不是放行)——这是有意的:进入 degraded 就意味着刚刚已经连续失败了 60 秒,没必要立刻再试一次。

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: 接进管线** —— 在入站管线装配处把 `makeMwLlmHealth(...)` 插在 `makeMwDispatch(...)` **之前**,`health` 传 Task 7 的 `healthRuntime.health`,`sendMessage` 复用 `mw-guard` 装配时用的同一个实现。同时:LLM 轮次的成败要上报给 `healthRuntime.onFailure('llm', err)` / `onSuccess('llm')` —— 在 coordinator 的轮次结果处接入(跟随该处既有的错误处理写法,不要新增 try/catch 层)。

- [ ] **Step 6: 全量验证** —— `bun run test` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/inbound/mw-llm-health.ts src/daemon/inbound/mw-llm-health.test.ts
git commit -m "feat(health): 门控 LLM 轮次 —— degraded 时回写死模板话,按退避放行探测"
```
