# 桌宠状态(Companion Presence)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面鱼缸里的熊反映伙伴的真实状态 —— 在不在(presence)、在干什么(activity)、带了什么回来(news)—— 全部从 daemon 正在做的事推导,桌面只做状态到画面的薄映射。

**Architecture:** daemon 侧一个纯函数 `derivePresence(inputs)` 把现有信号(busy-registry label、串门进行中登记、活跃会话、外发健康、子系统、journal 未看计数)折成三轴,由新路由 `GET /v1/companion/presence` 吐出。桌面侧 `presence-poller` 每 20 秒拉一次,`sceneStateFrom(presence)` 变成 `SceneState`,喂给 `animation-lab.js` 新增的 `window.__companionScene.setState()`。「没看过」用独立水位 `journal-seen.json`,不借 journal.status。点道具 → 主窗口切到觅食台 → 推水位 → 道具消失。

**Tech Stack:** TypeScript + Bun + Vitest(`bun --bun vitest run <file>`),internal-api 路由表 + zod schema + route-tiers,桌面纯 JS(`// @ts-check`)+ Tauri v2(Rust 命令)。

**Spec:** `docs/superpowers/specs/2026-09-03-companion-presence-design.md`

## Global Constraints

- **永不撒谎(spec §0):** 每个状态值必须有真实来源;装饰动作不配故事文案;`down` / `offline` 的牌子写「离线」,不写「出门了」。
- **busy label 过滤(spec §2.1):** `api:` 前缀(每个非 GET 请求)和 `companion-` 前缀(调度器每拍持的 `companion-push/introspect/ingest`)**不是伙伴的活动**,推导时忽略;其余未知 label 归 `working`。
- **activity 优先级(spec §2.1):** `chatting > hosting_human > visiting > hosting_peer > foraging > working > idle`。
- **`ACTIVE_WINDOW_MS = 3 * 60_000`**,**`VISIT_STALE_MS = 6 * 60 * 60_000`**,桌面轮询 **`20_000` ms**。
- **路由 tier = `trusted`**(与 `/v1/journal` 同级;绝不能是 admin)。
- **浮窗不显示聊天内容**,bubble 只用 `activity.label`。
- **不动的东西(spec §4):** 不加数值养成;不做夜晚状态;不用 websocket;不重排 `animation-lab.js`(只加 `setState` 入口和几个绘制函数);现有 hover 挥手 / 螃蟹 / 鱼群逻辑不动。
- **测试:** 每个纯函数一组单测;desktop-e2e 一直是红的,不依赖它。提交前跑相关测试文件 + `bun run typecheck`。
- **提交信息中文**,风格照 `git log`(一句话说清楚为什么)。

---

### Task 1: busy-registry 暴露 `labels()`

**Files:**
- Modify: `src/core/busy-registry.ts`
- Test: `src/core/busy-registry.test.ts`

**Interfaces:**
- Produces: `BusyRegistry.labels(): string[]` — 当前所有持有者的 label 快照(有重复就有重复,不去重)。

- [ ] **Step 1: 写失败测试**

在 `src/core/busy-registry.test.ts` 的 `describe('makeBusyRegistry')` 末尾追加:

```ts
  it('labels():返回当前持有者的 label 快照;release 后消失;快照不受后续变化影响', () => {
    const r = makeBusyRegistry()
    expect(r.labels()).toEqual([])
    const a = r.hold('hunt'); const b = r.hold('api:POST /v1/x')
    const snap = r.labels()
    expect(snap.sort()).toEqual(['api:POST /v1/x', 'hunt'])
    a()
    expect(r.labels()).toEqual(['api:POST /v1/x'])
    expect(snap.sort()).toEqual(['api:POST /v1/x', 'hunt'])  // 快照独立
    b()
    expect(r.labels()).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/busy-registry.test.ts`
Expected: FAIL — `r.labels is not a function`

- [ ] **Step 3: 实现**

`src/core/busy-registry.ts`:

```ts
export interface BusyRegistry {
  /** 拿一个 token;返回 release。release 幂等,多次调用无害。 */
  hold(label: string): () => void
  busy(): boolean
  /** 当前持有者的 label 快照(spec 2026-09-03-companion-presence §2.2)。 */
  labels(): string[]
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
    labels() {
      return Array.from(holders.values())
    },
  }
}
```

同时把文件头注释里「label 只存不读 —— 将来做诊断接口时再暴露」改成「label 由 `labels()` 暴露给桌宠状态推导(spec 2026-09-03-companion-presence)」。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/busy-registry.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/core/busy-registry.ts src/core/busy-registry.test.ts
git commit -m "busy-registry:暴露 labels() —— 桌宠状态要知道伙伴在忙什么,不只是忙不忙"
```

---

### Task 2: 打猎轮次持 `hunt` busy token

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts:493-518`(hunt 分支)
- Test: `src/daemon/wiring/tick-bodies.test.ts`(`daily hunt branch` describe)

**Interfaces:**
- Consumes: `deps.boot.holdBusy(label): () => void`(Bootstrap 上已有,类型必填;测试的 fake boot 没有它,所以用可选调用)。
- Produces: 打猎轮次期间 busy-registry 里有一个 label 为 `'hunt'` 的 token。

- [ ] **Step 1: 写失败测试**

在 `src/daemon/wiring/tick-bodies.test.ts` 的 `describe('buildTickBodies / pushTick — daily hunt branch (Task 3)')` 里、测试 (a) 之后追加:

```ts
  it('打猎轮次持 busy token(label=hunt),发完释放 —— 桌宠靠它显示「觅食中」', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const held: string[] = []
    let released = 0
    let heldDuringDispatch = false
    s.deps.boot = { ...s.deps.boot, holdBusy: (label: string) => { held.push(label); return () => { released++ } } } as never
    s.dispatch.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { heldDuringDispatch = held.includes('hunt') && released === 0 },
    }))
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(held).toEqual(['hunt'])
    expect(heldDuringDispatch).toBe(true)
    expect(released).toBe(1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts -t "打猎轮次持 busy token"`
Expected: FAIL — `expected [] to deeply equal ['hunt']`

- [ ] **Step 3: 实现**

`src/daemon/wiring/tick-bodies.ts` hunt 分支,把 `const tap = ...` 到 `return` 之间改成:

```ts
      if (huntDecision.ok) {
        // 旁听这一拍发出去的东西 —— 打猎的产出此前只存在于微信聊天记录里,
        // 主人想回头找上周那条链接只能翻聊天。记的是**真发出去的文本**,
        // 不是要求模型额外调一个登记工具(漏调一次就少一条,且无人知晓)。
        const tap = deps.outboundTaps?.tap(chatId)
        // busy token(spec 2026-09-03-companion-presence §2.2):调度器持的是
        // companion-push(每拍都有,桌宠推导会忽略);打猎要有自己的名字,
        // 桌宠才知道这一拍是「出门觅食」而不是例行公事。silent-safe:
        // 测试夹具的 boot 没有 holdBusy。
        let releaseHunt: (() => void) | undefined
        try { releaseHunt = (deps.boot as { holdBusy?: (l: string) => () => void }).holdBusy?.('hunt') } catch { releaseHunt = undefined }
        try {
          await dispatchToChat(chatId, {
            claim: () => { deps.careLedger.claimHunt(chatId, nowIso) },
            buildText: () => buildHuntText({ nowIso }),
          })
        } finally {
          try { releaseHunt?.() } catch { /* release 永不抛 */ }
          const shared = tap?.close() ?? []
          if (shared.length > 0 && deps.huntStore) {
            // 记录失败绝不能让这一拍看起来失败 —— 消息已经发出去了。
            try {
              const n = deps.huntStore.recordHunt({ chatId, text: shared.join('\n\n'), nowIso })
              deps.log('HUNT', `chat=${chatId} 入库 ${n} 条`)
            } catch (err) { deps.log('HUNT', `入库失败(消息已发出): ${errMsg(err)}`) }
          }
        }
        return
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts`
Expected: PASS(整个文件,包括新测试)

- [ ] **Step 5: 提交**

```bash
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "打猎轮次持 hunt busy token —— 2026-08-11 busy 登记处的漏网,桌宠「觅食中」的来源"
```

---

### Task 3: `derivePresence` 纯函数

**Files:**
- Create: `src/core/companion-presence.ts`
- Test: `src/core/companion-presence.test.ts`

**Interfaces:**
- Produces:

```ts
export type ActivityKind = 'idle' | 'chatting' | 'hosting_human' | 'visiting' | 'hosting_peer' | 'foraging' | 'working'
export type PresenceLevel = 'ok' | 'degraded' | 'offline'
export interface ActiveVisit { id: string; peerLabel: string; hosting: boolean; sinceMs: number }
export interface PresenceInputs {
  nowMs: number
  ownerChatId: string | null
  sessions: ReadonlyArray<{ chatId: string; lastUsedAt: number }>
  busyLabels: ReadonlyArray<string>
  visit: ActiveVisit | null
  outbound: 'unknown' | 'ok' | 'degraded' | null
  subsystemsDegraded: number
  journal: { unread: number; latest: { kind: string; title: string; ts: string } | null }
}
export interface Presence {
  presence: PresenceLevel
  activity: { kind: ActivityKind; label: string; since: string | null }
  news: { unread: number; latest_kind: string | null; latest_title: string | null }
}
export const ACTIVE_WINDOW_MS: number
export function derivePresence(i: PresenceInputs): Presence
```

- [ ] **Step 1: 写失败测试**

`src/core/companion-presence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { derivePresence, ACTIVE_WINDOW_MS, type PresenceInputs } from './companion-presence'

const NOW = Date.parse('2026-09-03T10:00:00.000Z')
const base = (over: Partial<PresenceInputs> = {}): PresenceInputs => ({
  nowMs: NOW,
  ownerChatId: 'owner',
  sessions: [],
  busyLabels: [],
  visit: null,
  outbound: 'ok',
  subsystemsDegraded: 0,
  journal: { unread: 0, latest: null },
  ...over,
})

describe('derivePresence — presence 轴', () => {
  it('一切正常 → ok', () => { expect(derivePresence(base()).presence).toBe('ok') })
  it('外发 degraded → offline(唯一诚实的「微信断了」信号)', () => {
    expect(derivePresence(base({ outbound: 'degraded' })).presence).toBe('offline')
  })
  it('子系统有降级 → degraded;外发 degraded 压过它', () => {
    expect(derivePresence(base({ subsystemsDegraded: 1 })).presence).toBe('degraded')
    expect(derivePresence(base({ subsystemsDegraded: 1, outbound: 'degraded' })).presence).toBe('offline')
  })
  it('outbound unknown / null 不算断 → ok', () => {
    expect(derivePresence(base({ outbound: 'unknown' })).presence).toBe('ok')
    expect(derivePresence(base({ outbound: null })).presence).toBe('ok')
  })
})

describe('derivePresence — activity 轴:每种一条', () => {
  it('什么都没有 → idle,label 空', () => {
    const a = derivePresence(base()).activity
    expect(a).toEqual({ kind: 'idle', label: '', since: null })
  })
  it('主人会话在窗口内 → chatting,since = lastUsedAt', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - 1000 }] })).activity
    expect(a.kind).toBe('chatting')
    expect(a.label).toBe('在跟你聊')
    expect(a.since).toBe(new Date(NOW - 1000).toISOString())
  })
  it('非主人会话在窗口内 → hosting_human', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'friend', lastUsedAt: NOW - 1000 }] })).activity
    expect(a.kind).toBe('hosting_human')
    expect(a.label).toBe('家里有客人')
  })
  it('我去串门 → visiting,label 带对方', () => {
    const a = derivePresence(base({ visit: { id: 'v1', peerLabel: '邻居「阿柚」', hosting: false, sinceMs: NOW - 5000 } })).activity
    expect(a.kind).toBe('visiting')
    expect(a.label).toBe('去邻居「阿柚」家串门了')
    expect(a.since).toBe(new Date(NOW - 5000).toISOString())
  })
  it('别人来串门 → hosting_peer', () => {
    const a = derivePresence(base({ visit: { id: 'v1', peerLabel: '第 1 度的朋友', hosting: true, sinceMs: NOW } })).activity
    expect(a.kind).toBe('hosting_peer')
    expect(a.label).toBe('第 1 度的朋友来串门了')
  })
  it('busy 里有 hunt 或 social-forage → foraging', () => {
    expect(derivePresence(base({ busyLabels: ['hunt'] })).activity).toMatchObject({ kind: 'foraging', label: '觅食中', since: null })
    expect(derivePresence(base({ busyLabels: ['social-forage'] })).activity.kind).toBe('foraging')
  })
  it('其它已知 / 未知 label → working', () => {
    expect(derivePresence(base({ busyLabels: ['a2a-delegate'] })).activity).toMatchObject({ kind: 'working', label: '在忙一件事' })
    expect(derivePresence(base({ busyLabels: ['something-new'] })).activity.kind).toBe('working')
  })
})

describe('derivePresence — 过滤与窗口', () => {
  it('api:* 和 companion-* 不是伙伴的活动 → idle', () => {
    const a = derivePresence(base({ busyLabels: ['api:POST /v1/journal/seen', 'companion-push', 'companion-introspect'] })).activity
    expect(a.kind).toBe('idle')
  })
  it('会话超过 ACTIVE_WINDOW_MS → 不算在聊', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - ACTIVE_WINDOW_MS - 1 }] })).activity
    expect(a.kind).toBe('idle')
  })
  it('刚好在窗口边界内 → 算', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW - ACTIVE_WINDOW_MS }] })).activity
    expect(a.kind).toBe('chatting')
  })
  it('没有 ownerChatId 时所有活跃会话都算客人', () => {
    const a = derivePresence(base({ ownerChatId: null, sessions: [{ chatId: 'x', lastUsedAt: NOW }] })).activity
    expect(a.kind).toBe('hosting_human')
  })
})

describe('derivePresence — 优先级', () => {
  const visiting = { id: 'v', peerLabel: 'P', hosting: false, sinceMs: NOW }
  it('chatting 压 visiting:串门途中回你消息,画面回到玻璃前', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'owner', lastUsedAt: NOW }], visit: visiting })).activity
    expect(a.kind).toBe('chatting')
  })
  it('hosting_human 压 visiting', () => {
    const a = derivePresence(base({ sessions: [{ chatId: 'f', lastUsedAt: NOW }], visit: visiting })).activity
    expect(a.kind).toBe('hosting_human')
  })
  it('visiting 压 foraging', () => {
    expect(derivePresence(base({ visit: visiting, busyLabels: ['hunt'] })).activity.kind).toBe('visiting')
  })
  it('foraging 压 working', () => {
    expect(derivePresence(base({ busyLabels: ['a2a-delegate', 'hunt'] })).activity.kind).toBe('foraging')
  })
})

describe('derivePresence — news 轴', () => {
  it('原样透传,latest 拆成 kind / title', () => {
    const n = derivePresence(base({ journal: { unread: 3, latest: { kind: 'visit', title: '去阿柚家串门', ts: '2026-09-03T09:00:00.000Z' } } })).news
    expect(n).toEqual({ unread: 3, latest_kind: 'visit', latest_title: '去阿柚家串门' })
  })
  it('空表 → 0 / null / null', () => {
    expect(derivePresence(base()).news).toEqual({ unread: 0, latest_kind: null, latest_title: null })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/companion-presence.test.ts`
Expected: FAIL — cannot find module `./companion-presence`

- [ ] **Step 3: 实现**

`src/core/companion-presence.ts`:

```ts
/**
 * companion-presence.ts — 桌宠状态的推导(spec 2026-09-03-companion-presence)。
 *
 * 红线:桌宠说的每一件事都能在日志里对上。所以这里没有任何「演」的状态,
 * 每个值都从 daemon 正在做的事推出来;输入全是现成信号(busy-registry label、
 * 串门登记、活跃会话、外发健康、子系统、journal 未看计数)。纯函数,daemon 只喂输入。
 *
 * 三轴互不干扰:在不在(presence)/ 在干什么(activity)/ 带了什么回来(news)。
 * activity 命中多个时按优先级取一个 —— 「正在跟你说话」永远比「出门了」更真。
 */

export type ActivityKind = 'idle' | 'chatting' | 'hosting_human' | 'visiting' | 'hosting_peer' | 'foraging' | 'working'
export type PresenceLevel = 'ok' | 'degraded' | 'offline'

export interface ActiveVisit { id: string; peerLabel: string; hosting: boolean; sinceMs: number }

export interface PresenceInputs {
  nowMs: number
  ownerChatId: string | null
  sessions: ReadonlyArray<{ chatId: string; lastUsedAt: number }>
  busyLabels: ReadonlyArray<string>
  visit: ActiveVisit | null
  outbound: 'unknown' | 'ok' | 'degraded' | null
  subsystemsDegraded: number
  journal: { unread: number; latest: { kind: string; title: string; ts: string } | null }
}

export interface Presence {
  presence: PresenceLevel
  activity: { kind: ActivityKind; label: string; since: string | null }
  news: { unread: number; latest_kind: string | null; latest_title: string | null }
}

/** 会话多久之内算「正在聊」。 */
export const ACTIVE_WINDOW_MS = 3 * 60_000

/** 这些 label 是「出门找东西」:打猎、派心愿。 */
const FORAGING_LABELS = new Set(['hunt', 'social-forage'])

/**
 * 不是伙伴活动的 label:`api:*` 是 internal-api 给每个非 GET 请求持的 token
 * (桌面自己的 POST 不能让熊「在忙」);`companion-*` 是三个调度器每拍都持的
 * (push/introspect/ingest),例行公事,打猎有自己的 `hunt` 名字。
 */
function isHousekeeping(label: string): boolean {
  return label.startsWith('api:') || label.startsWith('companion-')
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function derivePresence(i: PresenceInputs): Presence {
  // ── presence ──
  const presence: PresenceLevel =
    i.outbound === 'degraded' ? 'offline'
    : i.subsystemsDegraded > 0 ? 'degraded'
    : 'ok'

  // ── activity(按优先级,第一个命中的赢)──
  const active = i.sessions.filter(s => i.nowMs - s.lastUsedAt <= ACTIVE_WINDOW_MS)
  const owner = i.ownerChatId ? active.find(s => s.chatId === i.ownerChatId) : undefined
  const guest = active.find(s => s.chatId !== i.ownerChatId)
  const work = i.busyLabels.filter(l => !isHousekeeping(l))
  const foraging = work.some(l => FORAGING_LABELS.has(l))

  let activity: Presence['activity']
  if (owner) activity = { kind: 'chatting', label: '在跟你聊', since: iso(owner.lastUsedAt) }
  else if (guest) activity = { kind: 'hosting_human', label: '家里有客人', since: iso(guest.lastUsedAt) }
  else if (i.visit && !i.visit.hosting) activity = { kind: 'visiting', label: `去${i.visit.peerLabel}家串门了`, since: iso(i.visit.sinceMs) }
  else if (i.visit && i.visit.hosting) activity = { kind: 'hosting_peer', label: `${i.visit.peerLabel}来串门了`, since: iso(i.visit.sinceMs) }
  else if (foraging) activity = { kind: 'foraging', label: '觅食中', since: null }
  else if (work.length > 0) activity = { kind: 'working', label: '在忙一件事', since: null }
  else activity = { kind: 'idle', label: '', since: null }

  // ── news(透传;计数在存储层)──
  const news = {
    unread: i.journal.unread,
    latest_kind: i.journal.latest?.kind ?? null,
    latest_title: i.journal.latest?.title ?? null,
  }

  return { presence, activity, news }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/companion-presence.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: 提交**

```bash
git add src/core/companion-presence.ts src/core/companion-presence.test.ts
git commit -m "桌宠状态推导 derivePresence:三轴纯函数,每个值都有真实来源"
```

---

### Task 4: 「没看过」水位 + `Journal.summary` + `POST /v1/journal/seen`

**Files:**
- Create: `src/core/journal-seen.ts`
- Modify: `src/core/journal-store.ts`(`Journal` 接口 + `makeJournal`)
- Modify: `src/daemon/internal-api/routes-journal.ts`
- Modify: `src/daemon/internal-api/route-tiers.ts:139`(journal 段)
- Test: `src/core/journal-store.test.ts`(追加 describe),`src/daemon/internal-api/routes-journal.test.ts`(追加 describe)

**Interfaces:**
- Produces:
  - `readJournalSeen(stateDir: string): string | null` — ISO 或 null(从没看过)
  - `writeJournalSeen(stateDir: string, iso: string): void` — 写 `<stateDir>/companion/journal-seen.json` = `{ "seenUntil": iso }`
  - `Journal.summary(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }`
  - 路由 `POST /v1/journal/seen` → `{ ok: true, seen_until: string }`;需要 `deps.stateDir`(已有)。

- [ ] **Step 1: 写失败测试(store)**

`src/core/journal-store.test.ts` 已存在(顶部 `beforeEach` 建 `db` / `store`,已 import `openDb` 和 `makeJournal`)。下面的测试自己建库,不依赖那个 `store`。在文件末尾追加:

```ts
describe('Journal.summary —— 桌宠的包袱:水位之后有几条、最新一条是什么', () => {
  it('空表 → 0 / null', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.summary(null)).toEqual({ unread: 0, latest: null })
  })
  it('没看过 → 全算;水位之后只算新的;latest 永远是最新那条', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    j.recordHunt({ chatId: 'o', text: '看这个 https://a.com/1', nowIso: '2026-09-01T00:00:00.000Z' })
    j.recordVisit({ chatId: 'o', text: '去阿柚家坐了会儿', peerLabel: '去邻居「阿柚」家串门', nowIso: '2026-09-02T00:00:00.000Z' })
    expect(j.summary(null)).toEqual({ unread: 2, latest: { kind: 'visit', title: '去邻居「阿柚」家串门', ts: '2026-09-02T00:00:00.000Z' } })
    expect(j.summary('2026-09-01T12:00:00.000Z').unread).toBe(1)
    expect(j.summary('2026-09-02T00:00:00.000Z').unread).toBe(0)   // ts > 水位才算,等于不算
    expect(j.summary('2026-09-02T00:00:00.000Z').latest?.kind).toBe('visit')
  })
})

describe('journal-seen 水位文件', () => {
  it('没文件 → null;写了再读回来;文件坏了 → null 不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jseen-'))
    expect(readJournalSeen(dir)).toBe(null)
    writeJournalSeen(dir, '2026-09-03T10:00:00.000Z')
    expect(readJournalSeen(dir)).toBe('2026-09-03T10:00:00.000Z')
    writeFileSync(join(dir, 'companion', 'journal-seen.json'), '{not json')
    expect(readJournalSeen(dir)).toBe(null)
  })
})
```

需要新加的 import(`openDb` / `makeJournal` 文件里已有):

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJournalSeen, writeJournalSeen } from './journal-seen'
```

- [ ] **Step 2: 写失败测试(route)**

`src/daemon/internal-api/routes-journal.test.ts` 末尾追加:

```ts
describe('POST /v1/journal/seen —— 主人打开觅食台,水位推到现在', () => {
  it('写水位文件并返回 seen_until;之后 summary 归零', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'jroute-'))
    const db = openDb({ path: ':memory:' })
    const hunt = makeJournal(db)
    hunt.recordHunt({ chatId: 'owner', text: '看这个 https://a.com/x' })
    const r = await journalRoutes({ hunt, stateDir } as unknown as InternalApiDeps)['POST /v1/journal/seen']!(qs(), undefined)
    expect(r.status).toBe(200)
    const body = r.body as { ok: boolean; seen_until: string }
    expect(body.ok).toBe(true)
    expect(readJournalSeen(stateDir)).toBe(body.seen_until)
    expect(hunt.summary(body.seen_until).unread).toBe(0)
  })
  it('tier 是 trusted(桌面 FILE token 能打;admin 会让桌面 403)', () => {
    expect(minTierFor('POST /v1/journal/seen')).toBe('trusted')
  })
})
```

import 追加:`import { mkdtempSync } from 'node:fs'`、`import { tmpdir } from 'node:os'`、`import { join } from 'node:path'`、`import { readJournalSeen } from '../../core/journal-seen'`(`minTierFor`、`openDb`、`makeJournal` 已有)。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun --bun vitest run src/core/journal-store.test.ts src/daemon/internal-api/routes-journal.test.ts`
Expected: FAIL — cannot find module `./journal-seen` / `j.summary is not a function`

- [ ] **Step 4: 实现 `journal-seen.ts`**

```ts
/**
 * journal-seen.ts — 「主人看到哪了」的水位(spec 2026-09-03-companion-presence §2.3)。
 *
 * 不借 journal.status:那列的 `new` 在桌面是「没试过」(这条战利品用上了没),
 * 和「没看过」是两个概念。水位 = 主人上次打开觅食台的时刻;之后新增的条目
 * 就是桌宠脚边包袱里的东西。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const file = (stateDir: string) => join(stateDir, 'companion', 'journal-seen.json')

export function readJournalSeen(stateDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(file(stateDir), 'utf8')) as { seenUntil?: unknown }
    return typeof raw.seenUntil === 'string' && !Number.isNaN(Date.parse(raw.seenUntil)) ? raw.seenUntil : null
  } catch { return null }
}

export function writeJournalSeen(stateDir: string, iso: string): void {
  const dir = join(stateDir, 'companion')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file(stateDir), JSON.stringify({ seenUntil: iso }, null, 2))
}
```

- [ ] **Step 5: 实现 `Journal.summary`**

`src/core/journal-store.ts`,接口加:

```ts
  /**
   * 桌宠的包袱(spec 2026-09-03-companion-presence §2.3):水位之后有几条、
   * 最新一条是什么。seenUntil = null ⇒ 从没看过,全算。
   */
  summary(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
```

`makeJournal` 里加两条 query(和其它 query 放一起):

```ts
  const cntAll = db.query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM journal')
  const cntAfter = db.query<{ cnt: number }, [string]>('SELECT COUNT(*) AS cnt FROM journal WHERE ts > ?')
  const selLatest = db.query<{ kind: string; title: string; ts: string }, []>(
    'SELECT kind, title, ts FROM journal ORDER BY ts DESC, rowid DESC LIMIT 1',
  )
```

返回对象里加:

```ts
    summary(seenUntil) {
      const unread = seenUntil === null ? (cntAll.get()?.cnt ?? 0) : (cntAfter.get(seenUntil)?.cnt ?? 0)
      return { unread, latest: selLatest.get() ?? null }
    },
```

- [ ] **Step 6: 实现路由 + tier**

`src/daemon/internal-api/routes-journal.ts`,import 加 `import { writeJournalSeen } from '../../core/journal-seen'`,路由表里追加:

```ts
    // 主人看到哪了(spec 2026-09-03-companion-presence §2.3):觅食台每次打开
    // 推一次;桌宠脚边的包袱在下一次轮询消失。不动 journal.status —— 那是「没试过」。
    'POST /v1/journal/seen': async () => {
      if (!deps.hunt) return { status: 503, body: { error: 'journal_not_wired' } }
      const seenUntil = new Date().toISOString()
      writeJournalSeen(deps.stateDir, seenUntil)
      return { status: 200, body: { ok: true, seen_until: seenUntil } }
    },
```

`src/daemon/internal-api/route-tiers.ts` 在 `'POST /v1/journal/status': 'trusted',` 后加 `'POST /v1/journal/seen': 'trusted',`。

- [ ] **Step 7: 跑测试确认通过**

Run: `bun --bun vitest run src/core/journal-store.test.ts src/daemon/internal-api/routes-journal.test.ts src/daemon/internal-api/route-tiers.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/core/journal-seen.ts src/core/journal-store.ts src/core/journal-store.test.ts src/daemon/internal-api/routes-journal.ts src/daemon/internal-api/routes-journal.test.ts src/daemon/internal-api/route-tiers.ts
git commit -m "journal 加「主人看到哪了」水位 + summary —— 桌宠包袱的来源;不借 status 的 new(那是「没试过」)"
```

---

### Task 5: `GET /v1/companion/presence` 路由 + deps 接线

**Files:**
- Create: `src/daemon/internal-api/routes-presence.ts`
- Test: `src/daemon/internal-api/routes-presence.test.ts`
- Modify: `src/daemon/internal-api/types.ts`(`InternalApiDeps`:加 `busyLabels?`;`social.penpal` 加 `activeVisit?`)
- Modify: `src/daemon/internal-api/routes.ts:23-38, 905-911`(import + spread)
- Modify: `src/daemon/internal-api/route-tiers.ts:28`(companion 段)
- Modify: `src/daemon/internal-api/schema.ts:226-232`(加 `PresenceResponse`)+ `RESPONSE_SCHEMAS`
- Modify: `src/daemon/bootstrap/types.ts:447`(`Bootstrap` 加 `busyLabels`)
- Modify: `src/daemon/bootstrap/index.ts:1271`(`busyLabels: busyRegistry.labels`)
- Modify: `src/daemon/main.ts:296`(internal-api deps 加 `busyLabels`)

**Interfaces:**
- Consumes: `derivePresence`(Task 3)、`Journal.summary` + `readJournalSeen`(Task 4)、`deps.listSessions / outbound / subsystems / stateDir / hunt`(已有)。
- Produces:
  - `InternalApiDeps.busyLabels?: () => string[]`
  - `InternalApiDeps.social.penpal.activeVisit?(): ActiveVisit | null`(Task 6 才真的接上;这里先声明并可选读取)
  - `Bootstrap.busyLabels: () => string[]`
  - 路由 `GET /v1/companion/presence` → `Presence`(tier trusted)

- [ ] **Step 1: 写失败测试**

`src/daemon/internal-api/routes-presence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeJournal } from '../../core/journal-store'
import { writeJournalSeen } from '../../core/journal-seen'
import { presenceRoutes } from './routes-presence'
import { minTierFor } from './route-tiers'
import { PresenceResponse } from './schema'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()
const NOW = Date.now()

function deps(over: Partial<InternalApiDeps> = {}): InternalApiDeps {
  const stateDir = mkdtempSync(join(tmpdir(), 'presence-'))
  const hunt = makeJournal(openDb({ path: ':memory:' }))
  return {
    stateDir, hunt,
    listSessions: () => [],
    busyLabels: () => [],
    subsystems: () => [],
    outbound: () => ({ state: 'ok', consecutiveFailures: 0, lastOkAt: null, lastError: null }),
    ...over,
  } as unknown as InternalApiDeps
}

describe('GET /v1/companion/presence', () => {
  it('形状对 zod;一切安静 → ok / idle / 0', async () => {
    const r = await presenceRoutes(deps())['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.status).toBe(200)
    expect(PresenceResponse.safeParse(r.body).success).toBe(true)
    expect(r.body).toMatchObject({ presence: 'ok', activity: { kind: 'idle' }, news: { unread: 0 } })
  })

  it('把每个 deps 信号都喂进推导:busy hunt → foraging;journal 一条没看 → unread 1', async () => {
    const d = deps({ busyLabels: () => ['hunt'] })
    d.hunt!.recordHunt({ chatId: 'o', text: '看这个 https://a.com/x' })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.body).toMatchObject({ activity: { kind: 'foraging' }, news: { unread: 1, latest_kind: 'hunt' } })
  })

  it('水位之后 unread 归零', async () => {
    const d = deps()
    d.hunt!.recordHunt({ chatId: 'o', text: '看这个 https://a.com/x', nowIso: '2026-09-01T00:00:00.000Z' })
    writeJournalSeen(d.stateDir, '2026-09-02T00:00:00.000Z')
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { news: { unread: number } }).news.unread).toBe(0)
  })

  it('串门登记 → visiting;外发 degraded → offline;子系统 degraded → degraded', async () => {
    const d = deps({
      social: { penpal: { activeVisit: () => ({ id: 'v', peerLabel: '邻居「阿柚」', hosting: false, sinceMs: NOW }) } } as never,
      outbound: () => ({ state: 'degraded', consecutiveFailures: 3, lastOkAt: null, lastError: 'x' }) as never,
    })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.body).toMatchObject({ presence: 'offline', activity: { kind: 'visiting' } })
    const d2 = deps({ subsystems: () => [{ name: 'x', state: 'degraded', sinceIso: 'now' }] as never })
    expect((await presenceRoutes(d2)['GET /v1/companion/presence']!(qs(), undefined)).body).toMatchObject({ presence: 'degraded' })
  })

  it('主人会话活跃 → chatting(ownerChatId 从 companion 配置读;没配置时活跃会话算客人)', async () => {
    const d = deps({ listSessions: () => [{ alias: 'a', path: '/p', providerId: 'claude', chatId: 'someone', lastUsedAt: NOW }] })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { activity: { kind: string } }).activity.kind).toBe('hosting_human')
  })

  it('没接 journal → 503(和 /v1/journal 同姿势:空不是 0)', async () => {
    const r = await presenceRoutes(deps({ hunt: undefined }))['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.status).toBe(503)
  })

  it('tier 是 trusted', () => {
    expect(minTierFor('GET /v1/companion/presence')).toBe('trusted')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-presence.test.ts`
Expected: FAIL — cannot find module `./routes-presence`

- [ ] **Step 3: 类型声明**

`src/daemon/internal-api/types.ts`:

在 `holdBusy` 字段旁边(第 433 行附近的注释块之后)加:

```ts
  /**
   * busy-registry 的 label 快照(spec 2026-09-03-companion-presence §2.2)——
   * 桌宠状态推导用。thunk-over-bootRef,同 holdBusy;bootstrap 之前返回 []。
   */
  busyLabels?: () => string[]
```

`social.penpal` 里 `startVisit?` 后加:

```ts
      /** 进行中的串门(spec 2026-09-03-companion-presence §2.2)。可选:老 fixture 没有。 */
      activeVisit?(): import('../../core/companion-presence').ActiveVisit | null
```

`src/daemon/bootstrap/types.ts` 在 `holdBusy: (label: string) => () => void` 后加:

```ts
  /** busy-registry label 快照(spec 2026-09-03-companion-presence)。 */
  busyLabels: () => string[]
```

`src/daemon/bootstrap/index.ts` 第 1271 行 `holdBusy: busyRegistry.hold,` 后加 `busyLabels: busyRegistry.labels,`。

`src/daemon/main.ts` 第 296 行 `holdBusy: (l) => ...` 后加:

```ts
      busyLabels: () => bootRef?.busyLabels?.() ?? [],
```

- [ ] **Step 4: schema + tier**

`src/daemon/internal-api/schema.ts`,`CompanionStatusResponse` 后加:

```ts
// ── GET /v1/companion/presence(spec 2026-09-03-companion-presence)───────────
export const PresenceResponse = z.object({
  presence: z.enum(['ok', 'degraded', 'offline']),
  activity: z.object({
    kind: z.enum(['idle', 'chatting', 'hosting_human', 'visiting', 'hosting_peer', 'foraging', 'working']),
    label: z.string(),
    since: z.string().nullable(),
  }),
  news: z.object({
    unread: z.number().int().nonnegative(),
    latest_kind: z.string().nullable(),
    latest_title: z.string().nullable(),
  }),
})
```

`RESPONSE_SCHEMAS` 里 `'GET /v1/companion/status': CompanionStatusResponse,` 后加 `'GET /v1/companion/presence': PresenceResponse,`。

`route-tiers.ts` 在 `'POST /v1/companion/import-local': 'trusted',` 后加 `'GET /v1/companion/presence': 'trusted',`。

- [ ] **Step 5: 实现路由**

`src/daemon/internal-api/routes-presence.ts`:

```ts
/**
 * routes-presence.ts — 桌宠状态(spec 2026-09-03-companion-presence §2.4)。
 *
 * 一个 GET 把三轴一起吐出来:在不在 / 在干什么 / 带了什么回来。推导在
 * core/companion-presence.ts(纯函数),这里只负责从 deps 收集输入。
 * 微信侧以后主人问「你在干嘛」也走同一个函数 —— 两个界面一个事实。
 *
 * 分级 trusted:桌面拿的是 FILE token(= trusted)。admin 会让桌面 403 ——
 * 觅食台 2026-07-22 就是这么静默坏了一个月。
 */
import { derivePresence } from '../../core/companion-presence'
import { readJournalSeen } from '../../core/journal-seen'
import { loadCompanionConfig } from '../companion/config'
import type { InternalApiDeps, RouteTable } from './types'

export function presenceRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/presence': async () => {
      if (!deps.hunt) return { status: 503, body: { error: 'journal_not_wired' } }
      let ownerChatId: string | null = null
      try { ownerChatId = loadCompanionConfig(deps.stateDir).default_chat_id } catch { ownerChatId = null }
      const body = derivePresence({
        nowMs: Date.now(),
        ownerChatId,
        sessions: (deps.listSessions?.() ?? []).map(s => ({ chatId: s.chatId, lastUsedAt: s.lastUsedAt })),
        busyLabels: deps.busyLabels?.() ?? [],
        visit: deps.social?.penpal?.activeVisit?.() ?? null,
        outbound: deps.outbound?.().state ?? null,
        subsystemsDegraded: (deps.subsystems?.() ?? []).filter(s => s.state === 'degraded').length,
        journal: deps.hunt.summary(readJournalSeen(deps.stateDir)),
      })
      return { status: 200, body }
    },
  }
}
```

`src/daemon/internal-api/routes.ts`:import 段加 `import { presenceRoutes } from './routes-presence'`;spread 段 `...journalRoutes(deps),` 后加 `...presenceRoutes(deps),`。

- [ ] **Step 6: 跑测试 + typecheck**

Run: `bun --bun vitest run src/daemon/internal-api/routes-presence.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api/routes-journal.test.ts && bun run typecheck`
Expected: PASS;typecheck 无错(`Bootstrap.busyLabels` 是必填,凡是手工构造 `Bootstrap` 的测试夹具用了 `as never` / `as unknown as Bootstrap`,不会报;若某处报 missing property,补 `busyLabels: () => []`)。

- [ ] **Step 7: 真机冒烟(可选但推荐)**

daemon 在跑的话:

```bash
bun run src/cli.ts daemon api-info --json   # 取 baseUrl + token
curl -s -H "authorization: Bearer $TOKEN" $BASE/v1/companion/presence | jq
```

Expected: 一个三轴 JSON;idle 时 `activity.kind = "idle"`。

- [ ] **Step 8: 提交**

```bash
git add src/daemon/internal-api/routes-presence.ts src/daemon/internal-api/routes-presence.test.ts src/daemon/internal-api/types.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/schema.ts src/daemon/bootstrap/types.ts src/daemon/bootstrap/index.ts src/daemon/main.ts
git commit -m "GET /v1/companion/presence:桌宠三轴一个接口;busyLabels 走 thunk-over-bootRef"
```

---

### Task 6: 串门进行中登记 `activeVisit()`

**Files:**
- Modify: `src/daemon/bootstrap/wire-visit.ts`(`VisitDeps` 加 `now?`;`Visit` 加 `activeVisit`;登记 / 清除 / 过期)
- Modify: `src/daemon/bootstrap/wire-social.ts:462`(`socialPenpal` 加 `activeVisit`)
- Modify: `src/daemon/bootstrap/types.ts:326-332`(`social.penpal` 加 `activeVisit`)
- Test: `src/daemon/bootstrap/wire-visit.test.ts`

**Interfaces:**
- Consumes: `ActiveVisit`(Task 3)。
- Produces:
  - `VisitDeps.now?: () => number`(测试注入时钟;缺省 `Date.now`)
  - `Visit.activeVisit(): ActiveVisit | null`
  - `export const VISIT_STALE_MS = 6 * 60 * 60_000`
  - `boot.social.penpal.activeVisit(): ActiveVisit | null`

- [ ] **Step 1: 写失败测试**

`src/daemon/bootstrap/wire-visit.test.ts` 末尾追加。`side()` 和 `flush` 是文件顶层的,可直接用;`lonely()` 定义在「去邻居家串门」那个 describe 的作用域里,**拿不到**,所以这里自带一个 `lonelyVisit` 助手:

```ts
describe('activeVisit —— 桌宠要知道熊在不在家(spec 2026-09-03-companion-presence)', () => {
  /** 没有真信道的伙伴(只能去邻居家)。evalText 拿到 visit 自己,方便在串门中途偷看登记。 */
  const lonelyVisit = (evalText: (p: string, v: ReturnType<typeof makeVisit>) => Promise<string>, extra: Partial<VisitDeps> = {}) => {
    let self: ReturnType<typeof makeVisit>
    self = makeVisit({
      stateDir: mkdtempSync(join(tmpdir(), 'visit-av-')),
      channelStore: { get: () => null, list: () => [] } as never,
      letterStore: { listForChannel: () => [], markRead: () => {} } as never,
      sendEnvelope: async () => ({ ok: true }),
      evalText: (p) => evalText(p, self),
      myName: '我', disclosurePolicy: '不说住址', notifyOwner: () => {}, recordVisit: () => 'row-1', log: () => {},
      ...extra,
    })
    return self
  }

  it('去邻居家:串门期间登记 hosting=false,讲完给主人后清除', async () => {
    let seenDuring: ReturnType<ReturnType<typeof makeVisit>['activeVisit']> = null
    const visit = lonelyVisit(async (p, v) => {
      if (!seenDuring) seenDuring = v.activeVisit()   // 第一次 eval 时登记应已存在
      return p.includes('串门回来') ? '今天去阿柚家坐了会儿。' : '嗨'
    })
    expect(visit.activeVisit()).toBe(null)
    const r = await visit.startVisit()
    expect(r.ok).toBe(true)
    expect(seenDuring).toMatchObject({ hosting: false })
    expect(seenDuring!.peerLabel).toMatch(/^邻居「.+」$/)
    expect(visit.activeVisit()).toBe(null)
  })

  it('远程:我出门 → 我这边 visiting,对方那边 hosting;对方一直不回 → 双方都挂着', async () => {
    const A = side('阿一', async () => '阿一的话')
    const B = side('阿二', () => new Promise<string>(() => {}))   // 永远不回
    A.setPeer(B); B.setPeer(A)
    const r = await A.visit.startVisit('ch')
    expect(r.ok).toBe(true)
    await flush()
    expect(A.visit.activeVisit()).toMatchObject({ id: (r as { id: string }).id, hosting: false })
    expect(B.visit.activeVisit()).toMatchObject({ id: (r as { id: string }).id, hosting: true })
  })

  it('远程:六句聊完两边都清除', async () => {
    const fakeEval = (who: string) => async (p: string) => (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一')); const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)
    await A.visit.startVisit('ch'); await flush()
    expect(A.visit.activeVisit()).toBe(null)
    expect(B.visit.activeVisit()).toBe(null)
  })

  it('开场就失败(空话)→ 不留登记', async () => {
    const visit = lonelyVisit(async () => '   ')
    expect((await visit.startVisit()).ok).toBe(false)
    expect(visit.activeVisit()).toBe(null)
  })

  it('超过 VISIT_STALE_MS 视为夭折 → null(对端永远不回时熊不能永远不在家)', async () => {
    let now = 1_000_000
    // side() 不暴露 deps,所以直接 makeVisit:一条开着的远程信道,对方永远不回,时钟可控
    const letters: Array<{ id: string; direction: 'in' | 'out'; plaintext: string | null; read_at: string | null; kind: string; payload: string | null }> = []
    const visit = makeVisit({
      stateDir: mkdtempSync(join(tmpdir(), 'visit-stale-')),
      channelStore: { get: () => ({ id: 'ch', status: 'open', degree: 1 }), list: () => [{ id: 'ch', status: 'open', degree: 1 }] } as never,
      letterStore: { listForChannel: () => letters, markRead: () => {} } as never,
      sendEnvelope: async (_c, env) => { letters.push({ id: `o${letters.length}`, direction: 'out', plaintext: '', read_at: null, kind: env.kind, payload: JSON.stringify(env.payload) }); return { ok: true } },
      evalText: async () => '开场白', myName: '我', disclosurePolicy: '不说住址', notifyOwner: () => {}, log: () => {},
      now: () => now,
    })
    expect((await visit.startVisit('ch')).ok).toBe(true)
    expect(visit.activeVisit()).not.toBe(null)
    now += VISIT_STALE_MS - 1
    expect(visit.activeVisit()).not.toBe(null)
    now += 2
    expect(visit.activeVisit()).toBe(null)
  })
})
```

import 行改成 `import { makeVisit, cleanSpeech, readNeighborMemory, VISIT_STALE_MS, type VisitDeps } from './wire-visit'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-visit.test.ts -t activeVisit`
Expected: FAIL — `visit.activeVisit is not a function` / `VISIT_STALE_MS` undefined

- [ ] **Step 3: 实现**

`src/daemon/bootstrap/wire-visit.ts`:

(a) import 加 `import type { ActiveVisit } from '../../core/companion-presence'`。

(b) `VisitDeps` 加:

```ts
  /** 时钟(测试注入)。缺省 Date.now。 */
  now?: () => number
```

(c) `Visit` 接口加:

```ts
  /**
   * 进行中的串门(spec 2026-09-03-companion-presence §2.2)。桌宠靠它显示
   * 「去 X 家串门了」/「X 来串门了」。超过 VISIT_STALE_MS 视为夭折返回 null。
   */
  activeVisit(): ActiveVisit | null
```

(d) 常量,放在 `VISIT_MAX_ROUNDS` import 附近的模块级:

```ts
/** 远程对端永远不回信时,登记多久后放弃 —— 熊不能永远不在家,那也是撒谎。 */
export const VISIT_STALE_MS = 6 * 60 * 60_000
```

(e) `makeVisit` 内部、`// ── 状态机` 注释之前加登记状态:

```ts
  // ── 进行中登记(内存;远程会话本身不驻留,只留这一条给桌宠看)──
  const now = deps.now ?? Date.now
  let current: ActiveVisit | null = null
  const register = (s: Session, hosting: boolean): void => {
    if (current?.id === s.id) return
    current = { id: s.id, peerLabel: s.peerLabel, hosting, sinceMs: now() }
  }
  const clear = (id: string): void => { if (current?.id === id) current = null }
  const activeVisit = (): ActiveVisit | null => {
    if (current && now() - current.sinceMs > VISIT_STALE_MS) current = null
    return current
  }
```

(f) `finish` 末尾(明信片块之前,`s.afterFinish` 那行之后)加 `clear(s.id)`。注意 `finish` 里 `transcript.length === 0` 的早退也要 `clear(s.id)`:

```ts
    const transcript = s.transcript()
    if (transcript.length === 0) { clear(s.id); return }
```

(g) `onPeerTurn`:第一行改为

```ts
  const onPeerTurn = async (s: Session, p: VisitPayload): Promise<void> => {
    // 对方说的第 p.round 句:奇数轮是对方开的头(来客),偶数轮是回我的(我去的)。
    // 重启后内存登记丢了也能从轮次恢复 —— 轮次才是权威。
    register(s, p.round % 2 === 1)
    s.record({ who: 'peer', round: p.round, text: p.text })
```

(h) `visitNeighbor` 和 `startRemote`:`sayMine(s, 1)` 之前 `register(s, false)`,catch 里 `clear(s.id)`:

```ts
  const visitNeighbor = async (nb: Neighbor): Promise<StartResult> => {
    const { s } = neighborSession(nb)
    register(s, false)
    try { await sayMine(s, 1) }
    catch (err) {
      clear(s.id)
      if (err instanceof VisitAbort) return { ok: false, reason: err.reason }
      return { ok: false, reason: `eval_failed: ${err instanceof Error ? err.message : String(err)}` }
    }
```

`startRemote` 同样改。

(i) `onInbound` 的 `.catch(...)` 里加清除:

```ts
      const s = remoteSession(channelRowId, p.id)
      void onPeerTurn(s, p)
        .catch(err => { clear(s.id); deps.log('VISIT', `continue failed: ${err instanceof VisitAbort ? err.reason : err instanceof Error ? err.message : String(err)}`) })
```

(j) 返回对象加 `activeVisit,`。

`src/daemon/bootstrap/wire-social.ts:462` 的 `socialPenpal = { ..., startVisit: (c) => visit!.startVisit(c) }` 加 `, activeVisit: () => visit!.activeVisit()`。

`src/daemon/bootstrap/types.ts` `social.penpal` 加:

```ts
      /** 进行中的串门(spec 2026-09-03-companion-presence)。 */
      activeVisit(): import('../../core/companion-presence').ActiveVisit | null
```

wire-social.ts 第 171-178 行那份 `penpal` 类型(SocialWiring 里的)同样加一行 `activeVisit: import('./wire-visit').Visit['activeVisit']`。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-visit.test.ts src/daemon/bootstrap/wire-social.test.ts && bun run typecheck`
Expected: PASS;typecheck 无错。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/bootstrap/wire-visit.ts src/daemon/bootstrap/wire-visit.test.ts src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/types.ts
git commit -m "串门加进行中登记 activeVisit():出门 / 来客 / 讲完清除 / 6h 夭折 —— 桌宠「熊不在家」的来源"
```

---

### Task 7: 桌面纯函数:`presence-poller` + `sceneStateFrom`

**Files:**
- Create: `apps/desktop/src/presence-poller.js`
- Create: `apps/desktop/src/companion-scene-state.js`
- Test: `apps/desktop/src/presence-poller.test.ts`
- Test: `apps/desktop/src/companion-scene-state.test.ts`

**Interfaces:**
- Produces:
  - `createPresencePoller({ invokeApi, intervalMs = 20_000 })` → `{ start(), stop(), refresh(), subscribe(cb), current }`;拉不到时**发布** `{ presence: 'down', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }`(不保留上一次的好状态)。
  - `sceneStateFrom(presence | null)` → `SceneState = { bearPresent, bearPose: 'idle'|'wave'|'fishing'|'busy', tint: 'normal'|'dim'|'dark', sign: string|null, prop: 'bag'|'postcard'|'letter'|null, badge: number, bubble: string|null }`;`null` 输入 = down。
  - `DOWN_PRESENCE` 常量(上面那个对象)从 `presence-poller.js` 导出。

- [ ] **Step 1: 写失败测试(poller)**

`apps/desktop/src/presence-poller.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createPresencePoller, DOWN_PRESENCE } from './presence-poller.js'

const ok = { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }

describe('createPresencePoller', () => {
  it('refresh() 打 GET /v1/companion/presence 一次并通知订阅者', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    const sub = vi.fn(); p.subscribe(sub)
    await p.refresh()
    expect(invokeApi).toHaveBeenCalledWith('GET', '/v1/companion/presence', undefined, { timeoutMs: 5_000 })
    expect(sub).toHaveBeenCalledWith(ok)
    expect(p.current).toEqual(ok)
  })
  it('并发 refresh 共享一个 in-flight', () => {
    const invokeApi = vi.fn(() => new Promise(() => {}))
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    expect(p.refresh()).toBe(p.refresh())
    expect(invokeApi).toHaveBeenCalledOnce()
  })
  it('拉不到 → 发布 down,不保留上一次的好状态(灯该灭就灭)', async () => {
    const invokeApi = vi.fn().mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    const sub = vi.fn(); p.subscribe(sub)
    await p.refresh(); await p.refresh()
    expect(sub).toHaveBeenLastCalledWith(DOWN_PRESENCE)
    expect(p.current).toEqual(DOWN_PRESENCE)
  })
  it('subscribe 回放缓存;退订后不再收到;一个订阅者抛不影响别人', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 60_000 })
    await p.refresh()
    const late = vi.fn(); const unsub = p.subscribe(late)
    expect(late).toHaveBeenCalledWith(ok)
    p.subscribe(() => { throw new Error('crash') })
    const good = vi.fn(); p.subscribe(good)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    unsub(); late.mockClear()
    await p.refresh()
    expect(late).not.toHaveBeenCalled()
    expect(good).toHaveBeenCalledWith(ok)
    errSpy.mockRestore()
  })
  it('start() 立即刷一次并按 interval 重复;stop() 停', async () => {
    vi.useFakeTimers()
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = createPresencePoller({ invokeApi, intervalMs: 1000 })
    p.start(); p.start()
    expect(invokeApi).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(invokeApi).toHaveBeenCalledTimes(3)
    p.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(invokeApi).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 写失败测试(scene state)**

`apps/desktop/src/companion-scene-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sceneStateFrom } from './companion-scene-state.js'

const P = (presence: string, kind = 'idle', label = '', news = { unread: 0, latest_kind: null as string | null, latest_title: null as string | null }) =>
  ({ presence, activity: { kind, label, since: null }, news })

describe('sceneStateFrom — spec §3.2 逐行', () => {
  it('null / down / offline → 熊不在,dark,牌子「离线」(事实,不是故事)', () => {
    for (const p of [null, P('down'), P('offline')]) {
      const s = sceneStateFrom(p as never)
      expect(s).toMatchObject({ bearPresent: false, tint: 'dark', sign: '离线', bubble: null })
    }
  })
  it('down 时即使有 activity 也不讲故事', () => {
    expect(sceneStateFrom(P('down', 'visiting', '去X家串门了')).sign).toBe('离线')
  })
  it('degraded → dim,其余按 activity', () => {
    expect(sceneStateFrom(P('degraded', 'foraging', '觅食中'))).toMatchObject({ bearPresent: true, tint: 'dim', bearPose: 'fishing', sign: '觅食中' })
  })
  it('chatting → wave + bubble,没牌子', () => {
    expect(sceneStateFrom(P('ok', 'chatting', '在跟你聊'))).toMatchObject({ bearPresent: true, bearPose: 'wave', sign: null, bubble: '在跟你聊' })
  })
  it('hosting_human → wave + 牌子「家里有客人」', () => {
    expect(sceneStateFrom(P('ok', 'hosting_human', '家里有客人'))).toMatchObject({ bearPose: 'wave', sign: '家里有客人', bubble: null })
  })
  it('visiting → 熊不在,牌子 = label(缺席就是内容)', () => {
    expect(sceneStateFrom(P('ok', 'visiting', '去邻居「阿柚」家串门了'))).toMatchObject({ bearPresent: false, tint: 'normal', sign: '去邻居「阿柚」家串门了' })
  })
  it('hosting_peer → 熊在,idle,牌子 = label', () => {
    expect(sceneStateFrom(P('ok', 'hosting_peer', 'X来串门了'))).toMatchObject({ bearPresent: true, bearPose: 'idle', sign: 'X来串门了' })
  })
  it('foraging → fishing + 牌子「觅食中」', () => {
    expect(sceneStateFrom(P('ok', 'foraging', '觅食中'))).toMatchObject({ bearPose: 'fishing', sign: '觅食中' })
  })
  it('working → busy + bubble,没牌子', () => {
    expect(sceneStateFrom(P('ok', 'working', '在忙一件事'))).toMatchObject({ bearPose: 'busy', sign: null, bubble: '在忙一件事' })
  })
  it('idle → 全空', () => {
    expect(sceneStateFrom(P('ok'))).toEqual({ bearPresent: true, bearPose: 'idle', tint: 'normal', sign: null, prop: null, badge: 0, bubble: null })
  })
})

describe('sceneStateFrom — 道具', () => {
  const news = (k: string | null, n = 2) => ({ unread: n, latest_kind: k, latest_title: 't' })
  it('unread 0 → 没道具,不管 kind', () => {
    expect(sceneStateFrom(P('ok', 'idle', '', news('hunt', 0)))).toMatchObject({ prop: null, badge: 0 })
  })
  it('hunt → bag;visit / postcard → postcard;letter → letter;其它 → bag;badge = unread', () => {
    expect(sceneStateFrom(P('ok', 'idle', '', news('hunt')))).toMatchObject({ prop: 'bag', badge: 2 })
    expect(sceneStateFrom(P('ok', 'idle', '', news('visit')))).toMatchObject({ prop: 'postcard' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('postcard')))).toMatchObject({ prop: 'postcard' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('letter')))).toMatchObject({ prop: 'letter' })
    expect(sceneStateFrom(P('ok', 'idle', '', news('gift')))).toMatchObject({ prop: 'bag' })
  })
  it('熊不在家(visiting)时道具照样摆着 —— 回来之前带的东西还在', () => {
    expect(sceneStateFrom(P('ok', 'visiting', '去X家', news('hunt', 1)))).toMatchObject({ bearPresent: false, prop: 'bag', badge: 1 })
  })
  it('down 时不画道具(daemon 都没起,数字不可信)', () => {
    expect(sceneStateFrom(P('down', 'idle', '', news('hunt', 3)))).toMatchObject({ prop: null, badge: 0 })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/presence-poller.test.ts apps/desktop/src/companion-scene-state.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 4: 实现 poller**

`apps/desktop/src/presence-poller.js`:

```js
// @ts-check
// presence-poller.js — 桌宠状态的轮询(spec 2026-09-03-companion-presence §3.1)。
//
// 契约照 doctor-poller.js:单例、去重、subscribe 回放、无 DOM 依赖。
// 一点不同:拉不到时**发布 DOWN_PRESENCE**,不保留上一次的好状态 —— 灯该灭
// 就灭,daemon 挂了还挥手的熊是在撒谎。

/** @typedef {{ presence: string, activity: { kind: string, label: string, since: string | null }, news: { unread: number, latest_kind: string | null, latest_title: string | null } }} Presence */

/** @type {Presence} */
export const DOWN_PRESENCE = Object.freeze({
  presence: 'down',
  activity: Object.freeze({ kind: 'idle', label: '', since: null }),
  news: Object.freeze({ unread: 0, latest_kind: null, latest_title: null }),
})

/**
 * @param {{ invokeApi: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>, intervalMs?: number }} opts
 */
export function createPresencePoller({ invokeApi, intervalMs = 20_000 }) {
  /** @type {Presence | null} */
  let current = null
  /** @type {Set<(p: Presence) => void>} */
  const subscribers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {Promise<Presence> | null} */
  let inflight = null

  /** @param {Presence} p */
  function notify(p) {
    for (const cb of Array.from(subscribers)) {
      try { cb(p) } catch (err) { console.error('presence subscriber threw', err) }
    }
  }

  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      let next = DOWN_PRESENCE
      try {
        const r = /** @type {Presence | null} */ (await invokeApi('GET', '/v1/companion/presence', undefined, { timeoutMs: 5_000 }))
        if (r && typeof r === 'object' && typeof r.presence === 'string') next = r
      } catch { /* down */ }
      current = next
      notify(next)
      return next
    })().finally(() => { inflight = null })
    return inflight
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { refresh() }, intervalMs)
      refresh()
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
    refresh,
    /** @param {(p: Presence) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      if (current) { try { cb(current) } catch (err) { console.error('presence subscriber threw', err) } }
      return () => subscribers.delete(cb)
    },
    get current() { return current },
  }
}
```

- [ ] **Step 5: 实现 scene state**

`apps/desktop/src/companion-scene-state.js`:

```js
// @ts-check
// companion-scene-state.js — 状态 → 画面的薄映射(spec 2026-09-03-companion-presence §3.2)。
// 纯函数;animation-lab.js 只认 SceneState,不认 presence。

/** @typedef {import('./presence-poller.js').Presence} Presence */
/** @typedef {{ bearPresent: boolean, bearPose: 'idle'|'wave'|'fishing'|'busy', tint: 'normal'|'dim'|'dark', sign: string|null, prop: 'bag'|'postcard'|'letter'|null, badge: number, bubble: string|null }} SceneState */

/** @param {string | null} kind */
function propFor(kind) {
  if (kind === 'visit' || kind === 'postcard') return /** @type {const} */ ('postcard')
  if (kind === 'letter') return /** @type {const} */ ('letter')
  return /** @type {const} */ ('bag')
}

/**
 * @param {Presence | null} p
 * @returns {SceneState}
 */
export function sceneStateFrom(p) {
  // 不在线:不是故事,是事实。不画熊、不画道具、不讲活动。
  if (!p || p.presence === 'down' || p.presence === 'offline') {
    return { bearPresent: false, bearPose: 'idle', tint: 'dark', sign: '离线', prop: null, badge: 0, bubble: null }
  }
  const tint = p.presence === 'degraded' ? 'dim' : 'normal'
  const unread = Math.max(0, Math.trunc(Number(p.news?.unread) || 0))
  const prop = unread > 0 ? propFor(p.news?.latest_kind ?? null) : null
  const a = p.activity ?? { kind: 'idle', label: '', since: null }
  /** @type {SceneState} */
  const base = { bearPresent: true, bearPose: 'idle', tint, sign: null, prop, badge: unread, bubble: null }
  switch (a.kind) {
    case 'chatting':      return { ...base, bearPose: 'wave', bubble: a.label }
    case 'hosting_human': return { ...base, bearPose: 'wave', sign: a.label }
    case 'visiting':      return { ...base, bearPresent: false, sign: a.label }
    case 'hosting_peer':  return { ...base, sign: a.label }
    case 'foraging':      return { ...base, bearPose: 'fishing', sign: a.label }
    case 'working':       return { ...base, bearPose: 'busy', bubble: a.label }
    default:              return base
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun --bun vitest run apps/desktop/src/presence-poller.test.ts apps/desktop/src/companion-scene-state.test.ts apps/desktop/src/modules/module-syntax.test.ts`
Expected: PASS(module-syntax 测试扫所有 modules 的语法,新文件在 src 根下不受它管,但跑一下无害)

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/presence-poller.js apps/desktop/src/presence-poller.test.ts apps/desktop/src/companion-scene-state.js apps/desktop/src/companion-scene-state.test.ts
git commit -m "桌面:presence 轮询器(拉不到就发 down)+ sceneStateFrom 状态到画面映射"
```

---

### Task 8: animation-lab `setState` 入口 + 缺席 / 姿势 / 牌子 / 道具 / 遮罩

**Files:**
- Modify: `apps/desktop/src/animation-lab.js`(状态对象、`drawBearArm`、`frame`、`showNextBearGreeting`、click 处理、三个新绘制函数)

**Interfaces:**
- Consumes: `SceneState`(Task 7)。
- Produces: `window.__companionScene = { setState(partial), getState(), onPropClick: (() => void) | null }`。

没有单测(canvas);验收用 `apps/desktop/src/animation-lab.html` 在浏览器里手动过七种状态(Step 4)。

- [ ] **Step 1: 状态对象 + 全局入口**

在 `let calm = false` 之前加:

```js
// ── 桌宠状态(spec 2026-09-03-companion-presence §3.3)────────────────────
// 外面(companion-presence.js)算好 SceneState 喂进来;渲染循环只读它。
// 默认值 = 什么都不知道时的样子:熊在、闲着、正常光、没牌子没道具。
const sceneState = { bearPresent: true, bearPose: "idle", tint: "normal", sign: null, prop: null, badge: 0, bubble: null }
window.__companionScene = {
  setState(next) {
    Object.assign(sceneState, next)
    applySceneBubble()
  },
  getState() { return { ...sceneState } },
  /** 点脚边道具时调;由 companion-presence.js 赋值。 */
  onPropClick: null,
}
function applySceneBubble() {
  if (sceneState.bubble) {
    bearMessage.textContent = sceneState.bubble
    bearMessage.classList.add("is-visible")
  } else bearMessage.classList.remove("is-visible")
}
```

- [ ] **Step 2: 姿势与问候**

`drawBearArm`:把

```js
  const liftAmount = waving ? Math.sin(progress * Math.PI) : 0
```

改为

```js
  // 钓鱼(觅食中):手臂持续微抬、慢慢上下 —— 复用现成的钓鱼手臂,不加素材。
  const fishing = sceneState.bearPose === "fishing"
  const liftAmount = waving ? Math.sin(progress * Math.PI) : fishing ? .55 + Math.sin(time * .003) * .1 : 0
```

`frame` 开头两行改为:

```js
  // 有真实状态的 bubble 时停掉固定问候的轮播 —— 两套文案打架会很怪。
  if (!bearHovering && !sceneState.bubble && sceneState.bearPresent && time >= nextBearIdleGreetingAt) startBearWave(time)
  if (!sceneState.bubble && time >= bearMessageUntil) bearMessage.classList.remove("is-visible")
```

`showNextBearGreeting` 开头加一行:`if (sceneState.bubble) return`。

- [ ] **Step 3: 缺席、牌子、道具、遮罩**

`frame` 里 `drawBearPuppet(time)` 那段改为:

```js
  if (sceneState.bearPresent) drawBearPuppet(time)
  drawSceneSign()
  drawSceneProp(time)
  updateCrabEscapeOverlay(time)
  if (sceneState.bearPresent && bearAwake > 0) {
```

(原来 `if (bearAwake > 0) {` 那行改成带 `sceneState.bearPresent &&`。)

`requestAnimationFrame(frame)` 之前加 `drawSceneTint()`。

三个新函数,放在 `drawBearPuppet` 之后:

```js
// ── 桌宠状态的三样新东西:牌子、道具、遮罩(spec §3.3:唯一新画的素材)──

/** 沙地上的牌子:熊不在时立在熊的位置;熊在时立在它脚边。文字来自 activity.label / 「离线」。 */
function drawSceneSign() {
  if (!sceneState.sign) return
  const w = canvas.width, h = canvas.height
  const x = (bearRig.anchorX + bearLocalOffsetX() + (sceneState.bearPresent ? .17 : 0)) * w
  const y = .80 * h
  const fontPx = Math.max(11, Math.round(w * .026))
  ctx.save()
  ctx.font = `${fontPx}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = "center"; ctx.textBaseline = "middle"
  const padX = fontPx * .7, padY = fontPx * .45
  const textW = ctx.measureText(sceneState.sign).width
  const bw = textW + padX * 2, bh = fontPx + padY * 2
  // 木牌 + 小桩
  ctx.fillStyle = "rgba(120, 84, 52, .9)"
  ctx.fillRect(x - 2, y + bh / 2, 4, h * .05)
  ctx.fillStyle = "rgba(233, 214, 178, .95)"
  ctx.strokeStyle = "rgba(120, 84, 52, .9)"; ctx.lineWidth = 2
  ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, fontPx * .4); ctx.fill(); ctx.stroke()
  ctx.fillStyle = "rgba(78, 54, 34, 1)"
  ctx.fillText(sceneState.sign, x, y)
  ctx.restore()
}

/** 道具区(归一化坐标),点击命中用。 */
const propBox = { x: .30, y: .80, w: .07, h: .10 }
function propContains(x, y) {
  return !!sceneState.prop && x > propBox.x && x < propBox.x + propBox.w && y > propBox.y && y < propBox.y + propBox.h
}

/** 熊脚边的道具:包袱 / 明信片 / 信,带未看数字。emoji 直接画,不加素材。 */
function drawSceneProp(time) {
  if (!sceneState.prop) return
  const w = canvas.width, h = canvas.height
  const glyph = sceneState.prop === "postcard" ? "🖼️" : sceneState.prop === "letter" ? "✉️" : "🎒"
  const size = Math.round(w * .05)
  const cx = (propBox.x + propBox.w / 2) * w
  const cy = (propBox.y + propBox.h / 2) * h + Math.sin(time * .002) * h * .004   // 轻微浮动,提示可点
  ctx.save()
  ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  ctx.textAlign = "center"; ctx.textBaseline = "middle"
  ctx.fillText(glyph, cx, cy)
  if (sceneState.badge > 0) {
    const r = Math.max(7, size * .22)
    const bx = cx + size * .38, by = cy - size * .38
    ctx.fillStyle = "rgba(226, 84, 84, .95)"
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "#fff"
    ctx.font = `bold ${Math.round(r * 1.3)}px -apple-system, sans-serif`
    ctx.fillText(sceneState.badge > 9 ? "9+" : String(sceneState.badge), bx, by + .5)
  }
  ctx.restore()
}

/** 整缸的明暗:degraded 略暗,down / offline 灯灭。最后一层画。 */
function drawSceneTint() {
  if (sceneState.tint === "normal") return
  ctx.save()
  ctx.fillStyle = sceneState.tint === "dark" ? "rgba(12, 20, 38, .58)" : "rgba(20, 30, 50, .22)"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
}
```

`canvas.addEventListener("click", …)` 处理函数开头(`const p = positionFromEvent(event)` 之后)加:

```js
  if (propContains(p.x, p.y)) {
    try { window.__companionScene.onPropClick?.() } catch (err) { console.warn("prop click handler failed", err) }
    return
  }
```

`pointermove` 里 cursor 那行改为:

```js
  const overProp = propContains(pointer.x, pointer.y)
  canvas.style.cursor = overBear || overLotus || overCrab || overProp ? "pointer" : waterContains(pointer.x, pointer.y) ? "crosshair" : "default"
```

`bearContains` 在熊不在时应返回 false(否则 hover 空位还会触发挥手):函数第一行加 `if (!sceneState.bearPresent) return false`。

- [ ] **Step 4: 手动验收(animation-lab.html)**

```bash
cd apps/desktop && bun run dev:web   # test-shim 起静态服务;打开它打印的地址 + /animation-lab.html
```

浏览器控制台逐个贴:

```js
__companionScene.setState({ bearPresent:false, tint:'dark', sign:'离线', prop:null, badge:0, bubble:null })
__companionScene.setState({ bearPresent:true, tint:'normal', bearPose:'fishing', sign:'觅食中' })
__companionScene.setState({ bearPresent:false, sign:'去邻居「阿柚」家串门了', prop:'bag', badge:2 })
__companionScene.setState({ bearPresent:true, bearPose:'wave', sign:null, bubble:'在跟你聊' })
__companionScene.setState({ bearPose:'busy', bubble:'在忙一件事' })
__companionScene.setState({ bearPose:'idle', bubble:null, prop:'postcard', badge:1 })
__companionScene.onPropClick = () => console.log('prop clicked'); // 然后点包袱
__companionScene.setState({ tint:'dim' })
```

Expected:每条状态肉眼对得上 §3.2 表;点道具打印 `prop clicked`;bubble 存在时固定问候不再轮播;熊不在时 hover 空位不挥手。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/animation-lab.js
git commit -m "鱼缸接状态:setState 入口 + 熊缺席 / 钓鱼姿势 / 牌子 / 道具 / 明暗遮罩(只加不重排)"
```

---

### Task 9: `companion-presence.js` 把轮询接到两个鱼缸

**Files:**
- Create: `apps/desktop/src/companion-presence.js`
- Create: `apps/desktop/src/companion-window-presence.js`
- Modify: `apps/desktop/src/companion-window.html:26-28`(加一个 module script)
- Modify: `apps/desktop/src/main.js:20, 113`(import + 启动)
- Test: `apps/desktop/src/companion-presence.test.ts`

**Interfaces:**
- Consumes: `createPresencePoller`、`sceneStateFrom`(Task 7),`window.__companionScene`(Task 8),`invokeApi`(api.js),`invoke`(ipc.js)。
- Produces: `startCompanionPresence({ onOpenJournal, intervalMs?, invokeApi?, scene? })` → poller(暴露 `refresh()` 给 Task 10)。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/companion-presence.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { startCompanionPresence } from './companion-presence.js'

const ok = { presence: 'ok', activity: { kind: 'foraging', label: '觅食中', since: null }, news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } }

describe('startCompanionPresence', () => {
  it('每次轮询把 sceneStateFrom(presence) 喂给场景,并把 onOpenJournal 挂到 onPropClick', async () => {
    const scene = { setState: vi.fn(), getState: () => ({}), onPropClick: null as null | (() => void) }
    const onOpenJournal = vi.fn()
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = startCompanionPresence({ onOpenJournal, invokeApi, scene, intervalMs: 60_000 })
    await p.refresh()
    expect(scene.setState).toHaveBeenLastCalledWith(expect.objectContaining({ bearPose: 'fishing', sign: '觅食中', prop: 'bag', badge: 1 }))
    scene.onPropClick?.()
    expect(onOpenJournal).toHaveBeenCalledOnce()
    p.stop()
  })
  it('场景还没就绪(scene=null)时不炸,只是不画', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = startCompanionPresence({ onOpenJournal: () => {}, invokeApi, scene: null, intervalMs: 60_000 })
    await expect(p.refresh()).resolves.toBeTruthy()
    p.stop()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/companion-presence.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: 实现**

`apps/desktop/src/companion-presence.js`:

```js
// @ts-check
// companion-presence.js — 把桌宠状态接到鱼缸(spec 2026-09-03-companion-presence §3)。
// 主界面首页和浮窗各调一次;它们挂的是同一个 animation-lab,所以两处自动一致。
import { invokeApi as defaultInvokeApi } from './api.js'
import { createPresencePoller } from './presence-poller.js'
import { sceneStateFrom } from './companion-scene-state.js'

/**
 * @param {{
 *   onOpenJournal: () => void,
 *   intervalMs?: number,
 *   invokeApi?: typeof defaultInvokeApi,
 *   scene?: { setState(s: unknown): void, onPropClick: (() => void) | null } | null,
 * }} opts  scene 缺省读 window.__companionScene(每次轮询时读,animation-lab 可能晚于本模块就绪)
 */
export function startCompanionPresence({ onOpenJournal, intervalMs = 20_000, invokeApi = defaultInvokeApi, scene }) {
  const poller = createPresencePoller({ invokeApi, intervalMs })
  const resolveScene = () => scene === undefined ? /** @type {any} */ (globalThis).__companionScene ?? null : scene
  poller.subscribe(p => {
    const s = resolveScene()
    if (!s) return
    s.onPropClick = onOpenJournal
    s.setState(sceneStateFrom(p))
  })
  poller.start()
  return poller
}
```

`apps/desktop/src/companion-window-presence.js`:

```js
// @ts-check
// 浮窗的状态接线:点道具 → 让主窗口露面并切到觅食台(Task 10 的 tauri 命令)。
import { invoke } from './ipc.js'
import { startCompanionPresence } from './companion-presence.js'

startCompanionPresence({
  onOpenJournal: () => { invoke('show_main_window', { page: 'a2a-agents' }).catch(err => console.warn('show_main_window failed', err)) },
})
```

`apps/desktop/src/companion-window.html`:在 `<script src="./companion-window.js"></script>` 之后加

```html
    <script type="module" src="./companion-window-presence.js"></script>
```

`apps/desktop/src/main.js`:import 段加 `import { startCompanionPresence } from "./companion-presence.js"`;在 `const doctorPoller = createDoctorPoller(...)` 之后加:

```js
// 桌宠状态(spec 2026-09-03-companion-presence):首页鱼缸跟浮窗共用一套推导。
// 点脚边道具 → 切到觅食台(带回来的在那儿)。switchPane 是函数声明,提升可用。
const presencePoller = startCompanionPresence({ onOpenJournal: () => switchPane("a2a-agents") })
```

- [ ] **Step 4: 跑测试 + 语法检查**

Run: `bun --bun vitest run apps/desktop/src/companion-presence.test.ts apps/desktop/src/modules/module-syntax.test.ts apps/desktop/src/view.test.ts`
Expected: PASS

- [ ] **Step 5: 真机看一眼**

`cd apps/desktop && bun run dev`(= `tauri dev`):首页鱼缸和「浮到桌面」的浮窗都应在 20 秒内反映 daemon 状态;把 daemon 停掉(`wechat-cc service stop`),下一拍缸变暗、熊消失、牌子「离线」;起回来恢复。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/companion-presence.js apps/desktop/src/companion-presence.test.ts apps/desktop/src/companion-window-presence.js apps/desktop/src/companion-window.html apps/desktop/src/main.js
git commit -m "两个鱼缸接上桌宠状态轮询:首页 + 浮窗共用一套推导"
```

---

### Task 10: 闭环 —— `show_main_window` + 切页事件 + 打开觅食台即推水位

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:137, 916-919`(新命令 + 注册)
- Modify: `apps/desktop/src/modules/journal.js`(加 `markJournalSeen`)
- Modify: `apps/desktop/src/main.js:468-470`(`switchPane` 的 a2a-agents 分支)+ 启动处监听事件
- Test: `apps/desktop/src/modules/journal.test.ts`(追加一条)

**Interfaces:**
- Consumes: `presencePoller.refresh()`(Task 9),`POST /v1/journal/seen`(Task 4)。
- Produces:
  - tauri 命令 `show_main_window(page: Option<String>)`:显示并聚焦 `main`,有 page 就 `emit("wechat-cc:navigate", { page })`。
  - `markJournalSeen(): Promise<boolean>`(journal.js)。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/modules/journal.test.ts` 顶部已经有 `const invokeApi = vi.fn()` 并 `vi.mock('../api.js', …)` 转发到它;模块是用 `const { renderHuntBag, … } = await import('./journal.js')` 顶层解构进来的。把 `markJournalSeen` 加进那个解构,然后文件末尾追加:

```ts
describe('markJournalSeen —— 打开觅食台 = 看过了', () => {
  it('打 POST /v1/journal/seen;失败吞掉返回 false', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, seen_until: 'x' })
    await expect(markJournalSeen()).resolves.toBe(true)
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/journal/seen')
    invokeApi.mockRejectedValueOnce(new Error('down'))
    await expect(markJournalSeen()).resolves.toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/modules/journal.test.ts`
Expected: FAIL — `markJournalSeen` is not exported

- [ ] **Step 3: 实现 `markJournalSeen`**

`apps/desktop/src/modules/journal.js`,`refreshHuntBag` 之前加:

```js
/**
 * 主人打开了觅食台 = 带回来的都看过了(spec 2026-09-03-companion-presence §2.3)。
 * 推 daemon 侧水位;桌宠脚边的包袱在下一次轮询消失。失败无所谓 —— 下次打开再推。
 * @returns {Promise<boolean>}
 */
export async function markJournalSeen() {
  try {
    const r = /** @type {{ ok?: boolean } | null} */ (await invokeApi('POST', '/v1/journal/seen'))
    return !!r?.ok
  } catch { return false }
}
```

- [ ] **Step 4: main.js:切到觅食台时推水位 + 监听浮窗的导航事件**

`apps/desktop/src/main.js` import 段加 `import { markJournalSeen } from "./modules/journal.js"`。

`switchPane` 里:

```js
  if (name === "a2a-agents") {
    refreshA2AAgents().catch(err => console.error("a2a-agents refresh failed", err))
    // 打开觅食台 = 看过了:推水位,再立刻刷一次桌宠状态让包袱消失。
    markJournalSeen().then(() => presencePoller.refresh()).catch(() => {})
  }
```

启动处(`initA2AAgentsTab()` 那一带、DOM 就绪之后)加:

```js
  // 浮窗点道具 → Rust show_main_window 发来的导航事件(spec 2026-09-03 §3.4)。
  // 只认白名单里的 pane,事件 payload 不可信。
  const tauriEvent = /** @type {any} */ (window).__TAURI__?.event
  if (tauriEvent?.listen) {
    tauriEvent.listen("wechat-cc:navigate", (/** @type {{ payload?: { page?: string } }} */ ev) => {
      const page = ev?.payload?.page
      if (page === "a2a-agents") switchPane(page)
    }).catch((/** @type {unknown} */ err) => console.warn("navigate listener failed", err))
  }
```

- [ ] **Step 5: Rust 命令**

`apps/desktop/src-tauri/src/lib.rs`,`open_companion_window` 之后加:

```rust
// 浮窗点脚边的道具 → 主窗口露面并切到觅食台(spec 2026-09-03-companion-presence §3.4)。
// 页面名只是转发,白名单在 JS 侧;这里不解释它。async 与 open_companion_window
// 同理(Windows 上窗口操作别占主线程)。
#[tauri::command]
async fn show_main_window(app: AppHandle, page: Option<String>) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is not open".to_string())?;
    main.show().map_err(|err| format!("show main window: {err}"))?;
    main.unminimize().map_err(|err| format!("unminimize main window: {err}"))?;
    main.set_focus().map_err(|err| format!("focus main window: {err}"))?;
    if let Some(page) = page {
        main.emit("wechat-cc:navigate", serde_json::json!({ "page": page }))
            .map_err(|err| format!("emit navigate: {err}"))?;
    }
    Ok(())
}
```

`generate_handler![...]` 里 `resize_companion_window,` 后加 `show_main_window,`。

- [ ] **Step 6: 编译 + 测试**

Run:

```bash
cd apps/desktop/src-tauri && cargo check
cd ../../.. && bun --bun vitest run apps/desktop/src/modules/journal.test.ts apps/desktop/src/companion-presence.test.ts
```

Expected: cargo check 通过(`Emitter` 已 import,`serde_json` 已在 Cargo.toml);vitest PASS。

- [ ] **Step 7: 真机闭环**

`cd apps/desktop && bun run dev`:
1. 让 journal 里有一条新东西(等打猎,或 `wechat-cc` 里手动 `串门`)→ 浮窗熊脚边出现包袱,角标 1。
2. 点包袱 → 主窗口露面并切到觅食台,「带回来的」里有那条。
3. 20 秒内包袱消失。
4. `curl …/v1/companion/presence` 里 `news.unread` 为 0。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src/modules/journal.js apps/desktop/src/modules/journal.test.ts apps/desktop/src/main.js
git commit -m "闭环:点包袱 → 主窗口切觅食台 → 推水位 → 包袱消失(show_main_window + navigate 事件)"
```

---

## 完成后

- 跑全量:`bun --bun vitest run && bun run typecheck`。
- 更新 memory:`visit-companion-social.md` 里记一笔「桌宠状态 on dev」+ 真机观察到的第一次「熊不在家」。
- 留给 4b 的(spec §4):hosting_peer 的第二个剪影、道具按 kind 精细绘制、微信侧「你在干嘛」复用 `derivePresence`。
