# 全异步发现(discovery-over-mailbox + 同步回音退役)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** seek→echo 全面异步化:收方 fast-ack + 后台判官 + 独立回程消息 `/a2a/echo`(HTTP+envelope 双入口);intent 获得信箱传输(度一);2-hop 从同步聚合改为逐条异步中继。

**Architecture:** 收方 `makeForwarder`(同步聚合)退役,换 `makeAsyncResponder`(fast-ack,判官/转发全后台);新 `EchoMessage` 消息 + `onEcho` handler 一人分饰两角(自己的 seek → intake 落库;转发过的 intent → 铸 relay 行再转投 origin);求方 `broker.forage` 的 `send` 降为 fire-and-forget bool,回音全部经 intake 落库;`social_seen_intent` 加 `origin_agent_id`(v25)让 W 重启后仍能路由迟到回音。回程/信箱选路复用 `peerMailboxOf` + `mailboxSender`(postReveal 同款)。

**Tech Stack:** 现有 zod schema 层(a2a-intent.ts)、a2a-server 路由、mailbox-dispatch envelope 白名单、bun:sqlite store、注入式纯核心 + wire-social 接线。

**Spec:** `docs/superpowers/specs/2026-07-22-async-discovery-over-mailbox-design.md`

## Global Constraints

- **兼容性一刀切(用户拍板)**:不做 proto 兼容分支;`A2A_PROTO_VERSION` bump 到 2(诚实广告,mismatch 仍是 warn 不拒绝);fast-ack 响应保持 MatchReceipt 骨架(`{intent_id, match:'no', async:true}`)让老代码不崩。
- **回程地址永远查自己 registry**(bearer 验证过的 sender id → registry 记录),绝不用消息自带地址。
- **信箱只覆盖度一**:求方 `discover` 放开 url-less mailbox 对端;**2-hop `forwardTargets` 维持 url-only 过滤不变**。
- 隐私不变量不动:blurb 过 `sanitizeBlurb`;relay 身份腿(`social_relay` 行形状、echo 行 id 形状 `intent:peer` / `intent:relayVia:relayToken`)与现状逐字节一致——reveal 机制零改动、零感知。
- 全部后台任务 try/catch fail-closed;echo 回投失败=丢,不重投。
- 心愿状态机变化:forage 结束**不再 close**(只记 peers_asked,留在 foraging);首回音 intake 把 foraging→echoed;resume 只重撒 7 天内的 foraging 行,更老的 markStatus closed。
- 老 `social-forwarder.ts` 及其测试整体退役删除(唯一消费者是 wire-social)。
- **`bun run test` 不做类型检查** —— 每个动 .ts 接口的任务必须跑 `bunx tsc --noEmit`(penpal 类型第 4 处的教训);backend 单文件测试用 `bun test <file>`(bunx vitest 有 bun:sqlite 解析怪癖)。
- 每任务 TDD:先测试跑 FAIL,再实现跑 PASS,commit。

---

### Task 1: 消息类型 + proto bump

**Files:**
- Modify: `src/core/a2a-intent.ts`
- Test: `src/core/a2a-intent.test.ts`(新;该文件现无专属测试则新建)

**Interfaces:**
- Produces: `EchoMessageSchema` / `EchoMessage` = `{ agent_id: string, intent_id: string, echo: { blurb: string(≤280), degree: int≥1, relay_token?: string } }`;`MatchReceiptSchema` 增可选 `async: z.boolean().optional()`;`A2A_PROTO_VERSION = 2`。后续所有任务消费。

- [ ] **Step 1: 写失败测试** —— 新建 `src/core/a2a-intent.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EchoMessageSchema, MatchReceiptSchema, A2A_PROTO_VERSION } from './a2a-intent'

describe('EchoMessage (async discovery)', () => {
  it('直连回音与 relay 回音都能 parse;缺 blurb/degree 拒绝', () => {
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: '我认识一位', degree: 1 } }).success).toBe(true)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: 'x', degree: 2, relay_token: 't1' } }).success).toBe(true)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { degree: 1 } }).success).toBe(false)
    expect(EchoMessageSchema.safeParse({ agent_id: 'w', intent_id: 'i1', echo: { blurb: 'x', degree: 0 } }).success).toBe(false)
  })
  it('fast-ack 形状:MatchReceipt 允许 async:true;proto 已 bump 到 2', () => {
    expect(MatchReceiptSchema.safeParse({ intent_id: 'i1', match: 'no', async: true }).success).toBe(true)
    expect(A2A_PROTO_VERSION).toBe(2)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/a2a-intent.test.ts`,期望红(EchoMessageSchema 不存在)。

- [ ] **Step 3: 实现** —— `a2a-intent.ts`:

3a. `A2A_PROTO_VERSION` 改为 `2`,注释追加一行:`// v2 (2026-07-22): sync MatchReceipt echoes retired — echoes arrive via the async /a2a/echo message. Old (v1) seekers get an empty receipt and cannot receive echoes; fleet must upgrade (spec §5).`

3b. `MatchReceiptSchema` 增字段(`forwarded` 之后):

```ts
  // v2 fast-ack marker: receiver acked and will judge/echo asynchronously.
  async: z.boolean().optional(),
```

3c. 文件尾追加:

```ts
// v2 async echo — the return leg of a seek. Posted by the responder (or a
// relay) to the intent's SENDER; the receiver routes it by its OWN records
// (own seek → intake; forwarded intent → relay onward), never by anything
// inside the message. relay_token present ⇔ this echo crossed a relay leg.
export const EchoMessageSchema = z.object({
  agent_id: z.string().min(1),
  intent_id: z.string().min(1),
  echo: z.object({
    blurb: z.string().min(1).max(280),
    degree: z.number().int().min(1),
    relay_token: z.string().min(1).optional(),
  }),
})
export type EchoMessage = z.infer<typeof EchoMessageSchema>
```

- [ ] **Step 4: 跑 PASS**;`bunx tsc --noEmit` 干净。
- [ ] **Step 5: Commit** —— `git add src/core/a2a-intent.ts src/core/a2a-intent.test.ts && git commit -m "feat(social): v2 EchoMessage + MatchReceipt.async + proto bump 2 (全异步发现底座)"`

---

### Task 2: seen-intent origin 列(migration v25)

**Files:**
- Modify: `src/lib/db.ts`(migrations 数组尾追加 v25)
- Modify: `src/core/social-seen-intent-store.ts`
- Test: `src/core/social-seen-intent-store.test.ts`、`src/lib/db.test.ts`(如有版本号断言则 +1)

**Interfaces:**
- Produces: `markSeen({ intentId, expiresAt, originAgentId? })`(向后兼容:origin 可缺省 → null);`originOf(intentId): string | null`。Task 5/8 消费。

- [ ] **Step 1: 写失败测试** —— `social-seen-intent-store.test.ts` 追加:

```ts
  it('markSeen 记 origin;originOf 取回;无 origin 的行(老数据/缺省)→ null', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeenIntentStore(db)
    s.markSeen({ intentId: 'i1', expiresAt: new Date(Date.now() + 60000).toISOString(), originAgentId: 'cc-s' })
    s.markSeen({ intentId: 'i2', expiresAt: new Date(Date.now() + 60000).toISOString() })
    expect(s.originOf('i1')).toBe('cc-s')
    expect(s.originOf('i2')).toBeNull()
    expect(s.originOf('nope')).toBeNull()
    // 幂等重 mark 不覆盖 origin(INSERT OR IGNORE 语义)
    s.markSeen({ intentId: 'i1', expiresAt: new Date().toISOString(), originAgentId: 'other' })
    expect(s.originOf('i1')).toBe('cc-s')
  })
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/social-seen-intent-store.test.ts`。

- [ ] **Step 3: 实现**

3a. `db.ts` migrations 尾追加(照 v24 的注释风格):

```ts
  // v25 — async discovery (spec 2026-07-22-async-discovery-over-mailbox).
  // origin_agent_id on social_seen_intent: who SENT us this intent. A relay
  // (W) needs it to route a downstream echo onward after a restart — a
  // null-origin row (pre-v25) fails closed: the late echo is dropped.
  // Nullable-TEXT ADD COLUMN is safe on STRICT; social_seen_intent is
  // created unconditionally by v21.
  (db) => {
    db.exec(`ALTER TABLE social_seen_intent ADD COLUMN origin_agent_id TEXT;`)
  },
```

3b. store:接口改 `markSeen(s: { intentId: string; expiresAt: string; originAgentId?: string }): void` + `originOf(intentId: string): string | null`;实现:

```ts
  const ins = db.query<unknown, [string, string, string, string | null]>(
    `INSERT OR IGNORE INTO social_seen_intent(intent_id, first_seen_at, expires_at, origin_agent_id) VALUES (?, ?, ?, ?)`,
  )
  const selOrigin = db.query<{ origin_agent_id: string | null }, [string]>(
    'SELECT origin_agent_id FROM social_seen_intent WHERE intent_id = ?',
  )
```

```ts
    markSeen(s) {
      const now = new Date().toISOString()
      ins.run(s.intentId, now, s.expiresAt, s.originAgentId ?? null)
      prune.run(new Date(Date.now() - SEEN_RETENTION_MS).toISOString())
    },
    originOf(intentId) { return selOrigin.get(intentId)?.origin_agent_id ?? null },
```

- [ ] **Step 4: 跑 PASS** —— 本文件 + `bun test src/lib/db.test.ts src/lib/state-migration.test.ts`;`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): v25 social_seen_intent.origin_agent_id + originOf(异步中继回程底座)"`

---

### Task 3: 求方 intake 核心(recordEchoFromPeer)

**Files:**
- Create: `src/core/social-echo-intake.ts`
- Test: `src/core/social-echo-intake.test.ts`

**Interfaces:**
- Consumes: Task 1 `EchoMessage`;`EchoRecord`(social-broker.ts 现有导出)。
- Produces: `makeEchoIntake(deps): (senderAgentId: string, msg: EchoMessage) => 'recorded' | 'stale' | 'unknown'`;deps = `{ seekStatus(intentId): string | null; recordEcho(e: EchoRecord): void; markEchoed(intentId): void }`。Task 5 组合、Task 8 接线。

- [ ] **Step 1: 写失败测试** —— `social-echo-intake.test.ts`(纯注入,无 db):

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeEchoIntake } from './social-echo-intake'

const direct = { agent_id: 'ccb', intent_id: 'i1', echo: { blurb: '我认识一位  修相机的\n师傅'.repeat(1), degree: 1 } }
const relayed = { agent_id: 'w', intent_id: 'i1', echo: { blurb: '二度回音', degree: 2, relay_token: 'tok1' } }

function make(status: string | null = 'foraging') {
  const recordEcho = vi.fn(); const markEchoed = vi.fn()
  const intake = makeEchoIntake({ seekStatus: vi.fn(() => status), recordEcho, markEchoed })
  return { intake, recordEcho, markEchoed }
}

describe('makeEchoIntake', () => {
  it('直连回音:peerAgentId=sender、degree 透传、blurb 消毒(空白折叠)、foraging→markEchoed', () => {
    const { intake, recordEcho, markEchoed } = make('foraging')
    expect(intake('ccb', direct as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalledWith(expect.objectContaining({
      intentId: 'i1', peerAgentId: 'ccb', degree: 1, peerMasked: '第 1 度的某人',
    }))
    expect(recordEcho.mock.calls[0]![0].content).not.toContain('\n')
    expect(markEchoed).toHaveBeenCalledWith('i1')
  })

  it('relay 回音(带 relay_token):peerAgentId=null、relayVia=sender、relayToken 透传', () => {
    const { intake, recordEcho } = make('foraging')
    expect(intake('w', relayed as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalledWith(expect.objectContaining({
      peerAgentId: null, relayVia: 'w', relayToken: 'tok1', degree: 2, peerMasked: '第 2 度的某人',
    }))
  })

  it('echoed 状态仍收(后续回音),但不再 markEchoed', () => {
    const { intake, recordEcho, markEchoed } = make('echoed')
    expect(intake('ccb', direct as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalled()
    expect(markEchoed).not.toHaveBeenCalled()
  })

  it('迟到回音:closed/cancelled/proposed → stale 丢弃;未知 seek → unknown', () => {
    for (const st of ['closed', 'cancelled', 'proposed', 'connected']) {
      const { intake, recordEcho } = make(st)
      // connected 例外:仍属活跃关系,收 —— 见实现注释;其余丢
      if (st === 'connected') { expect(intake('ccb', direct as any)).toBe('recorded') }
      else { expect(intake('ccb', direct as any)).toBe('stale'); expect(recordEcho).not.toHaveBeenCalled() }
    }
    const { intake } = make(null)
    expect(intake('ccb', direct as any)).toBe('unknown')
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/social-echo-intake.test.ts`。

- [ ] **Step 3: 实现** —— `social-echo-intake.ts`:

```ts
/**
 * social-echo-intake.ts — the seeker side of the v2 async echo return
 * (spec §2). Maps a bearer-verified EchoMessage onto the EXISTING EchoRecord
 * shape (ids/masks/degrees byte-identical to the old sync-receipt path, so
 * the reveal machinery is none the wiser). Own-status gate: only an ACTIVE
 * seek accepts echoes (foraging/echoed/connected — connected because an
 * established match's seek can still collect more echoes, matching
 * applyFinishSeek's non-downgrade posture); proposed/cancelled/closed are
 * stale drops; an unknown intent is the caller's cue to try the relay leg.
 */
import type { EchoMessage } from './a2a-intent'
import type { EchoRecord } from './social-broker'

const ACTIVE = new Set(['foraging', 'echoed', 'connected'])

export interface EchoIntakeDeps {
  seekStatus(intentId: string): string | null
  recordEcho(e: EchoRecord): void
  /** Flip foraging → echoed on the first accepted echo. */
  markEchoed(intentId: string): void
}

/** Same defence-in-depth as social-broker.sanitizeBlurb (peer-controlled text). */
function sanitizeBlurb(blurb: string): string {
  return blurb.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function makeEchoIntake(deps: EchoIntakeDeps) {
  return (senderAgentId: string, msg: EchoMessage): 'recorded' | 'stale' | 'unknown' => {
    const status = deps.seekStatus(msg.intent_id)
    if (status == null) return 'unknown'
    if (!ACTIVE.has(status)) return 'stale'
    const relay = msg.echo.relay_token
    deps.recordEcho({
      intentId: msg.intent_id,
      peerAgentId: relay ? null : senderAgentId,
      ...(relay ? { relayVia: senderAgentId, relayToken: relay } : {}),
      peerMasked: `第 ${msg.echo.degree} 度的某人`,
      degree: msg.echo.degree,
      content: sanitizeBlurb(msg.echo.blurb),
      first: false,   // durable first-echo detection lives in the wire-social recordEcho closure (M2)
    })
    if (status === 'foraging') deps.markEchoed(msg.intent_id)
    return 'recorded'
  }
}
```

- [ ] **Step 4: 跑 PASS**;`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): makeEchoIntake — 异步回音求方落库核心(id/mask 形状与同步路径逐字节一致)"`

---

### Task 4: 收方翻转 makeAsyncResponder(替换 makeForwarder)

**Files:**
- Create: `src/core/social-async-responder.ts`
- Delete: `src/core/social-forwarder.ts`、`src/core/social-forwarder.test.ts`(唯一消费者 wire-social 在 Task 8 换轨;本任务先建新核心,删除动作放 Task 8 保持每步可编译)
- Test: `src/core/social-async-responder.test.ts`

**Interfaces:**
- Consumes: Task 1 `EchoMessage`;`IntentEvent`(a2a-server)、`MatchReceipt`。
- Produces: `makeAsyncResponder<T extends {id:string}>(deps): (event: IntentEvent) => Promise<MatchReceipt>`,deps:

```ts
{
  answerLocally(event: IntentEvent): Promise<MatchReceipt>
  /** 回投一条 echo 给 intent 的发送者(transport 选择注入,Task 8)。false=丢。 */
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number } }): Promise<boolean>
  forwardTargets(excludeAgentId: string): T[]
  /** hop+1 卡转投(fast-ack 语义,只关心送达)。 */
  forwardSend(target: T, card: IntentCard): Promise<boolean>
  markSeen(intentId: string, expiresAt: string, originAgentId: string): void
  hasSeen(intentId: string): boolean
  withinBudget?(senderId: string): boolean
  hopCap?: number
  /** 后台调度测试缝;缺省 fire-and-forget。 */
  schedule?(fn: () => Promise<void>): void
  log?(tag: string, line: string): void
}
```

- [ ] **Step 1: 写失败测试** —— `social-async-responder.test.ts`(移植旧 forwarder 测试的环路/预算语义 + 新 fast-ack 语义):

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeAsyncResponder } from './social-async-responder'
import type { IntentEvent } from './a2a-server'

const card = (over: Record<string, unknown> = {}) => ({ intent_id: 'i1', kind: 'seek' as const, topic: '找修相机师傅', hop: 1, expires_at: new Date(Date.now() + 600000).toISOString(), ...over })
const ev = (over: Record<string, unknown> = {}): IntentEvent => ({ agent: { id: 'cc-s' } as any, card: card(over) as any })

function make(over: Record<string, any> = {}) {
  const tasks: Array<() => Promise<void>> = []
  const deps = {
    answerLocally: vi.fn(async () => ({ intent_id: 'i1', match: 'yes' as const, blurb: '我认识一位' })),
    postEcho: vi.fn(async () => true),
    forwardTargets: vi.fn(() => [{ id: 'cc-q' }]),
    forwardSend: vi.fn(async () => true),
    markSeen: vi.fn(), hasSeen: vi.fn(() => false),
    schedule: (fn: () => Promise<void>) => { tasks.push(fn) },
    ...over,
  }
  const onIntent = makeAsyncResponder(deps)
  const drain = async () => { for (const t of tasks.splice(0)) await t() }
  return { onIntent, drain, deps }
}

describe('makeAsyncResponder', () => {
  it('fast-ack:判官慢也立刻返回 {match:no, async:true};markSeen 带 origin 在返回前完成', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { onIntent, deps } = make({ answerLocally: vi.fn(async () => { await gate; return { intent_id: 'i1', match: 'yes' as const, blurb: 'x' } }), schedule: undefined })
    const r = await onIntent(ev())                                   // schedule 缺省=fire-and-forget,判官挂着也要立刻回
    expect(r).toEqual({ intent_id: 'i1', match: 'no', async: true })
    expect(deps.markSeen).toHaveBeenCalledWith('i1', expect.any(String), 'cc-s')
    release()
  })

  it('后台:判官 yes → postEcho 给发送者,degree=card.hop;no → 不投', async () => {
    const { onIntent, drain, deps } = make()
    await onIntent(ev({ hop: 2 }))
    await drain()
    expect(deps.postEcho).toHaveBeenCalledWith('cc-s', { intent_id: 'i1', echo: { blurb: '我认识一位', degree: 2 } })
    const noMatch = make({ answerLocally: vi.fn(async () => ({ intent_id: 'i1', match: 'no' as const })) })
    await noMatch.onIntent(ev()); await noMatch.drain()
    expect(noMatch.deps.postEcho).not.toHaveBeenCalled()
  })

  it('转发:未见过且 hop<cap 且预算内 → hop+1 fan-out 排除发送者;seen/hop 顶格/超预算 → 不转', async () => {
    const { onIntent, drain, deps } = make()
    await onIntent(ev()); await drain()
    expect(deps.forwardTargets).toHaveBeenCalledWith('cc-s')
    expect(deps.forwardSend).toHaveBeenCalledWith({ id: 'cc-q' }, expect.objectContaining({ hop: 2 }))
    for (const bad of [{ hasSeen: vi.fn(() => true) }, {}, { withinBudget: vi.fn(() => false) }]) {
      const m = make(bad)
      await m.onIntent(ev('hasSeen' in bad || 'withinBudget' in bad ? {} : { hop: 2 })); await m.drain()
      expect(m.deps.forwardSend).not.toHaveBeenCalled()
    }
  })

  it('后台任何一步 throw 都不冒泡(fail-closed):postEcho 崩、forwardSend 崩、判官崩', async () => {
    for (const over of [
      { postEcho: vi.fn(async () => { throw new Error('net') }) },
      { forwardSend: vi.fn(async () => { throw new Error('net') }) },
      { answerLocally: vi.fn(async () => { throw new Error('judge') }) },
    ]) {
      const m = make(over)
      await m.onIntent(ev())
      await expect(m.drain()).resolves.not.toThrow()
    }
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/social-async-responder.test.ts`。

- [ ] **Step 3: 实现** —— `social-async-responder.ts`:

```ts
/**
 * social-async-responder.ts — the v2 receiver (spec §3/§4): fast-ack every
 * /a2a/intent, then judge + echo + forward in the background. Replaces
 * social-forwarder.ts's judge-inline + sync forwarded[] aggregation. Loop
 * prevention is unchanged (hop cap + never-forward-to-sender + seen-intent
 * dedup); markSeen now ALSO records the origin so the echo return leg
 * (social-echo-relay / onEcho) can route a downstream echo onward, even
 * after a restart. All background failures are fail-closed: no echo.
 */
import type { IntentEvent } from './a2a-server'
import type { IntentCard, MatchReceipt } from './a2a-intent'

export interface AsyncResponderDeps<T extends { id: string }> {
  answerLocally(event: IntentEvent): Promise<MatchReceipt>
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number } }): Promise<boolean>
  forwardTargets(excludeAgentId: string): T[]
  forwardSend(target: T, card: IntentCard): Promise<boolean>
  markSeen(intentId: string, expiresAt: string, originAgentId: string): void
  hasSeen(intentId: string): boolean
  withinBudget?(senderId: string): boolean
  hopCap?: number
  schedule?(fn: () => Promise<void>): void
  log?(tag: string, line: string): void
}

export function makeAsyncResponder<T extends { id: string }>(deps: AsyncResponderDeps<T>): (event: IntentEvent) => Promise<MatchReceipt> {
  const schedule = deps.schedule ?? ((fn: () => Promise<void>) => { void fn().catch(() => {}) })
  const log = deps.log ?? (() => {})
  return async (event) => {
    const card = event.card
    const senderId = event.agent.id
    const alreadySeen = deps.hasSeen(card.intent_id)
    if (!alreadySeen) {
      // Record BEFORE ack/forward so a diamond re-arrival dedups; origin is
      // what the echo return leg routes by. A persistence hiccup must not
      // abort the ack.
      try { deps.markSeen(card.intent_id, card.expires_at, senderId) } catch { /* logged by dep impl */ }
    }
    schedule(async () => {
      // ① own judge → async echo back to the SENDER (registry-verified id).
      try {
        const receipt = await deps.answerLocally(event)
        if (receipt.match === 'yes') {
          const ok = await deps.postEcho(senderId, { intent_id: card.intent_id, echo: { blurb: receipt.blurb ?? '', degree: card.hop } })
          if (!ok) log('SOCIAL_REC', `echo post dropped intent=${card.intent_id} to=${senderId}`)
        }
      } catch (err) { log('SOCIAL_REC', `answer/echo failed intent=${card.intent_id}: ${err instanceof Error ? err.message : String(err)}`) }
      // ② forward fan-out (unchanged gates; sends are fire-and-forget bools —
      // downstream echoes come back via /a2a/echo and the relay leg).
      const cap = deps.hopCap ?? 2
      const withinBudget = deps.withinBudget ?? (() => true)
      if (alreadySeen || card.hop >= cap || !withinBudget(senderId)) return
      for (const target of deps.forwardTargets(senderId)) {
        try { await deps.forwardSend(target, { ...card, hop: card.hop + 1 }) }
        catch { continue }   // one bad target never aborts the rest
      }
    })
    return { intent_id: card.intent_id, match: 'no', async: true }
  }
}
```

- [ ] **Step 4: 跑 PASS**;`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): makeAsyncResponder — fast-ack + 后台判官/回音/转发(同步聚合退役的收方核心)"`

---

### Task 5: 中继腿 makeEchoHandler(onEcho 一人分饰两角)

**Files:**
- Create: `src/core/social-echo-relay.ts`
- Test: `src/core/social-echo-relay.test.ts`

**Interfaces:**
- Consumes: Task 3 intake、Task 2 `originOf`。
- Produces: `makeEchoHandler(deps): (senderAgentId: string, msg: EchoMessage) => Promise<{ ok: boolean }>`,deps:

```ts
{
  intake(senderAgentId: string, msg: EchoMessage): 'recorded' | 'stale' | 'unknown'
  originOf(intentId: string): string | null
  /** 铸 social_relay 行(id/形状与旧同步路径一致),返回 relay_token。 */
  recordRelay(intentId: string, upstreamAgentId: string, downstreamAgentId: string): string
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number; relay_token: string } }): Promise<boolean>
  log?(tag: string, line: string): void
}
```

- [ ] **Step 1: 写失败测试**:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeEchoHandler } from './social-echo-relay'

const msg = (over: Record<string, unknown> = {}) => ({ agent_id: 'cc-q', intent_id: 'i1', echo: { blurb: '二度有回音', degree: 2 }, ...over }) as any

function make(over: Record<string, any> = {}) {
  const deps = {
    intake: vi.fn(() => 'unknown' as const),
    originOf: vi.fn(() => 'cc-s' as string | null),
    recordRelay: vi.fn(() => 'tok9'),
    postEcho: vi.fn(async () => true),
    ...over,
  }
  return { onEcho: makeEchoHandler(deps), deps }
}

describe('makeEchoHandler', () => {
  it('自己的 seek:intake recorded → 不走中继', async () => {
    const { onEcho, deps } = make({ intake: vi.fn(() => 'recorded' as const) })
    expect(await onEcho('ccb', msg())).toEqual({ ok: true })
    expect(deps.recordRelay).not.toHaveBeenCalled()
  })
  it('转发过的 intent:铸 relay(upstream=origin, downstream=sender)并转投 origin,degree 透传 + relay_token', async () => {
    const { onEcho, deps } = make()
    expect(await onEcho('cc-q', msg())).toEqual({ ok: true })
    expect(deps.recordRelay).toHaveBeenCalledWith('i1', 'cc-s', 'cc-q')
    expect(deps.postEcho).toHaveBeenCalledWith('cc-s', { intent_id: 'i1', echo: { blurb: '二度有回音', degree: 2, relay_token: 'tok9' } })
  })
  it('已带 relay_token 的回音不再二次中继(防三跳/环):intake unknown + 有 token → drop', async () => {
    const { onEcho, deps } = make()
    expect(await onEcho('cc-q', msg({ echo: { blurb: 'x', degree: 2, relay_token: 'up' } }))).toEqual({ ok: false })
    expect(deps.postEcho).not.toHaveBeenCalled()
  })
  it('origin 未知(null/老行)或 origin===sender(回流)→ drop', async () => {
    for (const originOf of [vi.fn(() => null), vi.fn(() => 'cc-q')]) {
      const { onEcho, deps } = make({ originOf })
      expect(await onEcho('cc-q', msg())).toEqual({ ok: false })
      expect(deps.postEcho).not.toHaveBeenCalled()
    }
  })
  it('stale intake(迟到)→ ok:true 静默吞(不给对端探测面)', async () => {
    const { onEcho } = make({ intake: vi.fn(() => 'stale' as const) })
    expect(await onEcho('ccb', msg())).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/social-echo-relay.test.ts`。

- [ ] **Step 3: 实现**:

```ts
/**
 * social-echo-relay.ts — the shared /a2a/echo handler (spec §2+§4). One
 * bearer-verified entry, two roles resolved from OUR OWN records only:
 * my own seek → seeker intake; an intent I forwarded (seen-intent origin)
 * → mint the relay leg NOW (the sync path minted it at forward-time; async
 * echoes arrive later, possibly after a restart) and pass the echo onward
 * to the origin. A relayed echo (already carrying relay_token) is NEVER
 * re-relayed — hop-2 is the ceiling and tokens are single-leg. stale is
 * swallowed ok:true so a peer can't probe which of my seeks are still open.
 */
import type { EchoMessage } from './a2a-intent'

export interface EchoHandlerDeps {
  intake(senderAgentId: string, msg: EchoMessage): 'recorded' | 'stale' | 'unknown'
  originOf(intentId: string): string | null
  recordRelay(intentId: string, upstreamAgentId: string, downstreamAgentId: string): string
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number; relay_token: string } }): Promise<boolean>
  log?(tag: string, line: string): void
}

export function makeEchoHandler(deps: EchoHandlerDeps) {
  const log = deps.log ?? (() => {})
  return async (senderAgentId: string, msg: EchoMessage): Promise<{ ok: boolean }> => {
    const took = deps.intake(senderAgentId, msg)
    if (took === 'recorded' || took === 'stale') return { ok: true }
    // Not my seek — relay leg? Only for a FIRST-leg echo (no token yet).
    if (msg.echo.relay_token) return { ok: false }
    const origin = deps.originOf(msg.intent_id)
    if (!origin || origin === senderAgentId) return { ok: false }
    try {
      const token = deps.recordRelay(msg.intent_id, origin, senderAgentId)
      const ok = await deps.postEcho(origin, { intent_id: msg.intent_id, echo: { blurb: msg.echo.blurb, degree: msg.echo.degree, relay_token: token } })
      if (!ok) log('SOCIAL_REC', `relay echo post dropped intent=${msg.intent_id} to=${origin}`)
      return { ok }
    } catch (err) {
      log('SOCIAL_REC', `relay echo failed intent=${msg.intent_id}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false }
    }
  }
}
```

- [ ] **Step 4: 跑 PASS**;`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): makeEchoHandler — /a2a/echo 双角色(自家 intake / 转发中继铸腿),token 单腿防环"`

---

### Task 6: 网络面 —— HTTP /a2a/echo 路由 + envelope 白名单(intent/echo)

**Files:**
- Modify: `src/core/a2a-server.ts`(`onEcho` opt + `/a2a/echo` 路由,克隆 `/a2a/intent` 的 auth 三连)
- Modify: `src/core/mailbox-dispatch.ts`(白名单 `/a2a/intent` + `/a2a/echo`,均 bearer 门)
- Test: `src/core/a2a-server.test.ts`(如存在;否则相应现有 server 测试文件)、`src/core/mailbox-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 1 `EchoMessageSchema`;Task 4/5 的 handler 类型。
- Produces: `A2AServerOpts.onEcho?: (event: { agent: A2AAgentRecord; msg: EchoMessage }) => Promise<{ ok: boolean }>`(undefined → 路由 501,同 onIntent 姿势);`makeEnvelopeDispatch` deps 增 `onIntent?: A2AServerOpts['onIntent']` 与 `onEcho?: A2AServerOpts['onEcho']`。

- [ ] **Step 1: 写失败测试**

6a. server 路由(在现有 a2a-server 测试文件的 intent 路由测试旁,复用其启动/注册 idiom——实现者按现有 `/a2a/intent` 测试的样板改写,覆盖):`POST /a2a/echo` 无 bearer→401、错 bearer→401、agent_id 不匹配→403、paused→202、坏 shape→400、合法→200 且 onEcho 收到 `{agent, msg}`、未接 onEcho→501。

6b. `mailbox-dispatch.test.ts` 追加(照现有 reveal envelope 测试 idiom):

```ts
  it('intent envelope:bearer 验证过 → onIntent({agent, card});坏卡 drop', async () => {
    // registry stub verifyBearer('cc-s', 'k') → agent;makeEnvelopeDispatch({..., onIntent})
    // dispatch({ path: '/a2a/intent', bearer: 'k', body: { agent_id: 'cc-s', card: <合法卡> } })
    // expect(onIntent).toHaveBeenCalledWith({ agent, card: expect.objectContaining({ intent_id: ... }) })
    // 坏卡(缺 topic)→ onIntent 不被调
  })
  it('echo envelope:bearer 验证过 → onEcho(senderId 来自 verified agent,不信 body.agent_id);坏 shape drop', async () => {
    // dispatch({ path: '/a2a/echo', bearer: 'k', body: <EchoMessage> })
    // expect(onEcho).toHaveBeenCalledWith({ agent, msg: expect.objectContaining({ intent_id: ... }) })
  })
```

(实现者按该文件现有测试的 stub 构造写全断言——本计划不重复其 registry/log stub 样板。)

- [ ] **Step 2: 跑 FAIL**。

- [ ] **Step 3: 实现**

3a. `a2a-server.ts`:opts 增

```ts
  /** v2 async echo return (spec §1). Undefined → /a2a/echo returns 501. */
  onEcho?: (event: { agent: A2AAgentRecord; msg: EchoMessage }) => Promise<{ ok: boolean }>
```

路由(`/a2a/intent` 块之后,克隆其 method/501/json/agent_id/bearer/mismatch/paused 骨架,把卡校验换成):

```ts
      const parsed = EchoMessageSchema.safeParse(body)
      if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid_echo' }), { status: 400 })
      try {
        const result = await opts.onEcho({ agent, msg: parsed.data })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'echo_failed', detail: msg2 }), { status: 500 })
      }
```

(注意:`/a2a/echo` 的 body 顶层就是 EchoMessage(含 agent_id),与 intent 的 `{agent_id, card}` 包裹不同——schema 自带 agent_id 字段,claimedId 取 `body.agent_id`。)

3b. `mailbox-dispatch.ts`:deps 增 `onIntent?` / `onEcho?`;dispatch 内(reveal 分支旁)增:

```ts
        if (inner.path === '/a2a/intent') {
          if (!deps.onIntent) return
          if (typeof body.agent_id !== 'string') return
          const agent = deps.registry.verifyBearer(body.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `intent drop: bearer rejected for agent_id=${body.agent_id}`); return }
          const parsed = IntentCardSchema.safeParse(body.card)
          if (!parsed.success) { deps.log('MAILBOX', 'intent drop: invalid card'); return }
          await deps.onIntent({ agent, card: parsed.data })   // fast-ack receipt 丢弃 — mailbox 单向
          return
        }
        if (inner.path === '/a2a/echo') {
          if (!deps.onEcho) return
          const parsed = EchoMessageSchema.safeParse(body)
          if (!parsed.success) { deps.log('MAILBOX', 'echo drop: invalid shape'); return }
          const agent = deps.registry.verifyBearer(parsed.data.agent_id, inner.bearer)
          if (!agent) { deps.log('MAILBOX', `echo drop: bearer rejected for agent_id=${parsed.data.agent_id}`); return }
          await deps.onEcho({ agent, msg: parsed.data })
          return
        }
```

(imports:`IntentCardSchema, EchoMessageSchema` from './a2a-intent'。文件头注释补一句:intent/echo envelopes 都是 bearer 门——度一=配对好友。)

- [ ] **Step 4: 跑 PASS** —— 两个测试文件 + `bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): /a2a/echo HTTP 路由 + intent/echo envelope 白名单(bearer 门,双入口喂同一 handler)"`

---

### Task 7: 求方翻转 —— broker.forage 异步化

**Files:**
- Modify: `src/core/social-broker.ts`
- Test: `src/core/social-broker.test.ts`(改写 forage 相关断言)

**Interfaces:**
- Consumes/Produces 变化:`BrokerDeps.send: (hand, card) => Promise<boolean>`(fast-ack 送达与否);**删除** `recordEcho`/`finishSeek` deps(回音落库全部移到 intake 路径);**新增** `markForaged(intentId: string, peersAsked: number): void`(记 peers_asked,状态留 foraging)。`EchoRecord` 类型**保留导出**(intake 消费)。`sanitizeBlurb` 保留(propose 路径不用它,但 intake 有自己的副本——broker 内部私用不导出,维持现状)。

- [ ] **Step 1: 写失败测试** —— 改写 `social-broker.test.ts` 中 forage 部分(实现者保留 propose/confirm/cancel 测试不动):

```ts
  it('forage v2:对每个候选 send(bool);结束只 markForaged(峰值计数),不落回音、状态不 close', async () => {
    const send = vi.fn(async () => true)
    const markForaged = vi.fn()
    const b = makeBroker({ ...baseDeps, discover: async () => [handA, handB], send, markForaged })
    await b.forage('i1', '已脱敏的心愿')
    expect(send).toHaveBeenCalledTimes(2)
    expect(markForaged).toHaveBeenCalledWith('i1', 2)
  })
  it('forage v2:单个 send 崩不中断其余;discover 崩 fail-closed 零发送', async () => { /* 移植现有两条的骨架,断言改 bool */ })
```

(`baseDeps` = 该文件现有的 deps 构造,去掉 recordEcho/finishSeek、加 markForaged 空 fn。)

- [ ] **Step 2: 跑 FAIL** —— `bun test src/core/social-broker.test.ts`(编译错即红)。

- [ ] **Step 3: 实现** —— `social-broker.ts`:

- `BrokerDeps`:`send: (hand: A2AAgentRecord, card: IntentCard) => Promise<boolean>`;删 `recordEcho`/`finishSeek` 两个 dep 声明;加 `markForaged(intentId: string, peersAsked: number): void`(JSDoc:v2 —— 回音异步经 /a2a/echo intake 落库;forage 结束心愿留在 foraging,首回音由 intake 翻 echoed,无自动 close)。
- `forage` 循环体换为:

```ts
    let asked = 0
    for (const hand of candidates) {
      try { if (await deps.send(hand, card)) asked++ }
      catch { continue }   // one bad/unreachable peer must not abort the rest
    }
    try { deps.markForaged(intentId, asked) }
    catch { /* persistence error must not undo the network actions already done */ }
```

- 顶部 forage JSDoc 的 idempotent 说明改指 intake(echo PK 幂等在 intake/echoStore 层)。`MatchReceipt` import 若 unused 则删。

- [ ] **Step 4: 跑 PASS** —— 本文件 + `bun test src/core/social-m1.e2e.test.ts`(如它依赖旧 send 形状,**允许在本任务内最小修正其 send/receipt 断言至 bool**——e2e 全链路重建放 Task 9);`bunx tsc --noEmit` **预期在 wire-social 报错**(接线在 Task 8 换轨)——本任务的 tsc 门放宽为"除 wire-social/bootstrap 外无新错",并在 commit message 注明。
- [ ] **Step 5: Commit** —— `git commit -m "feat(social): broker.forage v2 — send 降 bool fast-ack,markForaged 留 foraging(回音移交 intake;wire-social 换轨在下个提交)"`

---

### Task 8: wire-social 大接线(换轨 + 删旧核心)

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`
- Modify: `src/daemon/bootstrap/types.ts`(`onEcho` 透出)、`src/daemon/bootstrap/index.ts`(a2a-server opts 传 onEcho)、`src/daemon/bootstrap/wire-a2a-server.ts`(onEcho 条目,照 onIntent 样板)、`src/daemon/bootstrap/mailbox-dispatch-seam.ts`(如 envelope dispatch 在此组装则传 onIntent/onEcho)
- Delete: `src/core/social-forwarder.ts`、`src/core/social-forwarder.test.ts`
- Test: `src/daemon/bootstrap.test.ts`(社交接线断言更新)、`src/daemon/bootstrap/wire-social.mailbox.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7 全部。
- Produces: `SocialWiring`/`Bootstrap` 增 `onEcho: A2AServerOpts['onEcho']`;a2a-server 与 envelope dispatch 都拿到 onIntent(不变)+ onEcho。

**实现要点(实现者按此逐条落):**

1. **postToPeer 通用化**(postReveal 模式提为局部函数):

```ts
      // v2: transport-selected fire-and-forget POST to a registry peer —
      // mailbox coords when present, else push HTTP. Used by intent sends,
      // echo returns and relay echo returns alike (spec §1 selection rule).
      const postToPeer = async (agentId: string, path: '/a2a/intent' | '/a2a/echo', body: Record<string, unknown>): Promise<boolean> => {
        const hand = a2aRegistry.get(agentId)
        if (!hand) return false
        return postToHand(hand, path, body)
      }
      const postToHand = async (hand: A2AAgentRecord, path: '/a2a/intent' | '/a2a/echo', body: Record<string, unknown>): Promise<boolean> => {
        const peer = peerMailboxOf(hand)
        if (peer) {
          try { await mailboxSender.send({ path, bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } }, peer); return true }
          catch (err) { deps.log('SOCIAL_REC', `mailbox ${path} drop failed agent=${hand.id}: ${err instanceof Error ? err.message : String(err)}`); return false }
        }
        if (!hand.url) return false
        const url = path === '/a2a/intent' ? intentUrl(hand.url) : echoUrl(hand.url)
        const r = await a2aClient.send({ url, bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
        return r.ok
      }
```

`echoUrl` 加进 `src/core/a2a-delegate.ts`(照 intentUrl 一行样板)。

2. **broker deps 换轨**:`discover` **去掉** url-less mailbox 过滤(度一放开:`.filter(a => !a.paused).slice(0, 5)`,注释改"v2: mailbox peers now first-class for degree-1 intents");`send: (hand, card) => postToHand(hand, '/a2a/intent', { card })`;删 `recordEcho`/`finishSeek` 传参,加 `markForaged: (intentId, peersAsked) => { try { seekStore.setPeersAsked?.(intentId, peersAsked) ... } }` —— 用 seekStore 现有的 finish/peers_asked 写法:**查 `social-seek-store.ts` 现有方法**,若只有 `finish(intentId, status, peersAsked)` 则加 `setPeersAsked(intentId, n)`(UPDATE peers_asked only,不动 status)+ store 测试。原 `recordEcho` 闭包**保留**(intake 消费,含 M2 durable-first 逻辑与 notify)。

3. **intake + markEchoed + onEcho 组装**:

```ts
      const echoIntake = makeEchoIntake({
        seekStatus: (intentId) => { try { return seekStore.get(intentId)?.status ?? null } catch { return null } },
        recordEcho,             // ← 原闭包原样复用(id 形状/M2 first/notify)
        markEchoed: (intentId) => { try { applyFinishSeek({ seekStore, echoStore }, intentId) } catch (err) { deps.log('SOCIAL_REC', `markEchoed failed intent=${intentId}: ${err instanceof Error ? err.message : String(err)}`) } },
      })
      const socialOnEcho: A2AServerOpts['onEcho'] = async ({ agent, msg }) =>
        makeEchoHandler({
          intake: echoIntake,
          originOf: (intentId) => { try { return seenIntentStore.originOf(intentId) } catch { return null } },
          recordRelay: (intentId, upstream, downstream) => { const relayToken = randomUUID(); relayStore.create({ id: `${intentId}:${relayToken}`, intentId, relayToken, upstreamAgentId: upstream, downstreamAgentId: downstream }); return relayToken },
          postEcho: (to, m) => postToPeer(to, '/a2a/echo', m),
          log: deps.log,
        })(agent.id, msg)
```

(`applyFinishSeek` 的现签名带 peersAsked——**读 `social-finish-seek.ts` 现实现**,若签名不符则给 markEchoed 写直白版:seek.status==='foraging' → seekStore 置 echoed。以现文件为准,不臆测。)

4. **socialOnIntent 换轨**:`makeForwarder({...})` 整体换 `makeAsyncResponder({...})`:`answerLocally` 原闭包;`postEcho: (to, m) => postToPeer(to, '/a2a/echo', m)`;`forwardTargets` **原样**(保留 url-only 过滤 + 注释改指 spec §4"2-hop 传输仍 push");`forwardSend: async (hand, card) => { if (!hand.url) return false; const r = await a2aClient.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, card } }); return r.ok }`;`markSeen: (intentId, expiresAt, origin) => { try { seenIntentStore.markSeen({ intentId, expiresAt, originAgentId: origin }) } catch (err) { ...log... } }`;`hasSeen`/`withinBudget`/`hopCap` 原样;**删 recordRelay dep**(中继铸腿移到 onEcho)。

5. **resume 7 天线**:`socialResumeRow` 里 foraging 分支前加:

```ts
        if (Date.parse(row.created_at) < Date.now() - 7 * 24 * 3600_000) {
          seekStore.finish(row.id, 'closed', row.peers_asked ?? 0)   // 按 store 现签名
          return
        }
```

(v2 心愿无自动 close,靠 resume 扫尾 + 收官命令;注释注明。)

6. **envelope dispatch 接线**:找到 `makeEnvelopeDispatch` 组装点(`mailbox-dispatch-seam.ts` 或 wire-mailbox),传入 `onIntent: socialOnIntent` 与 `onEcho: socialOnEcho`。**注意 I1 纪律不变**:onLetter 仍是 own-channel-only handler;intent/echo 是 bearer 门,无此约束。

7. **透出**:wireSocial 返回对象 + `SocialWiring`/`Bootstrap`/`wire-a2a-server.ts` 增 `onEcho`(照 onIntent 三处样板);index.ts 组装传递。

8. **删除** `src/core/social-forwarder.ts` + 测试;grep 全仓 `makeForwarder` 无残留。

- [ ] **Step 1: 写失败测试** —— `bootstrap.test.ts` 现有社交接线断言按新形状更新 + 新增:onEcho 在 social 配置齐全时被透出且非 undefined;url-less mailbox peer 出现在 discover 候选里(可通过注入 registry 断言 send 被调);`wire-social.mailbox.test.ts` 里 reveal-crossing 断言不回归。先跑确认红。
- [ ] **Step 2: 实现上述 1-8**。
- [ ] **Step 3: 跑 PASS** —— `bun test src/daemon/bootstrap.test.ts src/daemon/bootstrap/wire-social.mailbox.test.ts src/daemon/bootstrap/reveal-crossing.mailbox.test.ts src/core/social-m1.e2e.test.ts`;**`bunx tsc --noEmit` 全仓干净**(Task 7 放宽在此清零)。
- [ ] **Step 4: Commit** —— `git commit -m "feat(social): wire-social 换轨 async responder/echo handler/postToPeer;discover 放开 mailbox 对端;resume 7天收官;删 social-forwarder"`

---

### Task 9: 端到端(三拓扑)

**Files:**
- Modify/Create: `src/core/social-m1.e2e.test.ts`(改写为全异步)或新建 `src/core/social-async.e2e.test.ts`(实现者以改动量小者为准,新建则旧文件删)
- Test: 即本体

**用例(全部注入式,无真网络;transport 缝 = 直接把 A 的 postX 接到 B 的 handler):**

1. **全 push 异步 e2e**:S forage → R 的 onIntent fast-ack(注入慢判官,断言 forage 返回不等判官)→ 判官完成 → R.postEcho→S.onEcho → S echo 行落库(id=`i:R`)、seek foraging→echoed、first-echo notify 恰一次。
2. **信箱往返 e2e**:S/R 都 mailbox-only(假中继:内存 drop 队列,照 `pairing.integration.test.ts` 的 fake relay idiom)——S 的 intent envelope 入 R 队列 → R poller dispatch(makeEnvelopeDispatch 真件)→ onIntent → 后台判官 yes → echo envelope 入 S 队列 → S dispatch → intake 落库。断言两条队列里只有密封 envelope(明文不出现)。
3. **2-hop 逐条中继**:S→W(W 判 no、转发 Q)→ Q 判 yes → Q.onEcho→W(W 非 seek 持有者,originOf='S')→ W 铸 relay 行(upstream=S, downstream=Q)+ token → S 收 relay 回音(peerAgentId=null, relayVia=W, relayToken=token, degree=2)。再断言:该 relay 行喂给现有 relay-reveal 机制(makeRelayReconciler 或 reveal-crossing 测试的最小复用)可解出两腿身份——**证明 reveal 零感知**。
4. **幂等与迟到**:同一 echo 消息投两次 → 一行、notify 一次;seek 收官后到达的 echo → stale 吞、零行;origin=null 老行的下游回音 → drop。

- [ ] **Step 1: 写测试跑 FAIL(对新语义)** → **Step 2: 修至 PASS**(允许在本任务内修 Task 3-8 的小缺陷,每修必带上其单测)→ **Step 3:** 全量 `bun run test` + `bunx tsc --noEmit` 双绿。
- [ ] **Step 4: Commit** —— `git commit -m "test(social): 全异步发现三拓扑 e2e(push/信箱/2-hop 中继)+ 幂等/迟到/reveal 零感知"`

---

### Task 10: 升级说明 + 收尾回归

**Files:**
- Modify: `docs/design/roadmap.md` 或新建 `docs/release-notes/async-discovery.md`(实现者查 docs 结构,放进 release 相关文档;没有现成位置则新建后者)
- Modify: `src/core/a2a-intent.ts`(确认 proto 注释含升级要求,Task 1 已写则免)

- [ ] **Step 1:** 写升级说明(中文,三点:①本版起社交发现需全网升级——老版本求方收不到任何回音;②信箱配对的朋友现在能互相收到心愿;③trusted 定级评审旗与本说明一起进下次 dev→master PR body)。
- [ ] **Step 2:** 全量 `bun run test` + `bunx tsc --noEmit`;`grep -rn "makeForwarder" src/` 零命中;`grep -rn "recordEcho\b" src/core/social-broker.ts` 零命中(EchoRecord 类型除外)。
- [ ] **Step 3: Commit** —— `git commit -m "docs(social): 全异步发现升级说明(需全网升级)+ 收尾回归"`

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:§1=T1+T6;§2=T3+T7+T8(discover 放开/intake/markForaged);§3=T4+T8;§4=T2+T5+T8(origin/铸腿时点后移/forwardTargets 保持 push);§5=T1(proto 注释)+T10;§6 测试=各任务 + T9 三拓扑。resume 7 天线(§2 状态机推论)=T8.5。无缺口。
- **占位符**:T6 的 server 路由测试与 T8 的部分接线以"照现有样板+读现文件为准"表述——这是对既有 idiom 的引用而非 TBD;其余全部含完整代码。
- **一致性**:`EchoMessage` 形状 T1/T3/T5/T6 一致(顶层 agent_id;handler 只用 verified sender id);echo 行 id/`social_relay` 行形状与现状逐字节一致(T3/T8 注释+T9 断言);`markSeen(intentId, expiresAt, originAgentId?)` T2 定义、T4/T8 三参调用兼容;Task 7 的 tsc 放宽在 Task 8 收口(Global Constraints 注明)。
