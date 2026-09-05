# CC 桌宠 Phase B(真实事件桥)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CC「真的知道自己在做什么」:daemon 暴露主人会话的 turn 生命周期、主人最近一次联系时间、待决权限;桌面用它们驱动 lit / unlit、thinking / working / done、permission 卡片。一个权限,两个呈现面。

**Architecture:** daemon 侧一个内存信号表 `PetSignals`(最近 tool_call / turn 结束 / 主人联系时间)+ 纯推导 `pet-turn.ts` + 三条路由(`GET /v1/companion/pet` trusted;`GET /v1/permissions/pending`、`POST /v1/permissions/resolve` admin);`PendingPermissions` 只加 `meta` 与 `list()`,`consume()` 不变,微信与桌面都调它。桌面侧一个 2 s / 10 s 的 pet 轮询器、一个纯的事件推导(`runtime-events.js`,边沿检测)、一张权限卡片,接进 Phase A 的 `createPet`。Tauri 加一个 `pet_permission_resolve` 命令(operator token,照 `agent_converse`)。

**Tech Stack:** TypeScript on Bun(daemon);静态 ES modules + `// @ts-check`(桌面);Vitest;Rust/Tauri(一个命令)。

**Spec:** `docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md` §5、§6、§7 Phase B 表、§8 Phase B 验收。

## Global Constraints

- 所有状态由真实事件驱动:`thinking` = 主人会话在飞;`working` = 在飞且 `WORKING_WINDOW_MS = 5_000` 内有 `tool_call`;`permission` = 有待决权限;`done` = `last_done_at` **前进**(边沿,播一次);微光 = `owner_last_contact_at` **前进**;退潮 = `now − owner_last_contact_at > LIT_DIM_MS`(`LIT_DIM_MS = 20 * 60_000`,常量,不锁死)且 turn idle 且无待决权限。**不允许**任何定时器发明活动。
- `owner_last_contact_at = max(主人微信会话 latestInboundTs, 最近一次 /v1/companion/converse, 最近一次 permission resolve)`。
- 首次打开窗口按 `owner_last_contact_at` 直接算 form,**不播转场**;之后只在变化时播。
- 一个权限一个事实:桌面 resolve 与微信「y/n <hash>」都走 `PendingPermissions.consume()`;不复制任何决策逻辑。`GET /v1/permissions/pending` 与 `POST /v1/permissions/resolve` 是 **admin** 档;`GET /v1/companion/pet` 是 trusted(桌面 FILE token),其 `pending_permissions` 只含 `hash / prompt / since / expires_at`。
- 桌面 resolve 走 Tauri 命令 `pet_permission_resolve`(operator token,照 `agent_converse` 的读法);浏览器预览(无 Tauri)时卡片只显示、不出按钮。
- 轮询节奏(spec §5.3):pet 端点 lit 或 turn ≠ idle 或有待决权限 → 2 s;否则 10 s;窗口不可见 → 停。presence 仍 20 s。
- 权限卡片:真实 `<button>`,Tab 可达,Enter = 允许(焦点在允许上)、Esc 关闭展开;`查看` 就地展开 prompt 全文(等宽、可滚动、不截断);多条只显示最早一条 + 计数;拒绝**不是** `error`。
- Phase A 的 `pet/` 模块 API 不改(只新增 `bridge/` 与 `permission/` 下的文件);`presence-map.js` 不改;`calibration.ts`、journal、wish / intro / plan 不动。
- 每个提交全量测试绿、`bun run typecheck` 与 `bun run depcheck` 干净;最后一个任务另跑 `cargo check`。报告前 `git status --short` 为空。
- 提交信息一行中文;trailer:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01UyRSmFJFdAc7VP1TzUUdS7`。

---

### Task 1: `PendingPermissions` 带 meta + `list()`;ilink 暴露 list / resolve

**Files:**
- Modify: `src/daemon/pending-permissions.ts`
- Modify: `src/daemon/ilink-glue.ts`(`askUser` 传 meta;`IlinkAdapter` 加两个方法)
- Test: `src/daemon/pending-permissions.test.ts`(追加)、`src/daemon/ilink-glue.test.ts`(追加一条)

**Interfaces:**
- Produces:

```ts
export interface PendingPermissionMeta { chatId: string; prompt: string }
export interface PendingPermissionView { hash: string; chatId: string; prompt: string; since: string; expires_at: string }
class PendingPermissions {
  register(hash: string, timeoutMs: number, meta?: PendingPermissionMeta): Promise<PermissionDecision>   // meta 可选:老调用方不传也能用
  list(): PendingPermissionView[]        // 按 since 升序;没有 meta 的条目 prompt=''、chatId=''
  // consume / fail / sweep / size 不变
}
// IlinkAdapter
listPendingPermissions(): PendingPermissionView[]
resolvePermission(hash: string, decision: 'allow' | 'deny'): boolean    // = pending.consume(hash, decision)
```

- [ ] **Step 1: 写失败测试**

`src/daemon/pending-permissions.test.ts` 末尾追加:

```ts
describe('PendingPermissions.list (CC 桌宠 Phase B)', () => {
  it('register 带 meta → list 返回 hash / chatId / prompt / since / expires_at,按 since 升序;consume 后消失', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T10:00:00.000Z'))
    try {
      const p = new PendingPermissions()
      void p.register('bbbbb', 60_000, { chatId: 'owner', prompt: 'Bash: rm -rf ./tmp' })
      vi.setSystemTime(new Date('2026-09-05T10:00:01.000Z'))
      void p.register('aaaaa', 30_000, { chatId: 'owner', prompt: 'Write: notes.md' })
      expect(p.list()).toEqual([
        { hash: 'bbbbb', chatId: 'owner', prompt: 'Bash: rm -rf ./tmp', since: '2026-09-05T10:00:00.000Z', expires_at: '2026-09-05T10:01:00.000Z' },
        { hash: 'aaaaa', chatId: 'owner', prompt: 'Write: notes.md', since: '2026-09-05T10:00:01.000Z', expires_at: '2026-09-05T10:00:31.000Z' },
      ])
      expect(p.consume('bbbbb', 'allow')).toBe(true)
      expect(p.list().map(x => x.hash)).toEqual(['aaaaa'])
    } finally { vi.useRealTimers() }
  })
  it('没传 meta 的老调用方:list 仍有这一条,prompt 与 chatId 为空串', () => {
    const p = new PendingPermissions()
    void p.register('ccccc', 1000)
    expect(p.list()).toMatchObject([{ hash: 'ccccc', chatId: '', prompt: '' }])
  })
})
```

`src/daemon/ilink-glue.test.ts` 追加(用文件里现有的 adapter 夹具名;若夹具函数叫别的名字按文件改,断言不变):

```ts
describe('permission surface for the desktop (CC 桌宠 Phase B)', () => {
  it('askUser 注册后 listPendingPermissions 能看到 prompt;resolvePermission 走同一个 consume', async () => {
    const { adapter } = makeAdapterFixture()             // 现有夹具
    const p = adapter.askUser('owner', 'Bash: ls', 'abcde', 60_000)
    expect(adapter.listPendingPermissions()).toMatchObject([{ hash: 'abcde', chatId: 'owner', prompt: 'Bash: ls' }])
    expect(adapter.resolvePermission('abcde', 'deny')).toBe(true)
    expect(await p).toBe('deny')
    expect(adapter.listPendingPermissions()).toEqual([])
    expect(adapter.resolvePermission('abcde', 'allow')).toBe(false)   // 已经没了
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/pending-permissions.test.ts src/daemon/ilink-glue.test.ts`
Expected: FAIL —— `list` / `listPendingPermissions` 不存在。

- [ ] **Step 3: 实现**

`src/daemon/pending-permissions.ts`:`Entry` 加 `registeredAt: number; meta: PendingPermissionMeta | null`;`register(hash, timeoutMs, meta = undefined)` 存 `registeredAt: Date.now()`、`meta: meta ?? null`;新增:

```ts
export interface PendingPermissionMeta { chatId: string; prompt: string }
export interface PendingPermissionView { hash: string; chatId: string; prompt: string; since: string; expires_at: string }
  list(): PendingPermissionView[] {
    return Array.from(this.entries.entries())
      .map(([hash, e]) => ({ hash, chatId: e.meta?.chatId ?? '', prompt: e.meta?.prompt ?? '', since: new Date(e.registeredAt).toISOString(), expires_at: new Date(e.expiresAt).toISOString() }))
      .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
  }
```

`src/daemon/ilink-glue.ts`:`askUser` 里 `pending.register(hash, timeoutMs)` → `pending.register(hash, timeoutMs, { chatId, prompt })`;`IlinkAdapter` 接口加 `listPendingPermissions(): PendingPermissionView[]` 与 `resolvePermission(hash: string, decision: 'allow' | 'deny'): boolean`;返回对象里紧挨 `handlePermissionReply` 加:

```ts
    listPendingPermissions() { return pending.list() },
    resolvePermission(hash, decision) { return pending.consume(hash, decision) },
```

(`import type { PendingPermissionView } from './pending-permissions'`。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/pending-permissions.test.ts src/daemon/ilink-glue.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/pending-permissions.ts src/daemon/pending-permissions.test.ts src/daemon/ilink-glue.ts src/daemon/ilink-glue.test.ts
git commit -m "pending-permissions:带上 prompt 与时间,能列出来;ilink 暴露 list / resolve —— 桌面和微信调同一个 consume"
```

---

### Task 2: `PetSignals` + `pet-turn.ts`(纯)+ coordinator 的 tool_call 钩子

**Files:**
- Create: `src/core/pet-turn.ts` + `src/core/pet-turn.test.ts`
- Create: `src/daemon/pet-signals.ts` + `src/daemon/pet-signals.test.ts`
- Modify: `src/core/agent-provider.ts`(`CollectTurnOpts.onEvent?`)
- Modify: `src/core/conversation-coordinator.ts`(`ConversationCoordinatorDeps.onTurnEvent?`;三处 `collectTurn(...)` 传 `onEvent`)
- Test: `src/core/conversation-coordinator.test.ts`(追加一条:solo 回合里 `tool_call` 事件会调 `onTurnEvent(chatId, ev)`)

**Interfaces:**
- Produces:

```ts
// core/pet-turn.ts(纯)
export const WORKING_WINDOW_MS = 5_000
export const LIT_DIM_MS = 20 * 60_000
export type PetPhase = 'idle' | 'thinking' | 'working' | 'permission'
export interface PetTurnInputs {
  nowMs: number
  inFlight: boolean
  inFlightSinceMs: number | null
  lastToolCallAtMs: number | null
  lastResultAtMs: number | null
  ownerLastContactAtMs: number | null
  pending: Array<{ hash: string; prompt: string; since: string; expires_at: string }>
}
export interface PetTurnPayload {
  owner_last_contact_at: string | null
  turn: { phase: PetPhase; since: string | null }
  last_done_at: string | null
  pending_permissions: Array<{ hash: string; prompt: string; since: string; expires_at: string }>
}
export function derivePetTurn(i: PetTurnInputs): PetTurnPayload
// daemon/pet-signals.ts(内存,无 I/O)
export interface PetSignals {
  noteToolCall(chatId: string, nowMs?: number): void
  noteTurnStart(chatId: string, nowMs?: number): void
  noteTurnEnd(chatId: string, nowMs?: number): void
  noteContact(nowMs?: number): void
  snapshot(chatId: string): { inFlightSinceMs: number | null; lastToolCallAtMs: number | null; lastResultAtMs: number | null; lastContactMs: number | null }
}
export function makePetSignals(now?: () => number): PetSignals
// core/agent-provider.ts
export interface CollectTurnOpts { timeoutMs?: number; onEvent?: (ev: AgentEvent) => void }   // 每个事件在 apply 之前调一次;抛错不影响回合
// core/conversation-coordinator.ts
ConversationCoordinatorDeps.onTurnEvent?: (chatId: string, ev: AgentEvent) => void
```

推导规则(`derivePetTurn`):`pending.length > 0` → `permission`(since = 最早 pending 的 since);否则 `inFlight && lastToolCallAtMs !== null && nowMs − lastToolCallAtMs <= WORKING_WINDOW_MS` → `working`(since = ISO(lastToolCallAtMs));否则 `inFlight` → `thinking`(since = ISO(inFlightSinceMs));否则 `idle`(since null)。`last_done_at = ISO(lastResultAtMs)`;`owner_last_contact_at = ISO(ownerLastContactAtMs)`。

- [ ] **Step 1: 写失败测试**

`src/core/pet-turn.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { derivePetTurn, WORKING_WINDOW_MS, LIT_DIM_MS } from './pet-turn'

const T0 = Date.parse('2026-09-05T10:00:00.000Z')
const base = { nowMs: T0, inFlight: false, inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, ownerLastContactAtMs: null, pending: [] }

describe('derivePetTurn', () => {
  it('常量', () => { expect(WORKING_WINDOW_MS).toBe(5_000); expect(LIT_DIM_MS).toBe(20 * 60_000) })
  it('空闲:全 null', () => {
    expect(derivePetTurn(base)).toEqual({ owner_last_contact_at: null, turn: { phase: 'idle', since: null }, last_done_at: null, pending_permissions: [] })
  })
  it('在飞没工具 → thinking(since = 起飞时间);5 秒内有 tool_call → working;过了 5 秒回 thinking', () => {
    const t = derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 3000 })
    expect(t.turn).toEqual({ phase: 'thinking', since: '2026-09-05T09:59:57.000Z' })
    expect(derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 3000, lastToolCallAtMs: T0 - 1000 }).turn).toEqual({ phase: 'working', since: '2026-09-05T09:59:59.000Z' })
    expect(derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 30000, lastToolCallAtMs: T0 - 6000 }).turn.phase).toBe('thinking')
  })
  it('不在飞时旧的 tool_call 不算 working', () => {
    expect(derivePetTurn({ ...base, lastToolCallAtMs: T0 - 1000 }).turn.phase).toBe('idle')
  })
  it('有待决权限 → permission 压过一切,since = 最早那条', () => {
    const p = [{ hash: 'b', prompt: 'x', since: '2026-09-05T09:59:50.000Z', expires_at: 'e' }, { hash: 'a', prompt: 'y', since: '2026-09-05T09:59:40.000Z', expires_at: 'e' }]
    const t = derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0, lastToolCallAtMs: T0, pending: p })
    expect(t.turn).toEqual({ phase: 'permission', since: '2026-09-05T09:59:40.000Z' })
    expect(t.pending_permissions).toEqual(p)
  })
  it('last_done_at / owner_last_contact_at 是 ISO', () => {
    const t = derivePetTurn({ ...base, lastResultAtMs: T0 - 500, ownerLastContactAtMs: T0 - 60_000 })
    expect(t.last_done_at).toBe('2026-09-05T09:59:59.500Z'); expect(t.owner_last_contact_at).toBe('2026-09-05T09:59:00.000Z')
  })
})
```

`src/daemon/pet-signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makePetSignals } from './pet-signals'

describe('makePetSignals', () => {
  it('按 chat 记 tool_call / 起飞 / 结束;contact 全局;snapshot 缺省 null', () => {
    let now = 1000
    const s = makePetSignals(() => now)
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, lastContactMs: null })
    s.noteTurnStart('c1'); now = 1500; s.noteToolCall('c1'); now = 2000; s.noteContact()
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: 1000, lastToolCallAtMs: 1500, lastResultAtMs: null, lastContactMs: 2000 })
    now = 2500; s.noteTurnEnd('c1')
    expect(s.snapshot('c1')).toMatchObject({ inFlightSinceMs: null, lastResultAtMs: 2500 })
    expect(s.snapshot('c2')).toMatchObject({ lastToolCallAtMs: null, lastContactMs: 2000 })
  })
  it('显式 nowMs 参数优先于时钟', () => {
    const s = makePetSignals(() => 1)
    s.noteTurnEnd('c', 99); expect(s.snapshot('c').lastResultAtMs).toBe(99)
  })
})
```

`src/core/conversation-coordinator.test.ts` 追加(照文件里 solo 回合的现有夹具:一个 fake provider 的 `dispatch` 返回事件流;若夹具名不同按文件改):

```ts
describe('onTurnEvent (CC 桌宠 Phase B)', () => {
  it('solo 回合里每个 provider 事件都转给 onTurnEvent(chatId, ev),tool_call 在内;钩子抛错不影响回合', async () => {
    const seen: Array<[string, string]> = []
    const { coordinator, /* …夹具其它返回值… */ } = makeCoordinatorFixture({
      events: [{ kind: 'init', sessionId: 's' }, { kind: 'tool_call', tool: 'Bash' }, { kind: 'text', text: 'ok' }, { kind: 'result', sessionId: 's', numTurns: 1, durationMs: 5 }],
      onTurnEvent: (chatId, ev) => { seen.push([chatId, ev.kind]); if (ev.kind === 'text') throw new Error('boom') },
    })
    await coordinator.dispatch(inboundMsg('chat-1', 'hi'))
    expect(seen).toEqual([['chat-1', 'init'], ['chat-1', 'tool_call'], ['chat-1', 'text'], ['chat-1', 'result']])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/pet-turn.test.ts src/daemon/pet-signals.test.ts src/core/conversation-coordinator.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/core/pet-turn.ts`:

```ts
/**
 * pet-turn.ts — CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。纯函数:
 * 输入是 daemon 里真实存在的几个时间戳与旗标,输出是桌面直接消费的 payload。
 * 不看 presence(那是「处境」,另一条线);不发明任何东西。
 */
export const WORKING_WINDOW_MS = 5_000
/** lit → unlit 的退潮时间。owner 拍板 v1 不锁死,先当常量。 */
export const LIT_DIM_MS = 20 * 60_000

export type PetPhase = 'idle' | 'thinking' | 'working' | 'permission'
export interface PendingPermissionItem { hash: string; prompt: string; since: string; expires_at: string }
export interface PetTurnInputs {
  nowMs: number
  inFlight: boolean
  inFlightSinceMs: number | null
  lastToolCallAtMs: number | null
  lastResultAtMs: number | null
  ownerLastContactAtMs: number | null
  pending: PendingPermissionItem[]
}
export interface PetTurnPayload {
  owner_last_contact_at: string | null
  turn: { phase: PetPhase; since: string | null }
  last_done_at: string | null
  pending_permissions: PendingPermissionItem[]
}

const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())

export function derivePetTurn(i: PetTurnInputs): PetTurnPayload {
  let turn: PetTurnPayload['turn'] = { phase: 'idle', since: null }
  if (i.pending.length > 0) {
    const earliest = [...i.pending].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))[0]!
    turn = { phase: 'permission', since: earliest.since }
  } else if (i.inFlight && i.lastToolCallAtMs !== null && i.nowMs - i.lastToolCallAtMs <= WORKING_WINDOW_MS) {
    turn = { phase: 'working', since: iso(i.lastToolCallAtMs) }
  } else if (i.inFlight) {
    turn = { phase: 'thinking', since: iso(i.inFlightSinceMs) }
  }
  return { owner_last_contact_at: iso(i.ownerLastContactAtMs), turn, last_done_at: iso(i.lastResultAtMs), pending_permissions: i.pending }
}
```

`src/daemon/pet-signals.ts`:

```ts
/**
 * pet-signals.ts — 桌宠要看的几个真实时间戳,内存里记一下(spec §5.1「不新增表」)。
 * 谁写:coordinator 的 onTurnEvent(tool_call)、bootstrap 的 recordTurn(回合结束)、
 * converse 路由与 permission resolve(主人联系)。谁读:GET /v1/companion/pet。
 */
export interface PetSignals {
  noteToolCall(chatId: string, nowMs?: number): void
  noteTurnStart(chatId: string, nowMs?: number): void
  noteTurnEnd(chatId: string, nowMs?: number): void
  noteContact(nowMs?: number): void
  snapshot(chatId: string): { inFlightSinceMs: number | null; lastToolCallAtMs: number | null; lastResultAtMs: number | null; lastContactMs: number | null }
}

export function makePetSignals(now: () => number = () => Date.now()): PetSignals {
  const toolCall = new Map<string, number>()
  const started = new Map<string, number>()
  const ended = new Map<string, number>()
  let contact: number | null = null
  const t = (ms?: number) => (typeof ms === 'number' ? ms : now())
  return {
    noteToolCall(chatId, ms) { toolCall.set(chatId, t(ms)) },
    noteTurnStart(chatId, ms) { started.set(chatId, t(ms)) },
    noteTurnEnd(chatId, ms) { ended.set(chatId, t(ms)); started.delete(chatId) },
    noteContact(ms) { contact = Math.max(contact ?? 0, t(ms)) },
    snapshot(chatId) {
      return { inFlightSinceMs: started.get(chatId) ?? null, lastToolCallAtMs: toolCall.get(chatId) ?? null, lastResultAtMs: ended.get(chatId) ?? null, lastContactMs: contact }
    },
  }
}
```

`src/core/agent-provider.ts`:`CollectTurnOpts` 加 `onEvent?: (ev: AgentEvent) => void`;`collectTurn` 里在 `apply(ev)` 之前 `try { opts?.onEvent?.(ev) } catch { /* 观察者不许影响回合 */ }`(在每个消费事件的循环里;`return()` 路径不用)。

`src/core/conversation-coordinator.ts`:`ConversationCoordinatorDeps` 加 `onTurnEvent?: (chatId: string, ev: AgentEvent) => void`;三处 `collectTurn(xxx.dispatch(...), { timeoutMs: ... })`(约 L571 solo、L860 parallel、L979 chatroom)改为传 `{ timeoutMs: ..., onEvent: (ev) => deps.onTurnEvent?.(chatId, ev) }`(`chatId` 用该作用域里的入站 chat id 变量名)。不加别的。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/pet-turn.test.ts src/daemon/pet-signals.test.ts src/core/conversation-coordinator.test.ts src/core/agent-provider.test.ts && bun run typecheck && bun run depcheck`
Expected: PASS(`pet-signals.ts` 暂时无生产引用会触发 `no-orphans`?—— 它有 test 文件不算 orphan?规则 `pathNot` 只排除 test 自身;被 test import 的模块**算**有依赖。若 depcheck 仍报 orphan,在 Task 3 接线前先接受该 warning 不算错误 —— 规则是 `error` 级则把 Task 3 的 `main.ts` 一行 `makePetSignals()` 提前到本任务)。

- [ ] **Step 5: 提交**

```bash
git add src/core/pet-turn.ts src/core/pet-turn.test.ts src/daemon/pet-signals.ts src/daemon/pet-signals.test.ts src/core/agent-provider.ts src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts
git commit -m "pet-turn:主人会话在飞 / 5 秒内有工具 / 有待决权限 → thinking / working / permission,纯推导;coordinator 把每个事件转给 onTurnEvent"
```

---

### Task 3: 路由 + 接线

**Files:**
- Create: `src/daemon/internal-api/routes-pet.ts` + `routes-pet.test.ts`
- Create: `src/daemon/internal-api/routes-permissions.ts` + `routes-permissions.test.ts`
- Modify: `src/daemon/internal-api/routes.ts`(挂两张表)、`route-tiers.ts`、`types.ts`(deps + setter)、`index.ts`(setter)
- Modify: `src/daemon/main.ts`(`makePetSignals()`、`permissions` deps、`setPetTurn`)、`src/daemon/bootstrap/index.ts`(`recordTurn` → `noteTurnEnd`;coordinator deps `onTurnEvent`;`companionConverse` 包一层 `noteContact`)、`src/daemon/wiring/pipeline-deps.ts`(在飞判断用 `resolveOwnerSessionKey`)

**Interfaces:**
- Consumes: Task 1 `listPendingPermissions / resolvePermission`;Task 2 `derivePetTurn / makePetSignals / onTurnEvent`。
- Produces:

```ts
// internal-api/types.ts
InternalApiDeps.petTurn?: () => Promise<import('../../core/pet-turn').PetTurnPayload>
InternalApiDeps.permissions?: { list(): PendingPermissionView[]; resolve(hash: string, decision: 'allow' | 'deny'): boolean }
InternalApi.setPetTurn(fn: NonNullable<InternalApiDeps['petTurn']>): void
// routes
'GET /v1/companion/pet'        → 200 PetTurnPayload | 503 { error: 'pet_not_wired' }        (trusted)
'GET /v1/permissions/pending'  → 200 { items: PendingPermissionView[] } | 503 { error: 'permissions_not_wired' }   (admin)
'POST /v1/permissions/resolve' → body { hash, decision:'allow'|'deny' } → 200 { ok: boolean } | 400 { error: 'bad_request' } | 503   (admin)
```

`petTurn()` 的组装(在 `pipeline-deps.ts` 里,和 `companionConverse` 挨着,因为 `ownerChatId` / `resolveOwnerSessionKey` / `boot.sessionManager` 都在那儿):

```ts
  const petTurn = async (): Promise<PetTurnPayload> => {
    const ownerChatId = loadCompanionConfig(stateDir).default_chat_id ?? null   // 与 converse 同源
    const now = Date.now()
    if (!ownerChatId) return derivePetTurn({ nowMs: now, inFlight: false, inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, ownerLastContactAtMs: petSignals.snapshot('').lastContactMs, pending: ilink.listPendingPermissions() })
    const key = resolveOwnerSessionKey(ownerChatId, { resolveProject: boot.resolve, getMode: (c) => boot.coordinator.getMode(c), defaultProviderId: boot.defaultProviderId })
    const inFlight = !!key && boot.sessionManager.isInFlight({ alias: key.alias, providerId: key.providerId, chatId: ownerChatId })
    const s = petSignals.snapshot(ownerChatId)
    const inboundIso = await messagesStore.latestInboundTs(ownerChatId).catch(() => null)
    const inboundMs = inboundIso ? Date.parse(inboundIso) : NaN
    const contact = Math.max(Number.isFinite(inboundMs) ? inboundMs : -1, s.lastContactMs ?? -1)
    return derivePetTurn({ nowMs: now, inFlight, inFlightSinceMs: s.inFlightSinceMs, lastToolCallAtMs: s.lastToolCallAtMs, lastResultAtMs: s.lastResultAtMs, ownerLastContactAtMs: contact >= 0 ? contact : null, pending: ilink.listPendingPermissions() })
  }
```

`petSignals` 由 `main.ts` `makePetSignals()` 创建并传进 pipeline-deps 与 bootstrap:bootstrap 的 `recordTurn`(约 L943)末尾加 `petSignals.noteTurnEnd(record.chatId, record.endedAt)`;coordinator deps 加 `onTurnEvent: (chatId, ev) => { if (ev.kind === 'init') petSignals.noteTurnStart(chatId); if (ev.kind === 'tool_call') petSignals.noteToolCall(chatId) }`(`init` 是每回合第一个事件,拿它当起飞;若某 provider 不发 `init`,在 `dispatch` 进入时也调一次 `noteTurnStart` —— 以 `recordTurn` 的 `startedAt` 为准更稳:直接在 coordinator 记录 `startedAt` 的那一行旁调 `deps.onTurnEvent?.(chatId, { kind: 'init', sessionId: '' })` **不要**;改为让 `onTurnEvent` 只管 tool_call,起飞由 `sessionManager.isInFlight` 判定、since 用 `snapshot().inFlightSinceMs ?? null` 即可 —— **决定:`noteTurnStart` 由 bootstrap 在 coordinator `dispatch` 之前的入站分发处调用**(`pipeline-deps.ts` `dispatch: async (msg) => { petSignals.noteTurnStart(msg.chatId); … }`)。converse 路由:`companionConverse` 包一层 `petSignals.noteContact()`;`permissions.resolve` 包一层:成功时 `petSignals.noteContact()`。

- [ ] **Step 1: 写失败测试**

`src/daemon/internal-api/routes-pet.test.ts`(照 `routes-presence.test.ts` 的夹具风格):

```ts
import { describe, it, expect } from 'vitest'
import { petRoutes } from './routes-pet'
import type { InternalApiDeps } from './types'

const payload = { owner_last_contact_at: '2026-09-05T10:00:00.000Z', turn: { phase: 'thinking' as const, since: '2026-09-05T10:00:01.000Z' }, last_done_at: null, pending_permissions: [] }

describe('GET /v1/companion/pet', () => {
  it('没接线 → 503 pet_not_wired;接了 → 原样返回推导结果', async () => {
    const off = petRoutes({} as InternalApiDeps)['GET /v1/companion/pet']!
    expect(await off({}, undefined)).toEqual({ status: 503, body: { error: 'pet_not_wired' } })
    const on = petRoutes({ petTurn: async () => payload } as unknown as InternalApiDeps)['GET /v1/companion/pet']!
    expect(await on({}, undefined)).toEqual({ status: 200, body: payload })
  })
  it('推导抛错 → 500,不掀翻', async () => {
    const r = petRoutes({ petTurn: async () => { throw new Error('boom') } } as unknown as InternalApiDeps)['GET /v1/companion/pet']!
    expect((await r({}, undefined)).status).toBe(500)
  })
})
```

`src/daemon/internal-api/routes-permissions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { permissionRoutes } from './routes-permissions'
import type { InternalApiDeps } from './types'

describe('/v1/permissions/*', () => {
  const items = [{ hash: 'abcde', chatId: 'owner', prompt: 'Bash: ls', since: 's', expires_at: 'e' }]
  it('pending:没接线 503;接了 → { items }', async () => {
    expect(await permissionRoutes({} as InternalApiDeps)['GET /v1/permissions/pending']!({}, undefined)).toEqual({ status: 503, body: { error: 'permissions_not_wired' } })
    const deps = { permissions: { list: () => items, resolve: vi.fn(() => true) } } as unknown as InternalApiDeps
    expect(await permissionRoutes(deps)['GET /v1/permissions/pending']!({}, undefined)).toEqual({ status: 200, body: { items } })
  })
  it('resolve:body 校验(hash 非空串、decision ∈ allow|deny)→ 400;成功 → { ok }', async () => {
    const resolve = vi.fn((h: string) => h === 'abcde')
    const deps = { permissions: { list: () => items, resolve } } as unknown as InternalApiDeps
    const route = permissionRoutes(deps)['POST /v1/permissions/resolve']!
    expect((await route({}, { hash: '', decision: 'allow' })).status).toBe(400)
    expect((await route({}, { hash: 'abcde', decision: 'maybe' })).status).toBe(400)
    expect(await route({}, { hash: 'abcde', decision: 'deny' })).toEqual({ status: 200, body: { ok: true } })
    expect(await route({}, { hash: 'zzzzz', decision: 'allow' })).toEqual({ status: 200, body: { ok: false } })
    expect(resolve).toHaveBeenCalledWith('abcde', 'deny')
  })
})
```

`route-tiers.test.ts`:追加三行断言 —— `minTierFor('GET /v1/companion/pet') === 'trusted'`,`'GET /v1/permissions/pending'` 与 `'POST /v1/permissions/resolve'` 为 `'admin'`(照文件里现有断言的写法)。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-pet.test.ts src/daemon/internal-api/routes-permissions.test.ts src/daemon/internal-api/route-tiers.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`routes-pet.ts`:

```ts
/**
 * routes-pet.ts — CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。
 * 推导在 core/pet-turn.ts,输入在 pipeline-deps 组装(主人会话在飞、最近 tool_call、
 * 回合结束、主人联系时间、待决权限)。trusted:桌面拿的是 FILE token。
 */
import type { InternalApiDeps, RouteTable } from './types'

export function petRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/pet': async () => {
      if (!deps.petTurn) return { status: 503, body: { error: 'pet_not_wired' } }
      try { return { status: 200, body: await deps.petTurn() } }
      catch (err) { return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } } }
    },
  }
}
```

`routes-permissions.ts`:

```ts
/**
 * routes-permissions.ts — 一个权限,两个呈现面(spec §6)。桌面在这里 resolve,
 * 微信回「y/n <hash>」在 ilink-glue —— 两边都是 PendingPermissions.consume()。admin 档。
 */
import type { InternalApiDeps, RouteTable } from './types'

export function permissionRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/permissions/pending': async () => {
      if (!deps.permissions) return { status: 503, body: { error: 'permissions_not_wired' } }
      return { status: 200, body: { items: deps.permissions.list() } }
    },
    'POST /v1/permissions/resolve': async (_q, body) => {
      if (!deps.permissions) return { status: 503, body: { error: 'permissions_not_wired' } }
      const b = (body ?? {}) as { hash?: unknown; decision?: unknown }
      if (typeof b.hash !== 'string' || b.hash === '' || (b.decision !== 'allow' && b.decision !== 'deny')) return { status: 400, body: { error: 'bad_request' } }
      return { status: 200, body: { ok: deps.permissions.resolve(b.hash, b.decision) } }
    },
  }
}
```

`routes.ts`:import 两个,和 `presenceRoutes(deps)` 一样展开进总表。`route-tiers.ts`:三条。`types.ts`:`petTurn?`、`permissions?`、`setPetTurn`。`index.ts`:`setPetTurn(fn) { deps.petTurn = fn }`。

`main.ts`:`const petSignals = makePetSignals()`;`registerInternalApi({ …, permissions: { list: () => ilink.listPendingPermissions(), resolve: (h, d) => { const ok = ilink.resolvePermission(h, d); if (ok) petSignals.noteContact(); return ok } } })`;把 `petSignals` 传给 bootstrap / wireMain(沿 `huntStore` 的传法);在 `internalApi.setCompanionConverse(...)` 旁 `internalApi.setPetTurn(wired.petTurn)`。

`bootstrap/index.ts`:`recordTurn` 末尾 `deps.petSignals?.noteTurnEnd(record.chatId, record.endedAt)`;coordinator deps 加 `onTurnEvent: (chatId, ev) => { if (ev.kind === 'tool_call') deps.petSignals?.noteToolCall(chatId) }`。

`pipeline-deps.ts`:`dispatch` 入口 `petSignals?.noteTurnStart(msg.chatId)`;`companionConverse` 内部先 `petSignals?.noteContact()`;导出 `petTurn`(上面的组装)到 `wired`。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `bun --bun vitest run src/daemon/internal-api/ src/daemon/bootstrap.test.ts src/daemon/wiring/ && bun run typecheck && bun run depcheck`,然后全量。`schema.test.ts` 的 `RESPONSE_SCHEMAS has 35 entries` 不变(这些路由内联校验,照 wish / intro 先例)。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/internal-api src/daemon/main.ts src/daemon/bootstrap/index.ts src/daemon/wiring/pipeline-deps.ts src/daemon/wiring/index.ts
git commit -m "GET /v1/companion/pet + /v1/permissions/*:桌宠拿到主人会话的 turn 阶段、联系时间与待决权限;resolve 与微信同一个 consume"
```

---

### Task 4: 桌面 `pet-poller.js` + `runtime-events.js`(纯)

**Files:**
- Create: `apps/desktop/src/pet/bridge/pet-poller.js` + `pet-poller.test.ts`
- Create: `apps/desktop/src/pet/bridge/runtime-events.js` + `runtime-events.test.ts`

**Interfaces:**
- Consumes: Phase A `PetIntent`(`presence-map.js`);Task 3 payload 形状。
- Produces:

```ts
// pet-poller.js(照 presence-poller.js 的形状)
/** @typedef {{ owner_last_contact_at: string|null, turn: { phase: 'idle'|'thinking'|'working'|'permission', since: string|null }, last_done_at: string|null, pending_permissions: Array<{ hash: string, prompt: string, since: string, expires_at: string }> }} PetTurn */
export function createPetPoller({ invokeApi, fastMs = 2_000, slowMs = 10_000 }): { subscribe(cb: (t: PetTurn | null) => void): () => void, start(): void, stop(): void, refresh(): Promise<PetTurn | null>, setFast(fast: boolean): void, current(): PetTurn | null }
// runtime-events.js(纯)
export const LIT_DIM_MS = 20 * 60_000
/** @typedef {{ form: 'unlit'|'lit', lastContactMs: number|null, lastDoneMs: number|null, initialized: boolean }} BridgeState */
export function initialBridgeState(): BridgeState
export function mergeIntent(args: { presence: PetIntent, turn: PetTurn | null, state: BridgeState, nowMs: number }): { intent: PetIntent, state: BridgeState, permission: PetTurn['pending_permissions'][number] | null, permissionCount: number }
```

`mergeIntent` 规则(边沿都靠 `state`):
1. `turn === null`(端点没接线 / 拉不到)→ 直接返回 `presence` 的 intent,state 不变,permission null。
2. `contactMs = Date.parse(turn.owner_last_contact_at)`(NaN → null)。**首次**(`!state.initialized`):`form = contactMs !== null && nowMs − contactMs <= LIT_DIM_MS ? 'lit' : 'unlit'`,不加一次性动作;`initialized = true`。之后:`contactMs > state.lastContactMs` → 若 `state.form === 'unlit'` → `form = 'lit'`(pet.js 会播转场);若已 lit → oneShots 加 `receive`,props 加 `micro-light`。退潮:`state.form === 'lit' && contactMs !== null && nowMs − contactMs > LIT_DIM_MS && turn.turn.phase === 'idle' && turn.pending_permissions.length === 0` → `form = 'unlit'`。
3. presence 说 `down` / `offline` 时 form 仍按 presence 的(unlit sleep),但 `state.form`(事实)照上面维护,恢复后按事实重画(spec §5.2)。
4. behavior:`turn.turn.phase !== 'idle'` → `permission → 'permission'`、`working → 'working'`、`thinking → 'thinking'`,压过 presence 的 `working / companion / idle`;但 presence 的 `sleep`(down / offline)压过 turn(没有 daemon 就没有 turn)。
5. `doneMs = Date.parse(turn.last_done_at)`;`state.lastDoneMs !== null && doneMs > state.lastDoneMs` → oneShots 加 `done`(首次只记不播)。
6. `permission = turn.pending_permissions[0] ?? null`(端点已按 since 升序),`permissionCount = length`。
7. 返回的新 state:`{ form, lastContactMs: contactMs, lastDoneMs: doneMs, initialized: true }`。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/bridge/runtime-events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { initialBridgeState, mergeIntent, LIT_DIM_MS } from './runtime-events.js'

const T0 = Date.parse('2026-09-05T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const presenceIdle = { form: 'unlit' as const, behavior: 'idle' as const, props: [], badge: 0, hint: null, oneShots: [] }
const turn = (over: Record<string, unknown> = {}) => ({ owner_last_contact_at: null, turn: { phase: 'idle' as const, since: null }, last_done_at: null, pending_permissions: [], ...over }) as any

describe('mergeIntent', () => {
  it('端点没接线 → 原样透传 presence', () => {
    const r = mergeIntent({ presence: presenceIdle, turn: null, state: initialBridgeState(), nowMs: T0 })
    expect(r.intent).toEqual(presenceIdle); expect(r.permission).toBeNull(); expect(r.state.initialized).toBe(false)
  })
  it('首次:按联系时间直接算 form,不播一次性;之后联系前进 → unlit 亮起 / lit 只 receive + micro-light', () => {
    const s0 = initialBridgeState()
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 60_000) }), state: s0, nowMs: T0 })
    expect(r1.intent.form).toBe('lit'); expect(r1.intent.oneShots).toEqual([]); expect(r1.state).toMatchObject({ form: 'lit', initialized: true })
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 + 1000) }), state: r1.state, nowMs: T0 + 2000 })
    expect(r2.intent.form).toBe('lit'); expect(r2.intent.oneShots).toEqual(['receive']); expect(r2.intent.props).toContain('micro-light')
    const old = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - 3 * LIT_DIM_MS) }), state: s0, nowMs: T0 })
    expect(old.intent.form).toBe('unlit')
    const lit = mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0) }), state: old.state, nowMs: T0 + 10 })
    expect(lit.intent.form).toBe('lit'); expect(lit.intent.oneShots).toEqual([])   // 亮起靠 setForm 的转场,不加 receive
  })
  it('退潮:lit 超过 LIT_DIM_MS 无联系且 turn idle 且无权限 → unlit;在飞或有权限则不退', () => {
    const s = { ...initialBridgeState(), form: 'lit' as const, lastContactMs: T0 - LIT_DIM_MS - 1, initialized: true }
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1) }), state: s, nowMs: T0 }).intent.form).toBe('unlit')
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1), turn: { phase: 'thinking', since: 's' } }), state: s, nowMs: T0 }).intent.form).toBe('lit')
    expect(mergeIntent({ presence: presenceIdle, turn: turn({ owner_last_contact_at: iso(T0 - LIT_DIM_MS - 1), pending_permissions: [{ hash: 'a', prompt: 'p', since: 's', expires_at: 'e' }] }), state: s, nowMs: T0 }).intent.form).toBe('lit')
  })
  it('turn 阶段压过 presence 的 working / companion;presence 的 sleep(offline / down)压过 turn', () => {
    const s = { ...initialBridgeState(), form: 'lit' as const, lastContactMs: T0, initialized: true }
    const working = { ...presenceIdle, behavior: 'working' as const, props: ['laptop'] }
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'thinking', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('thinking')
    expect(mergeIntent({ presence: working, turn: turn({ owner_last_contact_at: iso(T0), turn: { phase: 'permission', since: 's' }, pending_permissions: [{ hash: 'a', prompt: 'p', since: 's', expires_at: 'e' }] }), state: s, nowMs: T0 }).intent.behavior).toBe('permission')
    const sleeping = { ...presenceIdle, behavior: 'sleep' as const, hint: 'daemon 没起' }
    expect(mergeIntent({ presence: sleeping, turn: turn({ turn: { phase: 'working', since: 's' } }), state: s, nowMs: T0 }).intent.behavior).toBe('sleep')
  })
  it('done 只在 last_done_at 前进时播一次;首次只记不播;permission 取最早一条 + 计数', () => {
    const r1 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0) }), state: initialBridgeState(), nowMs: T0 })
    expect(r1.intent.oneShots).toEqual([])
    const r2 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: r1.state, nowMs: T0 + 6000 })
    expect(r2.intent.oneShots).toEqual(['done'])
    const r3 = mergeIntent({ presence: presenceIdle, turn: turn({ last_done_at: iso(T0 + 5000) }), state: r2.state, nowMs: T0 + 8000 })
    expect(r3.intent.oneShots).toEqual([])
    const p = [{ hash: 'a', prompt: 'p1', since: '1', expires_at: 'e' }, { hash: 'b', prompt: 'p2', since: '2', expires_at: 'e' }]
    const r4 = mergeIntent({ presence: presenceIdle, turn: turn({ turn: { phase: 'permission', since: '1' }, pending_permissions: p }), state: r3.state, nowMs: T0 })
    expect(r4.permission?.hash).toBe('a'); expect(r4.permissionCount).toBe(2)
  })
})
```

`apps/desktop/src/pet/bridge/pet-poller.test.ts`(照 `presence-poller.test.ts` 的写法,用 `vi.useFakeTimers()`):

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPetPoller } from './pet-poller.js'

describe('createPetPoller', () => {
  it('start 立即拉一次;slow 10 s;setFast(true) 改 2 s;拉失败发 null;stop 停', async () => {
    vi.useFakeTimers()
    try {
      const invokeApi = vi.fn(async () => ({ owner_last_contact_at: null, turn: { phase: 'idle', since: null }, last_done_at: null, pending_permissions: [] }))
      const p = createPetPoller({ invokeApi })
      const got: unknown[] = []
      p.subscribe(t => got.push(t))
      p.start(); await vi.advanceTimersByTimeAsync(0)
      expect(invokeApi).toHaveBeenCalledTimes(1); expect(invokeApi.mock.calls[0]![0]).toBe('GET'); expect(invokeApi.mock.calls[0]![1]).toBe('/v1/companion/pet')
      await vi.advanceTimersByTimeAsync(10_000); expect(invokeApi).toHaveBeenCalledTimes(2)
      p.setFast(true); await vi.advanceTimersByTimeAsync(2_000); expect(invokeApi).toHaveBeenCalledTimes(3)
      invokeApi.mockRejectedValueOnce(new Error('503'))
      await vi.advanceTimersByTimeAsync(2_000); expect(got.at(-1)).toBeNull()
      p.stop(); await vi.advanceTimersByTimeAsync(20_000); expect(invokeApi).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/bridge/`
Expected: FAIL(新文件缺)。

- [ ] **Step 3: 实现**

`pet-poller.js`:照 `presence-poller.js` 的结构(`current / subscribers / timer / inflight / notify / refresh / start / stop / subscribe`),差别:`GET /v1/companion/pet`、`timeoutMs: 4_000`、失败发 `null`(不是 DOWN 常量)、`setFast(fast)` 切换 `intervalMs` 并**重排**计时器(clear + setInterval),`current()`。

`runtime-events.js`:

```js
// @ts-check
// runtime-events.js — presence(处境)+ pet 端点(在做什么)→ 一个意图(spec §5.1–§5.3)。
// 纯函数;所有「变化」都靠传进来的 state 做边沿检测,不用任何计时器。
export const LIT_DIM_MS = 20 * 60_000

/** @typedef {import('./presence-map.js').PetIntent} PetIntent */
/** @typedef {import('./pet-poller.js').PetTurn} PetTurn */
/** @typedef {{ form: 'unlit' | 'lit', lastContactMs: number | null, lastDoneMs: number | null, initialized: boolean }} BridgeState */

/** @returns {BridgeState} */
export const initialBridgeState = () => ({ form: 'unlit', lastContactMs: null, lastDoneMs: null, initialized: false })

/** @param {string | null | undefined} iso */
const ms = (iso) => { if (!iso) return null; const v = Date.parse(iso); return Number.isFinite(v) ? v : null }

/**
 * @param {{ presence: PetIntent, turn: PetTurn | null, state: BridgeState, nowMs: number }} a
 * @returns {{ intent: PetIntent, state: BridgeState, permission: PetTurn['pending_permissions'][number] | null, permissionCount: number }}
 */
export function mergeIntent({ presence, turn, state, nowMs }) {
  if (!turn) return { intent: presence, state, permission: null, permissionCount: 0 }
  const contactMs = ms(turn.owner_last_contact_at)
  const doneMs = ms(turn.last_done_at)
  const pending = Array.isArray(turn.pending_permissions) ? turn.pending_permissions : []
  const phase = turn.turn?.phase ?? 'idle'
  /** @type {string[]} */ const props = [...presence.props]
  /** @type {PetIntent['oneShots']} */ const oneShots = [...presence.oneShots]

  /** @type {'unlit' | 'lit'} */
  let form = state.form
  if (!state.initialized) {
    form = contactMs !== null && nowMs - contactMs <= LIT_DIM_MS ? 'lit' : 'unlit'
  } else {
    if (contactMs !== null && (state.lastContactMs === null || contactMs > state.lastContactMs)) {
      if (state.form === 'unlit') form = 'lit'
      else { oneShots.push('receive'); if (!props.includes('micro-light')) props.push('micro-light') }
    }
    if (form === 'lit' && contactMs !== null && nowMs - contactMs > LIT_DIM_MS && phase === 'idle' && pending.length === 0) form = 'unlit'
    if (state.initialized && state.lastDoneMs !== null && doneMs !== null && doneMs > state.lastDoneMs) oneShots.push('done')
  }

  // presence 说睡(down / offline)→ 画面照 presence;事实 form 仍按上面维护
  const asleep = presence.behavior === 'sleep'
  /** @type {PetIntent['behavior']} */
  let behavior = presence.behavior
  if (!asleep && phase !== 'idle') behavior = phase
  const intent = { form: asleep ? presence.form : form, behavior, props, badge: presence.badge, hint: presence.hint, oneShots }
  return { intent, state: { form, lastContactMs: contactMs ?? state.lastContactMs, lastDoneMs: doneMs ?? state.lastDoneMs, initialized: true }, permission: pending[0] ?? null, permissionCount: pending.length }
}
```

(注意 `micro-light` 属于 PROPS,状态机会接受;`pet.js` 的 `applyIntent` 会在下一拍 presence 不带它时自动收回 —— 这就是「短暂显示」。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/pet/ && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pet/bridge/pet-poller.js apps/desktop/src/pet/bridge/pet-poller.test.ts apps/desktop/src/pet/bridge/runtime-events.js apps/desktop/src/pet/bridge/runtime-events.test.ts
git commit -m "桌宠事件桥:pet 端点 2 s / 10 s 轮询 + 纯合并 —— 联系前进才亮、20 分钟退潮、done 只播一次、turn 压过 presence"
```

---

### Task 5: 权限卡片 + 陪伴窗接线 + Tauri 命令 + 全量

**Files:**
- Create: `apps/desktop/src/pet/permission/permission-card.js` + `permission-card.test.ts`
- Modify: `apps/desktop/src/companion-window.html/.js/.css`
- Modify: `apps/desktop/src-tauri/src/lib.rs`(`pet_permission_resolve` 命令 + 注册)
- Modify: `docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md`(§5.3 轮询表加「窗口不可见 → 两个都停」已有;§6 补「浏览器预览无按钮」)
- Full: `bun run typecheck && bun run depcheck && bun --bun vitest run && (cd apps/desktop/src-tauri && cargo check)`

**Interfaces:**
- Consumes: Task 4 `createPetPoller`、`mergeIntent`、`initialBridgeState`;Phase A `createPet`、`presenceToPet`、`createPresencePoller`;`invoke`(ipc.js)。
- Produces:

```ts
export function createPermissionCard(root: { el: ElLike & { hidden: boolean }, makeEl: (tag: string) => any }, opts: { canResolve: boolean, onResolve: (hash: string, decision: 'allow' | 'deny') => Promise<boolean> }): {
  show(item: { hash: string, prompt: string, since: string, expires_at: string }, count: number): void
  hide(): void
  current(): string | null       // 当前显示的 hash
}
```

卡片 DOM:

```
<div class="pet-card" role="group" aria-label="需要你看一下">
  <p class="pet-card-title">这个要你看一下 <span class="pet-card-count" hidden>+2</span></p>
  <pre class="pet-card-prompt" hidden></pre>
  <div class="pet-card-actions">
    <button class="pet-card-allow">允许</button><button class="pet-card-deny">拒绝</button><button class="pet-card-view" aria-expanded="false">查看</button>
  </div>
  <p class="pet-card-note" hidden>微信里有一条等你确认</p>   ← canResolve=false 时只显示这一行,不出允许/拒绝
</div>
```

行为:`show()` 同一 hash 不重建(避免焦点丢失);`查看` 切换 `pre` 显示与 `aria-expanded`;`Esc` 收起展开;点允许 / 拒绝 → 按钮 disabled → `await onResolve` → 成功 `hide()`,失败恢复按钮并在 title 后加「没送出去,再试一次」;`hide()` 清空。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/pet/permission/permission-card.test.ts`(元素桩同 Phase A 的 `makeEl`,加 `hidden`、`disabled`、`addEventListener` 记录 handlers 并提供 `click()` / `keydown` 触发):

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPermissionCard } from './permission-card.js'

function makeEl(tag = 'div') {
  const kids: any[] = []; const classes = new Set<string>(); const handlers: Record<string, Array<(e: any) => void>> = {}
  const el: any = {
    tag, hidden: false, disabled: false, textContent: '', attrs: {} as Record<string, string>, children: kids, style: {},
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    setAttribute(k: string, v: string) { el.attrs[k] = v }, getAttribute(k: string) { return el.attrs[k] ?? null },
    appendChild(c: any) { kids.push(c); return c }, replaceChildren(...c: any[]) { kids.splice(0, kids.length, ...c) },
    addEventListener(t: string, fn: (e: any) => void) { (handlers[t] ??= []).push(fn) },
    fire(t: string, e: any = {}) { for (const fn of handlers[t] ?? []) fn({ preventDefault() {}, ...e }) },
    querySelector(sel: string) { return find(el, sel) },
    focus() { el.focused = true },
  }
  return el
}
function find(el: any, sel: string): any { const cls = sel.replace(/^\./, ''); if (el.classList?.contains(cls)) return el; for (const k of el.children ?? []) { const r = find(k, sel); if (r) return r } return null }
const item = { hash: 'abcde', prompt: 'Bash: rm -rf ./tmp', since: 's', expires_at: 'e' }

describe('createPermissionCard', () => {
  it('show 渲染标题、三个真实按钮、隐藏的 prompt;查看切换展开;count>1 显示 +n', () => {
    const root = makeEl(); const card = createPermissionCard({ el: root, makeEl }, { canResolve: true, onResolve: vi.fn(async () => true) })
    card.show(item, 3)
    expect(root.hidden).toBe(false); expect(card.current()).toBe('abcde')
    expect(root.querySelector('.pet-card-count').textContent).toBe('+2'); expect(root.querySelector('.pet-card-count').hidden).toBe(false)
    const pre = root.querySelector('.pet-card-prompt'); expect(pre.hidden).toBe(true); expect(pre.textContent).toBe('Bash: rm -rf ./tmp')
    root.querySelector('.pet-card-view').fire('click'); expect(pre.hidden).toBe(false); expect(root.querySelector('.pet-card-view').attrs['aria-expanded']).toBe('true')
    root.fire('keydown', { key: 'Escape' }); expect(pre.hidden).toBe(true)
  })
  it('允许 → onResolve(hash, allow) → 成功隐藏;失败恢复按钮并提示', async () => {
    const root = makeEl(); const onResolve = vi.fn(async () => true)
    const card = createPermissionCard({ el: root, makeEl }, { canResolve: true, onResolve })
    card.show(item, 1)
    const allow = root.querySelector('.pet-card-allow'); allow.fire('click'); expect(allow.disabled).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(onResolve).toHaveBeenCalledWith('abcde', 'allow'); expect(root.hidden).toBe(true); expect(card.current()).toBeNull()
    const root2 = makeEl(); const card2 = createPermissionCard({ el: root2, makeEl }, { canResolve: true, onResolve: vi.fn(async () => false) })
    card2.show(item, 1); root2.querySelector('.pet-card-deny').fire('click'); await Promise.resolve(); await Promise.resolve()
    expect(root2.hidden).toBe(false); expect(root2.querySelector('.pet-card-deny').disabled).toBe(false); expect(root2.querySelector('.pet-card-title').textContent).toContain('没送出去')
  })
  it('canResolve=false:只显示提示行,没有允许 / 拒绝按钮;同一 hash 重复 show 不重建', () => {
    const root = makeEl(); const card = createPermissionCard({ el: root, makeEl }, { canResolve: false, onResolve: vi.fn(async () => true) })
    card.show(item, 1)
    expect(root.querySelector('.pet-card-allow')).toBeNull(); expect(root.querySelector('.pet-card-note').hidden).toBe(false)
    const before = root.children[0]; card.show(item, 1); expect(root.children[0]).toBe(before)
    card.hide(); expect(root.hidden).toBe(true); expect(root.children).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/pet/permission/`
Expected: FAIL。

- [ ] **Step 3: 实现卡片**

`permission-card.js`:按上面的 DOM 与行为实现(`root.el.addEventListener('keydown', …)` 处理 Esc;按钮 `type="button"`;`allow` 按钮在 show 时 `focus()`;`current()`)。用 `makeEl` 创建所有节点;不用 innerHTML。

- [ ] **Step 4: 陪伴窗接线**

`companion-window.html`:在 `.pet-hint` 之后加 `<div class="pet-card-host" id="pet-card" hidden></div>`。`companion-window.css`:`.pet-card-host { margin-top: 6px; padding: 8px 10px; border-radius: 12px; background: rgba(255,253,247,.94); box-shadow: 0 6px 20px rgba(72,51,32,.14); font-size: 12px; }`、`.pet-card-title { margin: 0 0 6px; font-weight: 600; }`、`.pet-card-count { opacity: .6; margin-left: 4px; }`、`.pet-card-prompt { margin: 0 0 6px; max-height: 120px; overflow: auto; padding: 6px; border-radius: 6px; background: #f3efe7; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }`、`.pet-card-actions { display: flex; gap: 6px; }`、`.pet-card-actions button { flex: 1; padding: 5px 0; border: 0; border-radius: 8px; cursor: pointer; }`、`.pet-card-allow { background: #d9773b; color: #fff; }`、`.pet-card-deny { background: #e9e2d6; }`、`.pet-card-view { background: transparent; text-decoration: underline; }`、`.pet-card-actions button:focus-visible { outline: 2px solid #d9773b; outline-offset: 1px; }`、`.pet-card-note { margin: 0; color: #7b6b5c; }`。

`companion-window.js`:

```js
import { createPetPoller } from './pet/bridge/pet-poller.js'
import { initialBridgeState, mergeIntent } from './pet/bridge/runtime-events.js'
import { createPermissionCard } from './pet/permission/permission-card.js'
// …
const hasTauri = !!(/** @type {any} */ (window).__TAURI__?.core?.invoke)
const card = createPermissionCard({ el: $('pet-card'), makeEl: (t) => document.createElement(t) }, {
  canResolve: hasTauri,
  onResolve: async (hash, decision) => {
    try { const r = await invoke('pet_permission_resolve', { hash, decision }); return r === true || (r && r.ok === true) }
    catch (err) { console.warn('pet_permission_resolve failed', err); return false }
    finally { petPoller.refresh() }
  },
})
let bridge = initialBridgeState()
let lastPresenceIntent = presenceToPet(null, null)
const petPoller = createPetPoller({ invokeApi })
const apply = () => {
  const turn = petPoller.current()
  const r = mergeIntent({ presence: lastPresenceIntent, turn, state: bridge, nowMs: Date.now() })
  bridge = r.state
  pet.applyIntent(r.intent)
  if (r.permission) card.show(r.permission, r.permissionCount); else card.hide()
  petPoller.setFast(bridge.form === 'lit' || (turn?.turn.phase ?? 'idle') !== 'idle' || r.permissionCount > 0)
}
presencePoller.subscribe(p => { lastPresenceIntent = presenceToPet(p, prev); if (p.presence !== 'down') prev = p; apply() })
petPoller.subscribe(() => apply())
presencePoller.start(); petPoller.start()
// visibilitychange:两个 poller 一起 stop / start+refresh
```

(把 Phase A 里 `poller.subscribe(p => { pet.applyIntent(presenceToPet(p, prev)); … })` 换成上面这段;其余拖动 / 关闭 / 缩放不动。)

`lib.rs`:新增命令 `pet_permission_resolve(hash: String, decision: String) -> Result<bool, String>`,照 `agent_converse` 读 `internal-api-info.json` 的 `baseUrl` 与 `operatorTokenFilePath`,`POST {base_url}/v1/permissions/resolve` body `{"hash":…,"decision":…}`,超时 10 s,返回 body 的 `ok`;`decision` 非 `allow|deny` → `Err`。加进 `generate_handler![…]`。

spec §6 加一句:「浏览器预览(无 Tauri)时卡片只显示『微信里有一条等你确认』,不出按钮。」

- [ ] **Step 5: 全量 + 提交**

Run: `bun run typecheck && bun run depcheck && bun --bun vitest run && (cd apps/desktop/src-tauri && cargo check)`
Expected: 全绿。

```bash
git add apps/desktop/src/pet/permission apps/desktop/src/companion-window.html apps/desktop/src/companion-window.js apps/desktop/src/companion-window.css apps/desktop/src-tauri/src/lib.rs docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md
git commit -m "陪伴窗接上真实事件:亮起 / 退潮 / thinking / working / done 都来自 daemon;权限卡片 —— 允许 / 拒绝 / 查看,走 operator token 的 Tauri 命令"
```

---

## 完成后(两台真机)

- 微信给主人的伙伴发一句 → 2 秒内 CC 亮起(8 帧)→ thinking →(有工具时 working)→ 回复发出后 done 一次 → idle;20 分钟不理它 → 淡回 unlit。
- 触发一次需要权限的工具 → CC `permission` + 卡片;微信回「y <hash>」→ 卡片消失;反过来卡片点「拒绝」→ turn 按 deny 走,微信不再等。
- 断网(offline)→ unlit sleep,道具仍在;恢复 → 按 contact 时间重算,不多播转场。
- memory:`cc-pet-shipped`(两段合一)。
