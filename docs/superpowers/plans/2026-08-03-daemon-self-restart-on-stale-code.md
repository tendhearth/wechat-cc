# daemon 空闲时自动重启以加载新代码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon 发现自己运行的代码比磁盘上的旧、且当前空闲时,优雅退出让 launchd 用新代码把它拉起 —— 全程零界面。

**Architecture:** 一个纯函数决策模块(给定"加载时的 commit / 当前 commit / 是否空闲 / 各时间戳" → 该不该重启),两个空闲信号(SessionManager 的全局 in-flight、入站活动时间戳),以及一处接线 —— 挂在 `bootstrap/index.ts` 里**已存在的 60 秒 `setInterval`** 上,触发**已存在的** `requestRestart` 路径。不新增定时器,不新增重启机制。

**Tech Stack:** TypeScript + Bun,vitest。`Bun.spawn` 读 git HEAD。

**Spec:** `docs/superpowers/specs/2026-08-03-daemon-self-restart-on-stale-code-design.md`

## Global Constraints

- **这套机制绝不能成为新的故障源**:任何异常(不是 git 仓库、git 不可用、命令失败、超时)⇒ 静默跳过,不抛、不记 ERROR。
- **失败方向必须是"不动作"**:空闲信号拿不到 ⇒ 视为不空闲 ⇒ 不重启。
- 常量(全计划统一):`GIT_TIMEOUT_MS = 3_000`(git-head.ts 内)、`IDLE_QUIET_MS = 120_000`(wire.ts 内)、`BOOT_GRACE_MS = 300_000` 与 `MIN_RESTART_INTERVAL_MS = 600_000`(stale-code.ts 内)。**检查频率不是新常量** —— 直接复用 `bootstrap/index.ts:575` 那个既有的 60 秒 timer。
- **零界面**:不弹窗、不横幅、不显示版本号、不提供按钮。唯一痕迹是 `channel.log` 里一行。
- 入站活动记录必须在 **access + dedup 之后、所有消费型中间件之前**(陌生人与重复消息不算;管理员命令算)。
- `bun run test`(vitest)**不做类型检查** —— 每个动 .ts 的任务都要跑 `bunx tsc --noEmit`(仓库根)。
- 跑测试用 `bun run test <file>`,**不要用 `bunx vitest`**(node 跑会因 `bun:sqlite` 报错)。
- TDD:先测试跑 FAIL,再实现跑 PASS,commit。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/daemon/self-restart/stale-code.ts` | 纯决策:该不该重启(注入一切,零 I/O) |
| `src/daemon/self-restart/git-head.ts` | 读当前 git HEAD(带超时,永不抛) |
| `src/daemon/self-restart/activity-marker.ts` | 进程内"最近入站时刻"标记 |
| `src/core/session-manager.ts` | 新增 `anyInFlight()`(修改) |
| `src/daemon/inbound/mw-messages.ts` | 新增可选 `markInboundActivity` 回调(修改) |
| `src/daemon/bootstrap/index.ts` | 接线:启动读 HEAD、挂进既有 60s timer(修改) |
| `src/daemon/main.ts` | 把已有的 `requestRestart` 传进 bootstrap(修改) |

---

### Task 1: 纯决策 + git HEAD 读取

**Files:**
- Create: `src/daemon/self-restart/stale-code.ts`
- Create: `src/daemon/self-restart/git-head.ts`
- Test: `src/daemon/self-restart/stale-code.test.ts`
- Test: `src/daemon/self-restart/git-head.test.ts`

**Interfaces:**
- Produces: `shouldSelfRestart(input: StaleCheckInput): boolean`,其中
  `StaleCheckInput = { loadedHead: string | null; currentHead: string | null; idle: boolean; nowMs: number; bootAtMs: number; lastRestartAtMs: number | null }`;
  常量 `BOOT_GRACE_MS`、`MIN_RESTART_INTERVAL_MS`。
  `readGitHead(deps: { cwd: string; spawn?: typeof Bun.spawn; timeoutMs?: number }): Promise<string | null>`。
  Task 3 消费两者。

- [ ] **Step 1: 写失败测试** —— `src/daemon/self-restart/stale-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldSelfRestart, BOOT_GRACE_MS, MIN_RESTART_INTERVAL_MS } from './stale-code'

const BOOT = 1_000_000
function input(over: Partial<Parameters<typeof shouldSelfRestart>[0]> = {}) {
  return {
    loadedHead: 'aaa111',
    currentHead: 'bbb222',        // 默认:磁盘上更新了
    idle: true,
    nowMs: BOOT + BOOT_GRACE_MS,  // 默认:刚过宽限期
    bootAtMs: BOOT,
    lastRestartAtMs: null,
    ...over,
  }
}

describe('shouldSelfRestart', () => {
  it('代码变了 + 空闲 + 过了宽限期 ⇒ 重启', () => {
    expect(shouldSelfRestart(input())).toBe(true)
  })

  it('代码没变 ⇒ 不重启(重启后天然不再成立,所以不会循环)', () => {
    expect(shouldSelfRestart(input({ currentHead: 'aaa111' }))).toBe(false)
  })

  it('不空闲 ⇒ 不重启', () => {
    expect(shouldSelfRestart(input({ idle: false }))).toBe(false)
  })

  it('宽限期内 ⇒ 不重启', () => {
    expect(shouldSelfRestart(input({ nowMs: BOOT + BOOT_GRACE_MS - 1 }))).toBe(false)
  })

  it('距上次自我重启不足最小间隔 ⇒ 不重启', () => {
    const now = BOOT + BOOT_GRACE_MS + 1
    expect(shouldSelfRestart(input({ nowMs: now, lastRestartAtMs: now - MIN_RESTART_INTERVAL_MS + 1 }))).toBe(false)
    expect(shouldSelfRestart(input({ nowMs: now, lastRestartAtMs: now - MIN_RESTART_INTERVAL_MS }))).toBe(true)
  })

  it('任一 head 读不到 ⇒ 不重启(失败方向必须是不动作)', () => {
    expect(shouldSelfRestart(input({ currentHead: null }))).toBe(false)
    expect(shouldSelfRestart(input({ loadedHead: null }))).toBe(false)
    expect(shouldSelfRestart(input({ loadedHead: null, currentHead: null }))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/self-restart/stale-code.test.ts`,期望红(模块不存在)。

- [ ] **Step 3: 实现 stale-code.ts**:

```ts
/**
 * stale-code — 该不该为了加载新代码而自我重启(spec 2026-08-03 §1/§5)。
 *
 * WHY: daemon 从 git checkout 运行,bun 在进程启动时加载源码。所以
 * `wechat-cc update` 之后运行中的进程仍是旧的,直到有人重启 —— 这不是边缘
 * 情况,是每次更新后的默认状态。2026-08-03 实测:连接健康的全部修复躺在磁盘
 * 上,而当天两次断线跑的仍是 7 月 27 日启动的旧进程。
 *
 * 纯函数、零 I/O、注入一切。每一处不确定都倒向"不动作"。
 */

/** 进程启动后这么久内不自我重启 —— 挡住任何"起来就重启"的病态循环。 */
export const BOOT_GRACE_MS = 300_000

/** 两次自我重启之间的最小间隔,防 HEAD 被外部持续改动导致反复重启。 */
export const MIN_RESTART_INTERVAL_MS = 600_000

export interface StaleCheckInput {
  /** 本进程启动时加载的 commit;读不到为 null。 */
  loadedHead: string | null
  /** checkout 当前的 commit;读不到为 null。 */
  currentHead: string | null
  /** 当前是否空闲(无在途会话 且 最近无入站)。 */
  idle: boolean
  nowMs: number
  bootAtMs: number
  /** 本进程此前触发过自我重启的时刻;从未触发为 null。 */
  lastRestartAtMs: number | null
}

export function shouldSelfRestart(input: StaleCheckInput): boolean {
  // 读不到任何一侧都不动作:宁可永远不重启,也不能因为一次 git 读取抖动
  // 就把主人的 bot 踢下线。
  if (input.loadedHead === null || input.currentHead === null) return false
  if (input.loadedHead === input.currentHead) return false
  if (!input.idle) return false
  if (input.nowMs - input.bootAtMs < BOOT_GRACE_MS) return false
  if (input.lastRestartAtMs !== null
    && input.nowMs - input.lastRestartAtMs < MIN_RESTART_INTERVAL_MS) return false
  return true
}
```

- [ ] **Step 4: 写 git-head 的失败测试** —— `src/daemon/self-restart/git-head.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readGitHead } from './git-head'

/** 造一个假的 Bun.spawn:按需返回 stdout / 退出码 / 永不结束。 */
function fakeSpawn(opts: { stdout?: string; exitCode?: number; hang?: boolean }) {
  return (() => ({
    stdout: new Response(opts.stdout ?? '').body,
    exited: opts.hang ? new Promise<number>(() => {}) : Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn
}

describe('readGitHead', () => {
  it('正常返回时给出去空白的 commit', async () => {
    const head = await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: 'abc123def\n' }) })
    expect(head).toBe('abc123def')
  })

  it('非零退出码 ⇒ null(不是 git 仓库等)', async () => {
    expect(await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: '', exitCode: 128 }) })).toBeNull()
  })

  it('输出为空 ⇒ null', async () => {
    expect(await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: '   \n' }) })).toBeNull()
  })

  it('超时 ⇒ null,且不挂住调用方', async () => {
    const started = Date.now()
    const head = await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ hang: true }), timeoutMs: 50 })
    expect(head).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('spawn 直接抛 ⇒ null,不向上抛', async () => {
    const throwing = (() => { throw new Error('ENOENT: git not found') }) as unknown as typeof Bun.spawn
    await expect(readGitHead({ cwd: '/repo', spawn: throwing })).resolves.toBeNull()
  })
})
```

- [ ] **Step 5: 跑 FAIL,然后实现 git-head.ts**:

```ts
/**
 * git-head — 读 checkout 当前的 commit。
 *
 * 永不抛、永不挂:任何失败(不是 git 仓库、git 不在 PATH、超时、空输出)
 * 一律返回 null,由 stale-code 的"读不到就不动作"规则兜底。
 */

const DEFAULT_TIMEOUT_MS = 3_000

export async function readGitHead(deps: {
  cwd: string
  spawn?: typeof Bun.spawn
  timeoutMs?: number
}): Promise<string | null> {
  const spawn = deps.spawn ?? Bun.spawn
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const proc = spawn(['git', 'rev-parse', 'HEAD'], {
      cwd: deps.cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const code = await Promise.race([proc.exited, timedOut])
      if (code === 'timeout') { try { proc.kill() } catch { /* best effort */ } return null }
      if (code !== 0) return null
      const out = (await new Response(proc.stdout).text()).trim()
      return out || null
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 6: 跑 PASS** —— `bun run test src/daemon/self-restart/` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/self-restart/
git commit -m "feat(self-restart): 陈旧代码判定(纯函数)+ git HEAD 读取(带超时,永不抛)"
```

---

### Task 2: 两个空闲信号

**Files:**
- Create: `src/daemon/self-restart/activity-marker.ts`
- Test: `src/daemon/self-restart/activity-marker.test.ts`
- Modify: `src/core/session-manager.ts`(`inFlight` 私有字段在 `:144`;既有公开方法 `isInFlight(k)` 在 `:303`)
- Modify: `src/daemon/inbound/mw-messages.ts`
- Test: `src/daemon/inbound/mw-messages.test.ts`(既有文件,追加用例)

**Interfaces:**
- Produces: `makeActivityMarker(deps: { now: () => number }): { mark(): void; quietFor(nowMs: number): number }`(`quietFor` 返回距上次 mark 的毫秒数;从未 mark 过返回 `Number.POSITIVE_INFINITY`);
  `SessionManager.anyInFlight(): boolean`;
  `MessagesMwDeps` 新增可选 `markInboundActivity?: () => void`。
  Task 3 消费三者。

**为什么记在 `mw-messages`:** 管线顺序是 `trace → identity → access → dedup → messages → capture → typing → …`(`src/daemon/inbound/build.ts:46-63`)。`mw-messages` 在 **access + dedup 之后**(陌生人与重复消息不算)、且在**所有消费型中间件之前**(`mw-admin` / `mw-guard` / `mw-onboarding` 等,所以管理员命令也算"用户在活动")。

- [ ] **Step 1: 写 activity-marker 的失败测试**:

```ts
import { describe, it, expect } from 'vitest'
import { makeActivityMarker } from './activity-marker'

describe('makeActivityMarker', () => {
  it('从未 mark 过 ⇒ 静默时长为无穷(刚启动没有对话在进行)', () => {
    const m = makeActivityMarker({ now: () => 1000 })
    expect(m.quietFor(1000)).toBe(Number.POSITIVE_INFINITY)
  })

  it('mark 之后按当前时刻算静默时长', () => {
    const t = { ms: 1000 }
    const m = makeActivityMarker({ now: () => t.ms })
    m.mark()
    expect(m.quietFor(1000)).toBe(0)
    expect(m.quietFor(1500)).toBe(500)
  })

  it('再次 mark 会重置', () => {
    const t = { ms: 1000 }
    const m = makeActivityMarker({ now: () => t.ms })
    m.mark()
    t.ms = 5000
    m.mark()
    expect(m.quietFor(5200)).toBe(200)
  })
})
```

- [ ] **Step 2: 跑 FAIL,然后实现 activity-marker.ts**:

```ts
/**
 * activity-marker — 进程内的"最近一次入站"时刻(spec 2026-08-03 §2)。
 *
 * 只在内存里,不落盘、不查库:它唯一的用途是回答"现在是不是有人正在跟 bot
 * 说话",进程重启后从零开始正是想要的语义。
 */
export interface ActivityMarker {
  mark(): void
  /** 距上次 mark 的毫秒数;从未 mark 过 ⇒ Infinity(视为很久没人说话)。 */
  quietFor(nowMs: number): number
}

export function makeActivityMarker(deps: { now: () => number }): ActivityMarker {
  let lastAtMs: number | null = null
  return {
    mark() { lastAtMs = deps.now() },
    quietFor(nowMs) {
      return lastAtMs === null ? Number.POSITIVE_INFINITY : nowMs - lastAtMs
    },
  }
}
```

- [ ] **Step 3: 给 SessionManager 加 `anyInFlight()`** —— 紧挨既有的 `isInFlight(k)`(`:303`)之后加:

```ts
  /**
   * 是否有任何在途轮次(不分 chat)。self-restart 用它判断"现在能不能安全
   * 退出" —— 逐 key 的 isInFlight 回答不了这个问题。
   */
  anyInFlight(): boolean {
    for (const n of this.inFlight.values()) if (n > 0) return true
    return false
  }
```

- [ ] **Step 4: 给 mw-messages 加可选回调** —— 在 `MessagesMwDeps` 上加:

```ts
  /**
   * 记一笔"有入站活动"。此处是语义正确的位置:access + dedup 之后(陌生人
   * 与重复消息不算),且在所有消费型中间件之前(管理员命令也算用户在活动)。
   * 可选:省略即不记录,既有测试与 e2e 不受影响。
   */
  markInboundActivity?: () => void
```

并在该中间件 handler 的**最前面**(任何 `await next()` 之前)调用:

```ts
    try { deps.markInboundActivity?.() } catch { /* 绝不能因为记一笔就打断入站管线 */ }
```

- [ ] **Step 5: 写 mw-messages 的追加测试** —— 追加到 `src/daemon/inbound/mw-messages.test.ts`(照该文件既有用例构造 deps 的写法):

```ts
it('每条入站都记一笔活动,且回调抛错不打断管线', async () => {
  let marks = 0
  const mw = makeMwMessages({
    ...baseMessagesDeps(),          // 照该文件既有 fixture 写法
    markInboundActivity: () => { marks += 1; throw new Error('boom') },
  })
  const next = vi.fn(async () => {})
  await expect(mw(ctx(), next)).resolves.toBeUndefined()
  expect(marks).toBe(1)
  expect(next).toHaveBeenCalledTimes(1)   // 抛错没有阻断后续中间件
})
```

> 若该文件没有名为 `baseMessagesDeps()` / `ctx()` 的辅助,照它既有用例构造 deps 与 ctx 的写法照搬一份并复用;断言语义不变。

- [ ] **Step 6: 跑 PASS** —— `bun run test src/daemon/self-restart/ src/daemon/inbound/mw-messages.test.ts src/core/session-manager.test.ts` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/self-restart/activity-marker.ts src/daemon/self-restart/activity-marker.test.ts src/core/session-manager.ts src/daemon/inbound/mw-messages.ts src/daemon/inbound/mw-messages.test.ts
git commit -m "feat(self-restart): 两个空闲信号 —— SessionManager.anyInFlight + 入站活动标记"
```

---

### Task 3: 接线(挂进既有的 60 秒 timer)

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`(既有 60s `setInterval` 在 `:575-580`,用于 `sessionManager.sweepIdle()`)
- Modify: `src/daemon/main.ts`(既有 `requestRestart` 在 `:213`)
- Test: `src/daemon/self-restart/wire.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `shouldSelfRestart` / `readGitHead` / `BOOT_GRACE_MS` / `MIN_RESTART_INTERVAL_MS`;Task 2 的 `makeActivityMarker` / `SessionManager.anyInFlight()` / `MessagesMwDeps.markInboundActivity`。
- Produces: `makeSelfRestartCheck(deps: SelfRestartDeps): () => Promise<void>` —— 每次调用做一次检查,该重启就调 `deps.requestRestart()`。`SelfRestartDeps = { cwd: string; loadedHead: string | null; now: () => number; bootAtMs: number; anyInFlight: () => boolean; quietFor: (nowMs: number) => number; requestRestart: () => void; log: (tag: string, line: string) => void; readHead?: typeof readGitHead }`。

**接线要点(已核实,照做):**
- **不要新增定时器**。`bootstrap/index.ts:575` 已有一个 60 秒、已 `unref()` 的 `setInterval`(注释说明它是 idle sweep)。把本检查加进同一个回调里。
- `requestRestart` 定义在 `main.ts:213`(优雅关闭 → `exit(0)` → launchd `KeepAlive` 重生),但 bootstrap 拿不到它。给 bootstrap 的 deps 加一个**可选** `requestRestart?: () => void`,由 `main.ts` 传入。省略时本机制整体禁用(测试与 e2e 不受影响)。
- 启动时读一次 HEAD 作为 `loadedHead`(`await readGitHead({ cwd: <repo root> })`)。**读不到就是 null**,`shouldSelfRestart` 会因此永不触发 —— 这正是期望的失败方向。
- **在 `wire.ts` 顶部注释里写明这条前提**(spec §3 要求):整套机制成立的基础是 launchd plist 用 `KeepAlive => true` 的**布尔形式** —— 干净退出(exit 0)也会被拉起。若哪天改成 `{ SuccessfulExit: false }` 字典形式,daemon 退出后**不会**被拉起,本机制会把 bot 直接关掉而不是重启。这是本设计最危险的隐含假设,必须留下痕迹。

- [ ] **Step 1: 写失败测试** —— `src/daemon/self-restart/wire.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeSelfRestartCheck } from './wire'
import { BOOT_GRACE_MS } from './stale-code'

const BOOT = 1_000_000
function setup(over: Record<string, unknown> = {}) {
  const t = { ms: BOOT + BOOT_GRACE_MS }
  const restarts: number[] = []
  const check = makeSelfRestartCheck({
    cwd: '/repo',
    loadedHead: 'aaa111',
    now: () => t.ms,
    bootAtMs: BOOT,
    anyInFlight: () => false,
    quietFor: () => Number.POSITIVE_INFINITY,
    requestRestart: () => { restarts.push(t.ms) },
    log: () => {},
    readHead: async () => 'bbb222',
    ...over,
  } as never)
  return { t, restarts, check }
}

describe('makeSelfRestartCheck', () => {
  it('陈旧 + 空闲 ⇒ 触发既有的 requestRestart', async () => {
    const { restarts, check } = setup()
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('有在途轮次 ⇒ 不重启', async () => {
    const { restarts, check } = setup({ anyInFlight: () => true })
    await check()
    expect(restarts).toEqual([])
  })

  it('最近 2 分钟内有入站 ⇒ 不重启', async () => {
    const { restarts, check } = setup({ quietFor: () => 119_000 })
    await check()
    expect(restarts).toEqual([])
  })

  it('刚好静默满 2 分钟 ⇒ 重启', async () => {
    const { restarts, check } = setup({ quietFor: () => 120_000 })
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('只触发一次 —— 重启已在进行,后续 tick 不再重复请求', async () => {
    const { restarts, check } = setup()
    await check()
    await check()
    await check()
    expect(restarts).toHaveLength(1)
  })

  it('读 HEAD 失败 ⇒ 不重启也不抛', async () => {
    const { restarts, check } = setup({ readHead: async () => null })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  it('readHead 抛异常 ⇒ 吞掉,不打断调用它的 tick', async () => {
    const { restarts, check } = setup({ readHead: async () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
    expect(restarts).toEqual([])
  })

  it('requestRestart 抛异常 ⇒ 吞掉', async () => {
    const { check } = setup({ requestRestart: () => { throw new Error('boom') } })
    await expect(check()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun run test src/daemon/self-restart/wire.test.ts`,期望红。

- [ ] **Step 3: 实现** —— `src/daemon/self-restart/wire.ts`:

```ts
/**
 * self-restart 接线 —— 每个 tick 做一次"我是不是在跑旧代码"的检查。
 *
 * 挂在 bootstrap 里既有的 60 秒 idle-sweep timer 上,不新增定时器;触发的是
 * main.ts 既有的 requestRestart(优雅关闭 → exit(0) → launchd KeepAlive 重生),
 * 不新增重启机制。
 *
 * 整个函数吞掉自己的一切异常:它跑在 daemon 的周期回调里,从这里抛出去会
 * 打断那个 tick 上的其它工作。
 */
import { shouldSelfRestart } from './stale-code'
import { readGitHead } from './git-head'

/** 空闲要求:最近这么久没有任何入站消息。 */
export const IDLE_QUIET_MS = 120_000

export interface SelfRestartDeps {
  cwd: string
  loadedHead: string | null
  now: () => number
  bootAtMs: number
  anyInFlight: () => boolean
  quietFor: (nowMs: number) => number
  requestRestart: () => void
  log: (tag: string, line: string) => void
  readHead?: typeof readGitHead
}

export function makeSelfRestartCheck(deps: SelfRestartDeps): () => Promise<void> {
  const readHead = deps.readHead ?? readGitHead
  // 重启是异步的(优雅关闭要时间),期间 tick 还会继续跑 —— 不加这个闩,
  // 每 60 秒都会再请求一次重启。
  let requested = false

  return async function check(): Promise<void> {
    try {
      if (requested) return
      const nowMs = deps.now()
      const currentHead = await readHead({ cwd: deps.cwd })
      const idle = !deps.anyInFlight() && deps.quietFor(nowMs) >= IDLE_QUIET_MS
      if (!shouldSelfRestart({
        loadedHead: deps.loadedHead,
        currentHead,
        idle,
        nowMs,
        bootAtMs: deps.bootAtMs,
        lastRestartAtMs: null,
      })) return

      requested = true
      deps.log('SELF_RESTART', `code on disk moved ${deps.loadedHead?.slice(0, 7)} → ${currentHead?.slice(0, 7)}; idle, restarting to load it`)
      deps.requestRestart()
    } catch {
      // 静默:这套机制绝不能成为新的故障源。
    }
  }
}
```

> 注:`lastRestartAtMs` 传 `null` 是刻意的 —— 本进程只会请求一次重启(`requested` 闩),重启后是新进程。`MIN_RESTART_INTERVAL_MS` 那条规则由 `shouldSelfRestart` 保留,供将来若有跨进程记录时使用;当前调用方永远传 null,测试已覆盖该分支。

- [ ] **Step 4: 跑 PASS** —— `bun run test src/daemon/self-restart/` 全绿。

- [ ] **Step 5: 接进 bootstrap 与 main** ——

在 `src/daemon/bootstrap/index.ts`:
1. 启动时读一次 HEAD 作为 `loadedHead`;
2. 构造 `makeSelfRestartCheck(...)`,`quietFor` 来自 `makeActivityMarker`,`anyInFlight` 来自 `sessionManager.anyInFlight`;
3. 把 marker 的 `mark` 作为 `markInboundActivity` 传给 mw-messages 的 deps;
4. **把检查加进 `:575` 那个既有的 60 秒 `setInterval` 回调里**,不新增 timer。现有代码是:

```ts
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, 60_000)
  idleSweepTimer.unref()
```

改为(只加一行,`selfRestartCheck` 自己吞异常,故不需要 `.catch`):

```ts
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
    void selfRestartCheck?.()
  }, 60_000)
  idleSweepTimer.unref()
```

5. `deps.requestRestart` 缺省时**整体跳过**本机制(不读 HEAD、不建 check)。

在 `src/daemon/main.ts`:把既有的 `requestRestart`(`:213`)一并传给 `buildBootstrap`。

- [ ] **Step 6: 全量验证** —— `bun run test` 全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 7: 真机冒烟(手动,写进报告)** ——
```bash
# 1. 确认 daemon 在跑,记下 pid
bun cli.ts service status --json
# 2. 制造一次"磁盘比进程新":在 dev 上做一个空提交
git commit --allow-empty -m "chore: self-restart smoke"
# 3. 等待(宽限期 5 分钟 + 静默 2 分钟),期间不要给 bot 发消息
# 4. 确认 pid 变了,且日志里有 SELF_RESTART 那一行
grep SELF_RESTART ~/.claude/channels/wechat/channel.log | tail -2
```
把观察到的 pid 变化与日志行贴进报告。**若 5 分钟宽限期让冒烟太慢,可临时把 `BOOT_GRACE_MS` 调小验证后改回 —— 但必须在报告里写明改回了。**

- [ ] **Step 8: Commit**

```bash
git add src/daemon/self-restart/wire.ts src/daemon/self-restart/wire.test.ts src/daemon/bootstrap/index.ts src/daemon/main.ts
git commit -m "feat(self-restart): 接线 —— 挂进既有 60s tick,空闲时触发既有的 KeepAlive 重生路径"
```
