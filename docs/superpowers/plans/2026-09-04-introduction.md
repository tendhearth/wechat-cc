# 介绍(Introduction)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 朋友的伙伴替我把心愿转问给它的朋友(hop 2),回声原路回来只显示「A 的朋友」;我想认识、对方主人点头,介绍人交叉转发两张配对名片,双方直接成为朋友。

**Architecture:** 不建新子系统。转问 = `wish` 信封加 `hop: 2` + 预算(复用 `forward-budget.ts`)+ 介绍人侧一份小索引 `companion/introductions.json`;回声 = `postcard` 加 `hop: 2` + 介绍人生成的 `replyId`;牵线 = 新 kind `intro` 五个 stage(request / forward / accept / decline / card),最后一步双方各自调 `adoptPeerCard`(从 `pairing.ts` 抽出来的「写注册表 + 开信道」原语,和 6 位码配对同一动作)。唯一的人工门在被介绍那一方的主人手里。匿名层不重建。

**Tech Stack:** TypeScript + Bun + Vitest(`bun --bun vitest run <file>`),现有信封 / 信道 / 注册表 / 配对原语,桌面纯 JS。

**Spec:** `docs/superpowers/specs/2026-09-04-introduction-design.md`

## Global Constraints

- **不加任何 `/a2a/*` 路由**,不建表;新交互 = correspondent `switch (env.kind)` 里一个 `case 'intro'`。主人侧接口在 `/v1/social/intro/*`,tier **trusted**。
- **常量**:`FORWARD_PER_SENDER = 3`、`FORWARD_WINDOW_MS = 24h`(转问预算,按来源信道);`INTRO_INDEX_TTL_MS = 14d`(forwards / replies);`INTRO_PENDING_TTL_MS = 7d`(pending / offers,过期 = 拒绝);hop 只允许 `1 | 2`,B 收到 hop 2 **永不再转**。
- **转问前先判官,判「不能」才转**(常量 `FORWARD_ONLY_WHEN_UNABLE = true`)。
- **身份边界**:B 点头前只看到 `hint`(心愿脱敏文本前 40 字)和「A 的朋友」;我点头前只看到明信片文字和「A 的朋友」;名片只在 `card` 阶段经 A 交叉;私钥永远不出机器。
- **两边主人各一句话**的不变量延续到介绍(文案见 spec §6,逐字用);**所有失败只记日志**;后台模型工作持 busy token。
- **JSON 状态文件读一律 `readJsonFile`**(仓库守卫);写照 `neighbor-memory.ts`。
- **每个任务提交前**跑该任务列出的测试 + `bun run typecheck`,大改动跑全量;**报告前 `git status --short` 必须为空**(上一轮的教训)。提交信息中文一句话说清楚为什么,trailer 照会话给的。

---

### Task 1: `wish.ts` 扩展 —— hop、replyId、明信片引用

**Files:**
- Modify: `src/core/wish.ts`
- Test: `src/core/wish.test.ts`

**Interfaces:**
- Produces:

```ts
export type Hop = 1 | 2
export interface WishPayload { id: string; text: string; expiresAt: string; hop: Hop }
export interface PostcardPayload { wishId: string; text: string; hop: Hop; replyId?: string }
/** hop 2 明信片在发心愿这一边留下的引用:靠 replyId 说「我想认识这一位」,不暴露对方身份。 */
export interface PostcardRef {
  replyId: string
  via: string            // 介绍人那条信道 id
  at: string
  preview: string        // 明信片文字前 40 字
  myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string }
}
WishRecord.postcards?: PostcardRef[]
export function wishEnvelope(w: WishRecord, hop?: Hop): Envelope<WishPayload>        // 默认 1
export function forwardedWishEnvelope(p: WishPayload): Envelope<WishPayload>          // 同 id/text/expiresAt,hop 2
export function postcardEnvelope(wishId: string, text: string, opts?: { hop?: Hop; replyId?: string }): Envelope<PostcardPayload>
export function parseWishPayload(env): WishPayload | null     // hop 缺省 1;不是 1|2 → null
export function parsePostcardPayload(env): PostcardPayload | null   // hop 缺省 1;hop 2 必须带非空 replyId,否则 null
export function recordPostcardRef(list, wishId: string, ref: PostcardRef): WishRecord[]      // 同 replyId 幂等(不重复追加)
export function findPostcardRef(list, ref: string): { ok: true; wishId: string; ref: PostcardRef } | { ok: false; reason: 'not_found' | 'ambiguous' }   // replyId 前缀匹配,空串 → not_found
export function attachMyIntro(list, replyId: string, myIntro: NonNullable<PostcardRef['myIntro']>): WishRecord[]
export function clearMyIntro(list, replyId: string): WishRecord[]
```

- [ ] **Step 1: 写失败测试**

`src/core/wish.test.ts` 末尾追加:

```ts
describe('hop / replyId / 明信片引用(介绍)', () => {
  const open = (): WishRecord => mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
  it('wishEnvelope 默认 hop 1;forwardedWishEnvelope 原样带 id/text/expiresAt 且 hop 2', () => {
    const w = open()
    expect(parseWishPayload(wishEnvelope(w))).toEqual({ id: 'abcd1234', text: '找周末爬山搭子', expiresAt: '2026-09-11T10:00:00.000Z', hop: 1 })
    const p1 = parseWishPayload(wishEnvelope(w))!
    expect(parseWishPayload(forwardedWishEnvelope(p1))).toEqual({ ...p1, hop: 2 })
  })
  it('parseWishPayload:hop 缺省 1;3 / "2" / -1 → null', () => {
    const base = { id: 'a', text: 't', expiresAt: T0 }
    expect(parseWishPayload({ kind: 'wish', payload: base })!.hop).toBe(1)
    expect(parseWishPayload({ kind: 'wish', payload: { ...base, hop: 2 } })!.hop).toBe(2)
    for (const hop of [3, '2', -1, 0]) expect(parseWishPayload({ kind: 'wish', payload: { ...base, hop } })).toBe(null)
  })
  it('postcardEnvelope 可带 hop 2 + replyId;hop 2 缺 replyId → null', () => {
    expect(parsePostcardPayload(postcardEnvelope('w1', 'hi'))).toEqual({ wishId: 'w1', text: 'hi', hop: 1 })
    expect(parsePostcardPayload(postcardEnvelope('w1', 'hi', { hop: 2, replyId: 'r1' }))).toEqual({ wishId: 'w1', text: 'hi', hop: 2, replyId: 'r1' })
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'w1', text: 'hi', hop: 2 } })).toBe(null)
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'w1', text: 'hi', hop: 2, replyId: '' } })).toBe(null)
  })
  it('recordPostcardRef 幂等;findPostcardRef 前缀匹配、限定有 via 的;attach/clearMyIntro', () => {
    const ref = { replyId: 'r1r1r1r1', via: 'chA', at: T0, preview: '我朋友常去' }
    let list = recordPostcardRef([open()], 'abcd1234', ref)
    list = recordPostcardRef(list, 'abcd1234', ref)
    expect(list[0]!.postcards).toEqual([ref])
    expect(findPostcardRef(list, 'r1r1')).toEqual({ ok: true, wishId: 'abcd1234', ref })
    expect(findPostcardRef(list, 'zz')).toEqual({ ok: false, reason: 'not_found' })
    expect(findPostcardRef(list, '')).toEqual({ ok: false, reason: 'not_found' })
    list = recordPostcardRef(list, 'abcd1234', { ...ref, replyId: 'r1r1zzzz' })
    expect(findPostcardRef(list, 'r1r1')).toEqual({ ok: false, reason: 'ambiguous' })
    const mine = { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'B', at: T0 }
    list = attachMyIntro(list, 'r1r1r1r1', mine)
    expect(findPostcardRef(list, 'r1r1r1r1')).toMatchObject({ ok: true, ref: { myIntro: mine } })
    list = clearMyIntro(list, 'r1r1r1r1')
    expect(findPostcardRef(list, 'r1r1r1r1')).toMatchObject({ ok: true, ref: { replyId: 'r1r1r1r1' } })
    expect((findPostcardRef(list, 'r1r1r1r1') as { ref: PostcardRef }).ref.myIntro).toBeUndefined()
  })
})
```

import 行补上 `forwardedWishEnvelope, recordPostcardRef, findPostcardRef, attachMyIntro, clearMyIntro, type PostcardRef`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/wish.test.ts -t 介绍`
Expected: FAIL(导出不存在)

- [ ] **Step 3: 实现**

`src/core/wish.ts`:

```ts
export type Hop = 1 | 2
export interface WishPayload { id: string; text: string; expiresAt: string; hop: Hop }
export interface PostcardPayload { wishId: string; text: string; hop: Hop; replyId?: string }
export interface PostcardRef {
  replyId: string
  via: string
  at: string
  preview: string
  myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string }
}
// WishRecord 加一行:
//   /** hop 2 的明信片留下的引用(介绍用);hop 1 的不记 —— 那些人本来就认识。 */
//   postcards?: PostcardRef[]

const parseHop = (v: unknown): Hop | null => (v === undefined ? 1 : v === 1 || v === 2 ? v : null)

export function wishEnvelope(w: WishRecord, hop: Hop = 1): Envelope<WishPayload> {
  return { kind: 'wish', payload: { id: w.id, text: w.redacted, expiresAt: w.expiresAt ?? '', hop } }
}

/** 介绍人转问:同一条心愿(id / text / expiresAt 原样),只把 hop 记成 2。 */
export function forwardedWishEnvelope(p: WishPayload): Envelope<WishPayload> {
  return { kind: 'wish', payload: { id: p.id, text: p.text, expiresAt: p.expiresAt, hop: 2 } }
}

export function parseWishPayload(env: Envelope): WishPayload | null {
  if (env.kind !== 'wish') return null
  const p = env.payload as Partial<WishPayload> | null
  if (!p || typeof p.id !== 'string' || typeof p.text !== 'string' || typeof p.expiresAt !== 'string') return null
  if (p.id === '' || p.text.trim() === '' || Number.isNaN(Date.parse(p.expiresAt))) return null
  if (p.text.trim().length > WISH_TEXT_MAX) return null
  const hop = parseHop((p as { hop?: unknown }).hop)
  if (hop === null) return null
  return { id: p.id, text: p.text.trim(), expiresAt: p.expiresAt, hop }
}

export function postcardEnvelope(wishId: string, text: string, opts: { hop?: Hop; replyId?: string } = {}): Envelope<PostcardPayload> {
  const hop = opts.hop ?? 1
  return { kind: 'postcard', payload: { wishId, text: text.trim(), hop, ...(opts.replyId ? { replyId: opts.replyId } : {}) } }
}

export function parsePostcardPayload(env: Envelope): PostcardPayload | null {
  if (env.kind !== 'postcard') return null
  const p = env.payload as Partial<PostcardPayload> | null
  if (!p || typeof p.wishId !== 'string' || typeof p.text !== 'string' || p.wishId === '' || p.text.trim() === '') return null
  if (p.text.trim().length > WISH_TEXT_MAX) return null
  const hop = parseHop((p as { hop?: unknown }).hop)
  if (hop === null) return null
  const replyId = typeof p.replyId === 'string' && p.replyId !== '' ? p.replyId : undefined
  if (hop === 2 && !replyId) return null   // hop 2 一定是介绍人转回来的,没有 replyId 就没法「认识」
  return { wishId: p.wishId, text: p.text.trim(), hop, ...(replyId ? { replyId } : {}) }
}

const withRefs = (w: WishRecord, refs: PostcardRef[]): WishRecord => ({ ...w, postcards: refs })

export function recordPostcardRef(list: readonly WishRecord[], wishId: string, ref: PostcardRef): WishRecord[] {
  return list.map(w => {
    if (w.id !== wishId) return w
    const refs = w.postcards ?? []
    return refs.some(r => r.replyId === ref.replyId) ? w : withRefs(w, [...refs, ref])
  })
}

export function findPostcardRef(list: readonly WishRecord[], ref: string):
  { ok: true; wishId: string; ref: PostcardRef } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  const q = ref.trim().toLowerCase()
  if (q === '') return { ok: false, reason: 'not_found' }
  const hits: Array<{ wishId: string; ref: PostcardRef }> = []
  for (const w of list) for (const r of w.postcards ?? []) if (r.replyId.startsWith(q)) hits.push({ wishId: w.id, ref: r })
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, ...hits[0]! }
}

export function attachMyIntro(list: readonly WishRecord[], replyId: string, myIntro: NonNullable<PostcardRef['myIntro']>): WishRecord[] {
  return list.map(w => (w.postcards?.some(r => r.replyId === replyId)
    ? withRefs(w, w.postcards!.map(r => (r.replyId === replyId ? { ...r, myIntro } : r)))
    : w))
}

export function clearMyIntro(list: readonly WishRecord[], replyId: string): WishRecord[] {
  return list.map(w => (w.postcards?.some(r => r.replyId === replyId)
    ? withRefs(w, w.postcards!.map(r => { if (r.replyId !== replyId) return r; const { myIntro: _m, ...rest } = r; return rest }))
    : w))
}
```

- [ ] **Step 4: 跑测试**

Run: `bun --bun vitest run src/core/wish.test.ts src/daemon/bootstrap/wire-wish.test.ts && bun run typecheck`
Expected: PASS(现有 wire-wish 测试因 `hop: 1` 默认值不变而照常绿;若某个 `toEqual` 精确比对了 payload,给它加 `hop: 1`)。

- [ ] **Step 5: 提交**

```bash
git add src/core/wish.ts src/core/wish.test.ts src/daemon/bootstrap/wire-wish.test.ts
git commit -m "wish.ts:心愿 / 明信片载荷加 hop(封顶 2)与 replyId,发心愿那边记 hop 2 明信片的引用 —— 介绍的地基"
```

---

### Task 2: `intro.ts` 纯函数 —— 载荷、索引、预算常量

**Files:**
- Create: `src/core/intro.ts`
- Test: `src/core/intro.test.ts`

**Interfaces:**
- Consumes: `PairCard` 与 `isValidPairCard`(Task 4 会导出;本任务先用结构校验的本地副本,Task 4 再切到导出的那一个 —— 见 Step 3 注释)。
- Produces:

```ts
export type IntroStage = 'request' | 'forward' | 'accept' | 'decline' | 'card'
export interface IntroPayload { stage: IntroStage; replyId: string; wishId: string; card?: PairCard; hint?: string }
export function introEnvelope(p: IntroPayload): Envelope<IntroPayload>
export function parseIntroPayload(env: Envelope): IntroPayload | null
//   request / accept / card 必须带 card(且 isValidPairCard);forward 必须带非空 hint(≤ 80 字);decline 两者都不要
export function newReplyId(): string    // 8 hex
export const FORWARD_PER_SENDER = 3
export const FORWARD_WINDOW_MS = 24 * 60 * 60_000
export const FORWARD_ONLY_WHEN_UNABLE = true
export const INTRO_INDEX_TTL_MS = 14 * 24 * 60 * 60_000
export const INTRO_PENDING_TTL_MS = 7 * 24 * 60 * 60_000
export const HINT_MAX = 40
export interface IntroIndex {
  /** 介绍人:我把哪条心愿转给了谁(from = 来源信道)。 */
  forwards: Record<string, { from: string; to: string[]; preview: string; at: string }>
  /** 介绍人:哪张明信片(replyId)来自哪条信道。 */
  replies: Record<string, { wishId: string; fromChannel: string; at: string }>
  /** 介绍人:收了发心愿方的名片、等 B 点头。 */
  pending: Record<string, { wishId: string; requesterChannel: string; requesterCard: PairCard; targetChannel: string; at: string }>
  /** 被介绍方:等我主人点头的邀约。 */
  offers: Record<string, { wishId: string; viaChannel: string; hint: string; at: string; myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string } }>
}
export function emptyIntroIndex(): IntroIndex
/** 清过期项;返回新索引 + 被清掉的 pending(介绍人要替它们发 decline)。 */
export function pruneIntroIndex(idx: IntroIndex, nowMs: number): { index: IntroIndex; expiredPending: Array<{ replyId: string; requesterChannel: string }> }
export function resolveIntroRef(keys: readonly string[], ref: string): { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' }
```

- [ ] **Step 1: 写失败测试**

`src/core/intro.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  introEnvelope, parseIntroPayload, newReplyId, emptyIntroIndex, pruneIntroIndex, resolveIntroRef,
  INTRO_INDEX_TTL_MS, INTRO_PENDING_TTL_MS, HINT_MAX, type IntroIndex,
} from './intro'

const T0 = '2026-09-04T10:00:00.000Z'
const card = { v: 2 as const, role: 'initiator' as const, nonce: 'n', self_id: 'cc-bbbb0001', name: 'B', mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'], bearer: 'k'.repeat(16), channel_id: 'cid', channel_pub: 'PUB' }

describe('intro 载荷', () => {
  it('五个 stage 往返;request/accept/card 必须带合法名片;forward 必须带 hint;decline 都不带', () => {
    const rq = parseIntroPayload(introEnvelope({ stage: 'request', replyId: 'r1', wishId: 'w1', card }))
    expect(rq).toMatchObject({ stage: 'request', replyId: 'r1', wishId: 'w1', card: { self_id: 'cc-bbbb0001' } })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'request', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'accept', replyId: 'r1', wishId: 'w1', card: { ...card, mailbox_addr: '' } } })).toBe(null)
    expect(parseIntroPayload(introEnvelope({ stage: 'forward', replyId: 'r1', wishId: 'w1', hint: '找爬山搭子' }))).toMatchObject({ stage: 'forward', hint: '找爬山搭子' })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'forward', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'forward', replyId: 'r1', wishId: 'w1', hint: 'x'.repeat(HINT_MAX * 2 + 1) } })).toBe(null)
    expect(parseIntroPayload(introEnvelope({ stage: 'decline', replyId: 'r1', wishId: 'w1' }))).toEqual({ stage: 'decline', replyId: 'r1', wishId: 'w1' })
    expect(parseIntroPayload({ kind: 'intro', payload: { stage: 'nope', replyId: 'r1', wishId: 'w1' } })).toBe(null)
    expect(parseIntroPayload({ kind: 'wish', payload: {} })).toBe(null)
  })
  it('newReplyId 8 位 hex', () => { expect(newReplyId()).toMatch(/^[0-9a-f]{8}$/) })
})

describe('intro 索引', () => {
  const at = (msAgo: number) => new Date(Date.parse(T0) - msAgo).toISOString()
  it('pruneIntroIndex:forwards/replies 14 天,pending/offers 7 天;过期的 pending 报出来给介绍人发 decline', () => {
    const idx: IntroIndex = {
      forwards: { w1: { from: 'c0', to: ['c1'], preview: 'p', at: at(INTRO_INDEX_TTL_MS + 1) }, w2: { from: 'c0', to: ['c1'], preview: 'p', at: at(1000) } },
      replies: { r1: { wishId: 'w1', fromChannel: 'c1', at: at(INTRO_INDEX_TTL_MS + 1) }, r2: { wishId: 'w2', fromChannel: 'c1', at: at(1000) } },
      pending: { r1: { wishId: 'w1', requesterChannel: 'c0', requesterCard: card, targetChannel: 'c1', at: at(INTRO_PENDING_TTL_MS + 1) }, r2: { wishId: 'w2', requesterChannel: 'c0', requesterCard: card, targetChannel: 'c1', at: at(1000) } },
      offers: { o1: { wishId: 'w1', viaChannel: 'c9', hint: 'h', at: at(INTRO_PENDING_TTL_MS + 1) }, o2: { wishId: 'w2', viaChannel: 'c9', hint: 'h', at: at(1000) } },
    }
    const r = pruneIntroIndex(idx, Date.parse(T0))
    expect(Object.keys(r.index.forwards)).toEqual(['w2'])
    expect(Object.keys(r.index.replies)).toEqual(['r2'])
    expect(Object.keys(r.index.pending)).toEqual(['r2'])
    expect(Object.keys(r.index.offers)).toEqual(['o2'])
    expect(r.expiredPending).toEqual([{ replyId: 'r1', requesterChannel: 'c0' }])
  })
  it('emptyIntroIndex 四张空表;resolveIntroRef 前缀匹配', () => {
    expect(emptyIntroIndex()).toEqual({ forwards: {}, replies: {}, pending: {}, offers: {} })
    expect(resolveIntroRef(['abcd1111', 'abcd2222', 'ffff0000'], 'ff')).toEqual({ ok: true, id: 'ffff0000' })
    expect(resolveIntroRef(['abcd1111', 'abcd2222'], 'abcd')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveIntroRef(['abcd1111'], '')).toEqual({ ok: false, reason: 'not_found' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/intro.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: 实现**

`src/core/intro.ts`:

```ts
/**
 * intro.ts — 「介绍」的纯函数部分(spec 2026-09-04-introduction-design)。
 *
 * 介绍 = 心愿的转问 + 配对的名片交换,中间隔着一个人点头。这里只定义:
 * intro 信封长什么样、介绍人 / 被介绍方各自记什么、什么时候过期。传输和
 * 存储都不在这里。
 *
 * 五个 stage 走向:
 *   request(我 → A,带我的名片)→ forward(A → B,只带一句 hint)
 *   → accept(B → A,带 B 的名片)/ decline(B → A)
 *   → card(A → 我 / A → B,交叉转发对方名片)
 */
import { randomBytes } from 'node:crypto'
import type { Envelope } from './envelope'
import { isValidPairCard, type PairCard } from './pairing'

export type IntroStage = 'request' | 'forward' | 'accept' | 'decline' | 'card'
export interface IntroPayload { stage: IntroStage; replyId: string; wishId: string; card?: PairCard; hint?: string }

export const FORWARD_PER_SENDER = 3
export const FORWARD_WINDOW_MS = 24 * 60 * 60_000
/** 判「不能」才转问。改成 false 就是「一律转」(热心朋友模式)。 */
export const FORWARD_ONLY_WHEN_UNABLE = true
export const INTRO_INDEX_TTL_MS = 14 * 24 * 60 * 60_000
export const INTRO_PENDING_TTL_MS = 7 * 24 * 60 * 60_000
export const HINT_MAX = 40

const STAGES: ReadonlySet<string> = new Set<IntroStage>(['request', 'forward', 'accept', 'decline', 'card'])
const NEEDS_CARD: ReadonlySet<IntroStage> = new Set(['request', 'accept', 'card'])

export function newReplyId(): string { return randomBytes(4).toString('hex') }

export function introEnvelope(p: IntroPayload): Envelope<IntroPayload> {
  return { kind: 'intro', payload: { stage: p.stage, replyId: p.replyId, wishId: p.wishId, ...(p.card ? { card: p.card } : {}), ...(p.hint ? { hint: p.hint.slice(0, HINT_MAX) } : {}) } }
}

export function parseIntroPayload(env: Envelope): IntroPayload | null {
  if (env.kind !== 'intro') return null
  const p = env.payload as Partial<IntroPayload> | null
  if (!p || typeof p.stage !== 'string' || !STAGES.has(p.stage)) return null
  if (typeof p.replyId !== 'string' || p.replyId === '' || typeof p.wishId !== 'string' || p.wishId === '') return null
  const stage = p.stage as IntroStage
  if (NEEDS_CARD.has(stage)) {
    if (!p.card || !isValidPairCard(p.card)) return null
    return { stage, replyId: p.replyId, wishId: p.wishId, card: p.card }
  }
  if (stage === 'forward') {
    if (typeof p.hint !== 'string' || p.hint.trim() === '' || p.hint.length > HINT_MAX * 2) return null
    return { stage, replyId: p.replyId, wishId: p.wishId, hint: p.hint.trim().slice(0, HINT_MAX) }
  }
  return { stage, replyId: p.replyId, wishId: p.wishId }
}

export interface IntroIndex {
  forwards: Record<string, { from: string; to: string[]; preview: string; at: string }>
  replies: Record<string, { wishId: string; fromChannel: string; at: string }>
  pending: Record<string, { wishId: string; requesterChannel: string; requesterCard: PairCard; targetChannel: string; at: string }>
  offers: Record<string, { wishId: string; viaChannel: string; hint: string; at: string; myIntro?: { channelId: string; pubkey: string; privkey: string; bearer: string; at: string } }>
}

export function emptyIntroIndex(): IntroIndex { return { forwards: {}, replies: {}, pending: {}, offers: {} } }

function keep<T extends { at: string }>(rec: Record<string, T>, nowMs: number, ttl: number): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(rec)) { const t = Date.parse(v.at); if (!Number.isNaN(t) && nowMs - t <= ttl) out[k] = v }
  return out
}

export function pruneIntroIndex(idx: IntroIndex, nowMs: number): { index: IntroIndex; expiredPending: Array<{ replyId: string; requesterChannel: string }> } {
  const pending = keep(idx.pending, nowMs, INTRO_PENDING_TTL_MS)
  const expiredPending = Object.entries(idx.pending).filter(([k]) => !(k in pending)).map(([replyId, v]) => ({ replyId, requesterChannel: v.requesterChannel }))
  return {
    index: { forwards: keep(idx.forwards, nowMs, INTRO_INDEX_TTL_MS), replies: keep(idx.replies, nowMs, INTRO_INDEX_TTL_MS), pending, offers: keep(idx.offers, nowMs, INTRO_PENDING_TTL_MS) },
    expiredPending,
  }
}

export function resolveIntroRef(keys: readonly string[], ref: string): { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  const q = ref.trim().toLowerCase()
  if (q === '') return { ok: false, reason: 'not_found' }
  const hits = keys.filter(k => k.startsWith(q))
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, id: hits[0]! }
}
```

**`isValidPairCard` 还不存在**(Task 4 导出)。本任务先在 `src/core/pairing.ts` 加一个最小导出(不改 `makePairing`):

```ts
/** 结构校验(v2 名片):Task 4 会让 makePairing 内部的 cardProblem 复用它。 */
export function isValidPairCard(card: unknown): card is PairCard {
  if (!card || typeof card !== 'object') return false
  const c = card as Record<string, unknown>
  const s = (k: string) => typeof c[k] === 'string' && (c[k] as string).length > 0
  return c.v === 2 && (c.role === 'initiator' || c.role === 'acceptor')
    && s('nonce') && s('self_id') && /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.self_id as string) && s('name') && s('bearer')
    && s('mailbox_addr') && s('mailbox_enc_pub') && Array.isArray(c.relays) && (c.relays as unknown[]).length > 0
    && s('channel_id') && s('channel_pub')
}
```

- [ ] **Step 4: 跑测试**

Run: `bun --bun vitest run src/core/intro.test.ts src/core/pairing.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/intro.ts src/core/intro.test.ts src/core/pairing.ts
git commit -m "intro.ts:介绍的信封五个 stage、介绍人 / 被介绍方的小索引与过期规则 —— 纯函数,不碰传输"
```

---

### Task 3: `intro-memory.ts` —— `introductions.json` 存取

**Files:**
- Create: `src/daemon/companion/intro-memory.ts`
- Test: `src/daemon/companion/intro-memory.test.ts`

**Interfaces:**
- Produces:
  - `readIntroIndex(stateDir): IntroIndex`(缺 / 坏 / 形状不对 → `emptyIntroIndex()`;四张表缺哪张补哪张)
  - `writeIntroIndex(stateDir, idx): void`(`<stateDir>/companion/introductions.json`)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIntroIndex, writeIntroIndex } from './intro-memory'
import { emptyIntroIndex } from '../../core/intro'

const dir = () => mkdtempSync(join(tmpdir(), 'intromem-'))
describe('introductions.json', () => {
  it('没文件 → 空索引;写了读回;坏文件 → 空;缺表补齐;容忍 BOM', () => {
    const d = dir()
    expect(readIntroIndex(d)).toEqual(emptyIntroIndex())
    const idx = { ...emptyIntroIndex(), replies: { r1: { wishId: 'w', fromChannel: 'c', at: '2026-09-04T10:00:00.000Z' } } }
    writeIntroIndex(d, idx)
    expect(readIntroIndex(d)).toEqual(idx)
    writeFileSync(join(d, 'companion', 'introductions.json'), '{nope')
    expect(readIntroIndex(d)).toEqual(emptyIntroIndex())
    writeFileSync(join(d, 'companion', 'introductions.json'), '﻿' + JSON.stringify({ forwards: { w: { from: 'a', to: [], preview: '', at: 'x' } } }))
    expect(readIntroIndex(d)).toEqual({ ...emptyIntroIndex(), forwards: { w: { from: 'a', to: [], preview: '', at: 'x' } } })
    const d2 = dir(); mkdirSync(join(d2, 'companion'), { recursive: true })
    writeFileSync(join(d2, 'companion', 'introductions.json'), JSON.stringify({ forwards: 'bad' }))
    expect(readIntroIndex(d2)).toEqual(emptyIntroIndex())
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `bun --bun vitest run src/daemon/companion/intro-memory.test.ts` → cannot find module

- [ ] **Step 3: 实现**

```ts
/** intro-memory.ts — introductions.json 的读写(spec 2026-09-04-introduction §1/§3)。照 wish-memory.ts。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { emptyIntroIndex, type IntroIndex } from '../../core/intro'

const file = (stateDir: string) => join(stateDir, 'companion', 'introductions.json')
const isRec = (v: unknown): v is Record<string, never> => !!v && typeof v === 'object' && !Array.isArray(v)

export function readIntroIndex(stateDir: string): IntroIndex {
  try {
    const raw = readJsonFile<Partial<Record<keyof IntroIndex, unknown>>>(file(stateDir))
    const e = emptyIntroIndex()
    return {
      forwards: isRec(raw.forwards) ? raw.forwards as IntroIndex['forwards'] : e.forwards,
      replies: isRec(raw.replies) ? raw.replies as IntroIndex['replies'] : e.replies,
      pending: isRec(raw.pending) ? raw.pending as IntroIndex['pending'] : e.pending,
      offers: isRec(raw.offers) ? raw.offers as IntroIndex['offers'] : e.offers,
    }
  } catch { return emptyIntroIndex() }
}

export function writeIntroIndex(stateDir: string, idx: IntroIndex): void {
  const dir = join(stateDir, 'companion')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file(stateDir), JSON.stringify(idx, null, 2))
}
```

- [ ] **Step 4: 跑测试** — `bun --bun vitest run src/daemon/companion/intro-memory.test.ts src/lib/read-json-file.test.ts && bun run typecheck` → PASS
- [ ] **Step 5: 提交** — `git add src/daemon/companion/intro-memory.ts src/daemon/companion/intro-memory.test.ts && git commit -m "introductions.json 存取 —— 介绍人索引与待点头邀约,照 wishes.json 的做法"`

---

### Task 4: 从 `pairing.ts` 抽出 `buildOwnCard` / `adoptPeerCard`

**Files:**
- Modify: `src/core/pairing.ts`(抽出两个导出原语;`makePairing` 内部改为调用;`cardProblem` 复用 `isValidPairCard`)
- Test: `src/core/pairing.test.ts`(追加 describe)

**Interfaces:**
- Produces:

```ts
export interface CardDeps { selfId: () => string; name: () => string; url?: () => string | undefined; self: { mailbox_addr: string; mailbox_enc_pub: string; relays: string[] } }
export function buildOwnCard(deps: CardDeps, role: PairCard['role'], nonce: string, bearer: string, chan: { channelId: string; pubkey: string }): PairCard
export interface AdoptDeps { registry: A2ARegistry; channelStore: Pick<ChannelStore, 'create' | 'setPeerHandle' | 'setStatus' | 'list' | 'get'>; log?: (msg: string) => void }
/**
 * 采纳一张对方的名片 = 写注册表(transport mailbox,bearer 交叉)+ 开/补 `<rowPrefix>:<nonce>` 的 open 信道。
 * 配对码和介绍共用。id_conflict 时什么都不写。开信道的三步不原子:内部 try/catch,失败只 log,返回仍是 ok(注册表已写成)。
 */
export function adoptPeerCard(deps: AdoptDeps, card: PairCard, mine: { channelId: string; pubkey: string; privkey: string }, myMintedKey: string, nonce: string, rowPrefix: 'pair' | 'intro'): { ok: true; rowId: string; channelOpened: boolean } | { ok: false; reason: 'id_conflict' }
```

- [ ] **Step 1: 写失败测试**

`src/core/pairing.test.ts` 末尾追加(`makeFakeRegistry` / `makeFakeChannelStore` 已在文件里):

```ts
describe('adoptPeerCard / buildOwnCard —— 配对码和介绍共用的原语', () => {
  const card = { v: 2 as const, role: 'acceptor' as const, nonce: 'nn', self_id: 'cc-peer00001', name: 'Peer', mailbox_addr: 'MP', mailbox_enc_pub: 'EP', relays: ['https://r/mailbox'], bearer: 'p'.repeat(16), channel_id: 'pc', channel_pub: 'PPUB' }
  const mine = { channelId: 'mc', pubkey: 'MPUB', privkey: 'MPRIV' }
  it('intro 前缀:写注册表 + 开 intro:<nonce> 的 open 行,句柄是对方的', () => {
    const registry = makeFakeRegistry(); const chan = makeFakeChannelStore()
    const r = adoptPeerCard({ registry, channelStore: chan }, card, mine, 'k'.repeat(16), 'reply777', 'intro')
    expect(r).toEqual({ ok: true, rowId: 'intro:reply777', channelOpened: true })
    expect(registry.get('cc-peer00001')).toMatchObject({ transport: 'mailbox', outbound_api_key: 'p'.repeat(16), inbound_api_key: 'k'.repeat(16), may_exec: false })
    expect(chan.rows[0]).toMatchObject({ id: 'intro:reply777', peerAgentId: 'cc-peer00001', status: 'open', myChannelId: 'mc' })
    expect(chan.rows[0]!.peer).toMatchObject({ channel_id: 'pc', pubkey: 'PPUB', mailbox: { addr: 'MP' } })
  })
  it('id_conflict(同 id 不同信箱)→ 不写任何东西', () => {
    const registry = makeFakeRegistry(); const chan = makeFakeChannelStore()
    registry.records.set('cc-peer00001', { id: 'cc-peer00001', mailbox_addr: 'OTHER' } as never)
    expect(adoptPeerCard({ registry, channelStore: chan }, card, mine, 'k', 'n', 'intro')).toEqual({ ok: false, reason: 'id_conflict' })
    expect(chan.rows).toHaveLength(0)
  })
  it('信道开失败 → 注册表仍写成,返回 channelOpened:false 并 log', () => {
    const registry = makeFakeRegistry(); const chan = makeFakeChannelStore(); const logs: string[] = []
    chan.setStatus = () => { throw new Error('disk full') }
    const r = adoptPeerCard({ registry, channelStore: chan, log: (m) => logs.push(m) }, card, mine, 'k', 'n', 'pair')
    expect(r).toMatchObject({ ok: true, channelOpened: false })
    expect(registry.get('cc-peer00001')).not.toBe(null)
    expect(logs.join('\n')).toContain('channel open failed')
  })
  it('buildOwnCard:v2、带信道字段、不带不可达 url', () => {
    const c = buildOwnCard({ selfId: () => 'cc-me00000001', name: () => 'Me', url: () => 'http://127.0.0.1:1', self: { mailbox_addr: 'MM', mailbox_enc_pub: 'EM', relays: ['https://r/mailbox'] } }, 'initiator', 'n1', 'b'.repeat(16), { channelId: 'c1', pubkey: 'P1' })
    expect(c).toMatchObject({ v: 2, role: 'initiator', nonce: 'n1', self_id: 'cc-me00000001', channel_id: 'c1', channel_pub: 'P1', bearer: 'b'.repeat(16) })
    expect(c.url).toBeUndefined()
  })
})
```

import 行加 `adoptPeerCard, buildOwnCard`。

- [ ] **Step 2: 跑测试确认失败** — `bun --bun vitest run src/core/pairing.test.ts -t adoptPeerCard` → 导出不存在

- [ ] **Step 3: 实现**

在 `pairing.ts` 模块级(`makePairing` 之前)加 `CardDeps` / `AdoptDeps` / `buildOwnCard` / `adoptPeerCard`:`buildOwnCard` 的函数体 = 现有 `ownCard` 闭包的函数体(把 `deps.url?.()` 等改读参数 `deps`);`adoptPeerCard` 的函数体 = 现有 `writePeerFromCard` + `openPairChannel` 两段串起来(`rowId = \`${rowPrefix}:${nonce}\``,open 三步包 `try { … channelOpened = true } catch (e) { deps.log?.(\`${rowPrefix}: registry written but channel open failed for ${card.self_id}: ${String(e)}\`) }`)。然后 `makePairing` 内部:`ownCard(...)` → `buildOwnCard(deps, ...)`;`tick()` 和 `accept()` 里的 `writePeerFromCard` + `openPairChannel` 两步 → 一次 `adoptPeerCard(deps, card, mine, myKey, nonce, 'pair')`(它们外面原有的 try/catch 和通知逻辑保留:`ok:false` → `ID_CONFLICT_MSG`,`ok:true` → 成功文案)。`cardProblem` 的「别的都对」判断改为调用 `isValidPairCard` 之外只多一个 `v`/信道字段的区分。删掉不再被调用的 `ownCard` / `writePeerFromCard` / `openPairChannel` 闭包;`conflicts()` 保留(accept 的 peek)。

- [ ] **Step 4: 跑测试** — `bun --bun vitest run src/core/pairing.test.ts src/core/pairing.integration.test.ts src/core/intro.test.ts && bun run typecheck` → 全绿(现有配对测试一条都不该改)。
- [ ] **Step 5: 提交** — `git add src/core/pairing.ts src/core/pairing.test.ts && git commit -m "pairing:抽出 buildOwnCard / adoptPeerCard —— 配对码和介绍共用「写注册表 + 开信道」这一个动作"`

---

### Task 5: `wire-wish.ts` —— 转问、回声原路返回、hop 2 明信片

**Files:**
- Modify: `src/daemon/bootstrap/wire-wish.ts`
- Create: `src/daemon/bootstrap/social-trio.fixture.ts`(三方同进程夹具,Task 6 复用)
- Test: `src/daemon/bootstrap/wire-wish.test.ts`(追加 describe)

**Interfaces:**
- Consumes: Task 1 全部;Task 2 常量 + `newReplyId` + `IntroIndex`/`pruneIntroIndex`;Task 3 `readIntroIndex`/`writeIntroIndex`。
- Produces:
  - `WishDeps` 新增:`forwardBudget?: { withinBudget(senderId: string): boolean }`(缺省 = 不转问);`newReplyId?: () => string`。
  - 行为:见下。`WishService` 不变。

**行为(照 spec §1/§2):**

1. `answerWishInner(channelRowId, id, text, expiresAtIso, hop)`:
   - 判「不能」/ blurb 空 / 闸门违规 之后,**若 `hop === 1 && FORWARD_ONLY_WHEN_UNABLE && deps.forwardBudget`**:走 `forwardWish(channelRowId, { id, text, expiresAt, hop: 1 })`,返回 N;`N > 0` 时主人那句改为 「🙋 <label> 的伙伴来打听「<text>」,我答不上,帮着问了 N 个朋友」,否则仍是「…我说不知道」。
   - `forwardWish`:`idx = readIntroIndex`;已有 `idx.forwards[id]` → 0;`!withinBudget(channelRowId)` → log,0;`targets = primaryChannels(list).filter(c => c.id !== channelRowId)`;为空 → 0;逐条 `sendEnvelope(c.id, forwardedWishEnvelope(p))`(失败只 log);`forwards[id] = { from: channelRowId, to: [成功的], preview: text.slice(0, HINT_MAX), at }`;写回(写前 `pruneIntroIndex`)。返回成功数。
   - `handleWish` 把 `p.hop` 与夹过的 `expiresAt` 一起传给 `answerWish`。
2. `handlePostcard` 开头(在 `acceptPostcard` 之前)加**介绍人中继**:`idx = readIntroIndex`;`fwd = idx.forwards[p.wishId]`;若 `fwd && fwd.to.includes(channelRowId) && p.hop === 1`:
   - `markWishSeen(seenKey(\`rl:${p.wishId}\`, channelRowId))` 为 false → log 重复,`return true`;
   - `replyId = newReplyId()`;`idx.replies[replyId] = { wishId, fromChannel: channelRowId, at }`;写回;
   - `sendEnvelope(fwd.from, postcardEnvelope(p.wishId, p.text, { hop: 2, replyId }))`(失败只 log);`log(…中继…)`;`return true`(**不**入日志、**不**打扰主人)。
3. `handlePostcard` 收到 `p.hop === 2`(自己是发心愿的):照常 `acceptPostcard` + 幂等键;`label = \`${peerLabel(channelRowId)} 的朋友\``;`recordPostcardRef(list, wishId, { replyId: p.replyId!, via: channelRowId, at, preview: p.text.slice(0, 40) })` 写回(和 replies++ 同一次写);journal `peerLabel: label`;主人那句尾巴加「(想认识就回「认识 <replyId 前 6 位>」)」。

- [ ] **Step 1: 三方夹具**

`src/daemon/bootstrap/social-trio.fixture.ts`(不是测试文件,给两个测试 import):

```ts
/**
 * 三只伙伴同进程对跑:me ─ A ─ B。A 同时开着两条信道(去 me 的、去 B 的);
 * sendEnvelope 按信道 id 找到对端,直接塞进对端的 onInbound(先 wish 再 intro)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope } from '../../core/envelope'
import { makeWish, type WishDeps, type WishService } from './wire-wish'

export interface Peer {
  name: string; stateDir: string; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  letters: Array<{ dir: 'in' | 'out'; channel: string; kind: string; payload: unknown }>
  wish: WishService
  /** Task 6 挂上去;这里先留空位。 */
  intro?: { onInbound(channelRowId: string, env: Envelope, letterId: string): boolean }
  judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
  clock: { ms: number }
}
/** 信道拓扑:channelId → [持有方, 对端, 对端看这条信道的 id]。 */
export interface Link { id: string; owner: string; peer: string; peerSideId: string }

export interface TrioOpts { budgetOk?: (sender: string) => boolean }

export function makeTrio(opts: TrioOpts = {}): { me: Peer; A: Peer; B: Peer; deliver: (from: Peer, channel: string, env: Envelope) => boolean } {
  const links: Link[] = [
    { id: 'me>A', owner: 'me', peer: 'A', peerSideId: 'A>me' }, { id: 'A>me', owner: 'A', peer: 'me', peerSideId: 'me>A' },
    { id: 'A>B', owner: 'A', peer: 'B', peerSideId: 'B>A' }, { id: 'B>A', owner: 'B', peer: 'A', peerSideId: 'A>B' },
  ]
  const peers = new Map<string, Peer>()
  const clock = { ms: Date.parse('2026-09-04T10:00:00.000Z') }
  const names: Record<string, Record<string, string>> = { me: { 'me>A': '阿A' }, A: { 'A>me': '小我', 'A>B': '阿B' }, B: { 'B>A': '阿A' } }
  const deliver = (from: Peer, channel: string, env: Envelope): boolean => {
    const link = links.find(l => l.id === channel && l.owner === from.name)
    if (!link) return false
    const to = peers.get(link.peer)!
    from.letters.push({ dir: 'out', channel, kind: env.kind, payload: env.payload })
    to.letters.push({ dir: 'in', channel: link.peerSideId, kind: env.kind, payload: env.payload })
    const letterId = `${to.name}-in-${to.letters.length}`
    if (to.wish.onInbound(link.peerSideId, env, letterId)) return true
    if (to.intro?.onInbound(link.peerSideId, env, letterId)) return true
    to.owner.push(`📬 ${env.kind}`)
    return true
  }
  const mk = (name: string): Peer => {
    const p: Peer = { name, stateDir: mkdtempSync(join(tmpdir(), `trio-${name}-`)), owner: [], logs: [], journal: [], letters: [], wish: null as never, judgeSays: { match: 'no' }, clock }
    const mine = links.filter(l => l.owner === name).map(l => ({ id: l.id, status: 'open', degree: 1, peer_agent_id: `cc-${l.peer.toLowerCase()}00000001`, created_at: '2026-09-01T00:00:00.000Z' }))
    const deps: WishDeps = {
      stateDir: p.stateDir,
      channelStore: { get: (id: string) => mine.find(c => c.id === id) ?? null, list: () => mine } as never,
      sendEnvelope: async (c, env) => (deliver(p, c, env) ? { ok: true } : { ok: false, error: 'no_such_channel' }),
      gate: async (t) => ({ ok: true, redacted: t, violations: [] }),
      judge: async () => { if (p.judgeSays instanceof Error) throw p.judgeSays; return p.judgeSays },
      recordPostcard: (a) => { p.journal.push(a); return `row-${p.journal.length}` },
      notifyOwner: (t) => p.owner.push(t),
      peerLabel: (c) => names[name]?.[c] ?? '某人',
      forwardBudget: { withinBudget: (s) => opts.budgetOk?.(s) ?? true },
      now: () => (clock.ms += 1),
      newId: (() => { let n = 0; return () => `${name}${String(++n).padStart(6, '0')}`.toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8) })(),
      newReplyId: (() => { let n = 0; return () => `r${name}${String(++n).padStart(6, '0')}`.toLowerCase().slice(0, 8) })(),
      log: (tag, line) => p.logs.push(`${tag} ${line}`),
    }
    p.wish = makeWish(deps)
    peers.set(name, p)
    return p
  }
  const me = mk('me'), A = mk('A'), B = mk('B')
  return { me, A, B, deliver }
}
export const flush = (): Promise<void> => new Promise(r => setTimeout(r, 30))
```

- [ ] **Step 2: 写失败测试**

`src/daemon/bootstrap/wire-wish.test.ts` 末尾追加:

```ts
import { makeTrio, flush as flush3 } from './social-trio.fixture'

describe('介绍:转问与回声原路返回(spec 2026-09-04-introduction §1/§2)', () => {
  const send = async (me: ReturnType<typeof makeTrio>['me'], text = '找周末爬山搭子') => {
    const p = await me.wish.propose(text); if (!p.ok) throw new Error(p.error)
    const s = await me.wish.send(p.id); if (!s.ok) throw new Error(s.reason)
    return p.id
  }
  it('A 答不上 → 转给 B(hop 2)→ B 答 → A 原路转回(带 replyId,不入 A 日志)→ 我这边 label 是「阿A 的朋友」并记下引用', async () => {
    const { me, A, B } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: '我朋友周末常去' }
    const id = await send(me)
    await flush3()
    expect(A.owner).toEqual([`🙋 小我 的伙伴来打听「找周末爬山搭子」,我答不上,帮着问了 1 个朋友`])
    expect(B.letters.filter(l => l.dir === 'in').map(l => (l.payload as { hop: number }).hop)).toEqual([2])
    expect(B.owner).toEqual([`🙋 阿A 的伙伴来打听「找周末爬山搭子」,我回了:我朋友周末常去`])
    expect(A.journal).toEqual([])
    expect(me.journal).toEqual([{ text: '我朋友周末常去', peerLabel: '阿A 的朋友' }])
    expect(me.owner[0]).toMatch(/^📮 阿A 的朋友 回了你的心愿「找周末爬山搭子」:我朋友周末常去(想认识就回「认识 [0-9a-z]{6}」)$/)
    const refs = me.wish.list().find(w => w.id === id)!.postcards!
    expect(refs).toHaveLength(1); expect(refs[0]).toMatchObject({ via: 'me>A', preview: '我朋友周末常去' })
  })
  it('B 收到 hop 2 后不再转(它自己判不能也只是说不知道)', async () => {
    const { me, A, B } = makeTrio()
    await send(me); await flush3()
    expect(B.owner).toEqual([`🙋 阿A 的伙伴来打听「找周末爬山搭子」,我说不知道`])
    expect(B.letters.filter(l => l.dir === 'out')).toHaveLength(0)
    expect(A.owner[0]).toContain('帮着问了 1 个朋友')
  })
  it('A 自己能答 → 不转', async () => {
    const { me, A, B } = makeTrio()
    A.judgeSays = { match: 'yes', blurb: '我常去' }
    await send(me); await flush3()
    expect(B.letters).toHaveLength(0)
    expect(me.journal).toEqual([{ text: '我常去', peerLabel: '阿A' }])
  })
  it('预算耗尽 → 不转,主人听到的是「我说不知道」', async () => {
    const { me, A, B } = makeTrio({ budgetOk: () => false })
    await send(me); await flush3()
    expect(B.letters).toHaveLength(0)
    expect(A.owner).toEqual([`🙋 小我 的伙伴来打听「找周末爬山搭子」,我说不知道`])
  })
  it('同一条心愿到 A 两次 → 只转一次;B 的明信片到 A 两次 → 只中继一次', async () => {
    const { me, A, B, deliver } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: 'ok' }
    await send(me); await flush3()
    const wishEnv = me.letters.find(l => l.dir === 'out' && l.kind === 'wish')!
    deliver(me, 'me>A', { kind: 'wish', payload: wishEnv.payload }); await flush3()
    expect(B.letters.filter(l => l.dir === 'in' && l.kind === 'wish')).toHaveLength(1)
    const pc = B.letters.find(l => l.dir === 'out' && l.kind === 'postcard')!
    deliver(B, 'B>A', { kind: 'postcard', payload: pc.payload }); await flush3()
    expect(me.letters.filter(l => l.dir === 'in' && l.kind === 'postcard')).toHaveLength(1)
  })
  it('没有 forwardBudget 依赖(老调用方)→ 永不转:用单信道夹具 side() 验证', async () => {
    const S = side('A'); const T = side('B'); S.setPeer(T); T.setPeer(S)
    const p = await S.wish.propose('x'); if (!p.ok) throw new Error(); await S.wish.send(p.id); await flush()
    expect(T.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我说不知道'])
  })
  it('list() 的 postcards 带 viaLabel(桌面要显示「谁的朋友」)', async () => {
    const { me, B } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: 'ok' }
    const id = await send(me); await flush3()
    expect(me.wish.list().find(w => w.id === id)!.postcards![0]).toMatchObject({ via: 'me>A', viaLabel: '阿A' })
  })
})
```

4. `list()`:每条的 `postcards` 映射为 `{ ...ref, viaLabel: deps.peerLabel(ref.via) }`(`WishService.list` 的返回类型相应写成 `Array<WishRecord & { effective: WishStatus | 'expired'; postcards?: Array<PostcardRef & { viaLabel: string }> }>`)。

- [ ] **Step 3: 跑测试确认失败** — `bun --bun vitest run src/daemon/bootstrap/wire-wish.test.ts -t 介绍` → FAIL(夹具 / 行为都没有)
- [ ] **Step 4: 实现**(按上面「行为」1–3;`WishDeps` 加 `forwardBudget?` `newReplyId?`;文件头注释加一段介绍的说明)
- [ ] **Step 5: 跑测试** — `bun --bun vitest run src/daemon/bootstrap/wire-wish.test.ts src/daemon/bootstrap/wire-visit.test.ts && bun run typecheck` → 全绿(旧用例不变)。
- [ ] **Step 6: 提交** — `git add src/daemon/bootstrap/wire-wish.ts src/daemon/bootstrap/wire-wish.test.ts src/daemon/bootstrap/social-trio.fixture.ts && git commit -m "心愿加转问:介绍人答不上就帮着问自己的朋友(hop 2,有预算),回声原路转回只显示「A 的朋友」"`

---

### Task 6: `wire-intro.ts` —— 五个 stage 的牵线状态机

**Files:**
- Create: `src/daemon/bootstrap/wire-intro.ts`
- Test: `src/daemon/bootstrap/wire-intro.test.ts`
- Modify: `src/daemon/bootstrap/social-trio.fixture.ts`(挂 `intro`;提供 registry/channel 假货给 `adopt`)

**Interfaces:**
- Consumes: Task 1 `findPostcardRef / attachMyIntro / clearMyIntro`、`readWishes / writeWishes`;Task 2 `introEnvelope / parseIntroPayload / IntroIndex / pruneIntroIndex / resolveIntroRef / INTRO_*`;Task 3;Task 4 `buildOwnCard / adoptPeerCard`(通过 deps 注入闭包)。
- Produces:

```ts
export interface IntroDeps {
  stateDir: string
  channelStore: Pick<ChannelStore, 'get' | 'list'>
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string }>
  /** 我的名片:wire-social 用 buildOwnCard 包好(role 固定 'initiator' 对 request 方、'acceptor' 对 accept 方,只是字段,不影响逻辑)。 */
  buildCard(role: 'initiator' | 'acceptor', nonce: string, bearer: string, chan: { channelId: string; pubkey: string }): PairCard
  /** 采纳对方名片:wire-social 用 adoptPeerCard(…, 'intro') 包好。 */
  adopt(card: PairCard, mine: { channelId: string; pubkey: string; privkey: string }, myMintedKey: string, nonce: string): { ok: true; channelOpened: boolean } | { ok: false; reason: 'id_conflict' }
  mintKey(): string
  genChannel(): { channelId: string; pubkey: string; privkey: string }
  notifyOwner(text: string): void
  peerLabel(channelRowId: string): string
  holdBusy?: (label: string) => () => void
  now?: () => number
  log(tag: string, line: string): void
}
export interface IntroService {
  /** 我看到「A 的朋友」的明信片,想认识:按 replyId 前缀。 */
  request(replyRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'already_requested' | 'send_failed' }>
  /** 被介绍方主人点头 / 摇头:按 offers 的 replyId 前缀。 */
  accept(offerRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'send_failed' }>
  decline(offerRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'send_failed' }>
  offers(): Array<{ replyId: string; hint: string; viaLabel: string; at: string }>
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean    // kind 'intro' → true
}
export function makeIntro(deps: IntroDeps): IntroService
```

**每个 stage 的处理(全部同步返回 true,`adopt` 与发信封在 `void (async …)().catch(log)` 里,持 busy token `intro`):**

- `request`(我是 A):`idx = readIntroIndex`;`rep = idx.replies[replyId]`、`fwd = idx.forwards[wishId]`;缺一 → log 丢;**`fwd.from !== channelRowId` → log 丢(只有发心愿的那条信道能提这张明信片)**;`rep.wishId !== wishId` → 丢;`pending[replyId] = { wishId, requesterChannel: channelRowId, requesterCard: card, targetChannel: rep.fromChannel, at }` 写回;`sendEnvelope(rep.fromChannel, introEnvelope({ stage: 'forward', replyId, wishId, hint: fwd.preview }))`。
- `forward`(我是 B):`offers[replyId] = { wishId, viaChannel: channelRowId, hint, at }` 写回;`notifyOwner(\`🤝 ${peerLabel(channelRowId)} 的朋友(就是问「${hint}」那位)想认识你。回「同意 ${replyId.slice(0, 6)}」或「不了 ${replyId.slice(0, 6)}」\`)`。
- `accept`(我是 A):`pd = pending[replyId]`;缺 / `pd.targetChannel !== channelRowId` → 丢;发两封 `card`:给 `pd.requesterChannel` 带 B 的 card,给 `pd.targetChannel` 带 `pd.requesterCard`;删 pending 写回;`notifyOwner(\`🤝 我把 ${peerLabel(pd.requesterChannel)} 介绍给了 ${peerLabel(pd.targetChannel)}\`)`。
- `decline`(我是 A):`pd` 同上校验;转发 `decline` 给 `pd.requesterChannel`;删 pending。(我是发心愿方:收到 `decline` → `findPostcardRef` 找到 → `clearMyIntro` → `notifyOwner(\`${peerLabel(channelRowId)} 的朋友这次不想认识新朋友\`)`。分辨「我是 A 还是发心愿方」:pending 里有 → A;wishes.json 里有该 replyId 的引用 → 发心愿方;都没有 → 丢。)
- `card`(我是发心愿方或 B):找 `myIntro`:先 `findPostcardRef(wishes, replyId)`(发心愿方,取 `ref.myIntro`),再 `offers[replyId].myIntro`(B);都没有 → 丢;`r = adopt(card, myIntro, myIntro.bearer, replyId)`;`ok` → `notifyOwner(\`🤝 你和 ${card.name} 成了朋友(经 ${peerLabel(channelRowId)} 介绍)\`)`(`channelOpened:false` 时尾巴加「,信道稍后补」),清 `myIntro` / 删 offer;`id_conflict` → `notifyOwner('介绍失败:对方身份和已有联系人冲突')`。
- `request(replyRef)`(主人动作):`findPostcardRef` → `not_found/ambiguous`;`ref.myIntro` 已有 → `already_requested`;`chan = genChannel()`、`bearer = mintKey()`、`card = buildCard('initiator', replyId, bearer, chan)`;`attachMyIntro(...{ ...chan, bearer, at })` 写回;`sendEnvelope(ref.via, introEnvelope({ stage: 'request', replyId, wishId, card }))`;失败 → `clearMyIntro` + `send_failed`。
- `accept(offerRef)`:`resolveIntroRef(Object.keys(offers), ref)`;`chan/bearer/card('acceptor')`;`offers[replyId].myIntro = …` 写回;发 `accept` 给 `viaChannel`。`decline(offerRef)`:发 `decline`,删 offer。
- `offers()`:`Object.entries(offers)` 映射(`viaLabel = peerLabel(viaChannel)`),按 `at` 降序。
- 每次读索引后先 `pruneIntroIndex(idx, now())`;`expiredPending` 非空时(我是 A)给每个 `requesterChannel` 发 `decline`(失败只 log),写回清过的索引。

- [ ] **Step 1: 夹具扩展**

`social-trio.fixture.ts`:`Peer` 加 `registry: Map<string, { id: string; name: string; mailbox_addr: string }>`、`channels: Array<{ id: string; peerAgentId: string | null; status: string }>`;每个 peer 构造后 `p.intro = makeIntro({ … })`,其中 `buildCard: (role, nonce, bearer, chan) => ({ v: 2, role, nonce, self_id: \`cc-${name.toLowerCase()}00000001\`, name, mailbox_addr: \`M${name}\`, mailbox_enc_pub: \`E${name}\`, relays: ['https://r/mailbox'], bearer, channel_id: chan.channelId, channel_pub: chan.pubkey })`,`adopt: (card, mine, myKey, nonce) => { if ([...p.registry.values()].some(r => r.id === card.self_id && r.mailbox_addr !== card.mailbox_addr)) return { ok: false, reason: 'id_conflict' }; p.registry.set(card.self_id, { id: card.self_id, name: card.name, mailbox_addr: card.mailbox_addr }); p.channels.push({ id: \`intro:${nonce}\`, peerAgentId: card.self_id, status: 'open' }); return { ok: true, channelOpened: true } }`,`mintKey: () => 'k'.repeat(16)`,`genChannel: () => ({ channelId: \`${name}-c\`, pubkey: \`${name}-P\`, privkey: \`${name}-K\` })`,其余复用 wish 的 deps。`deliver` 已经会在 wish 不认领时交给 `intro.onInbound`。

- [ ] **Step 2: 写失败测试**

`src/daemon/bootstrap/wire-intro.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeTrio, flush } from './social-trio.fixture'

async function throughPostcard() {
  const t = makeTrio()
  t.B.judgeSays = { match: 'yes', blurb: '我朋友周末常去' }
  const p = await t.me.wish.propose('找周末爬山搭子'); if (!p.ok) throw new Error(p.error)
  const s = await t.me.wish.send(p.id); if (!s.ok) throw new Error(s.reason)
  await flush()
  const ref = t.me.wish.list().find(w => w.id === p.id)!.postcards![0]!
  return { ...t, wishId: p.id, replyId: ref.replyId }
}

describe('介绍:两边点头就成朋友(spec 2026-09-04-introduction §3)', () => {
  it('我「认识」→ A forward(不带名片)→ B 主人一句 → B 同意 → A 交叉名片 → 双方注册表互有对方、intro:<replyId> 信道各一条、三边主人各一句', async () => {
    const t = await throughPostcard()
    const r = await t.me.intro!.request(t.replyId.slice(0, 6))
    expect(r).toEqual({ ok: true, replyId: t.replyId })
    await flush()
    const fwd = t.B.letters.find(l => l.dir === 'in' && l.kind === 'intro')!
    expect(fwd.payload).toMatchObject({ stage: 'forward', hint: '找周末爬山搭子' })
    expect((fwd.payload as { card?: unknown }).card).toBeUndefined()
    expect(t.B.owner.at(-1)).toBe(`🤝 阿A 的朋友(就是问「找周末爬山搭子」那位)想认识你。回「同意 ${t.replyId.slice(0, 6)}」或「不了 ${t.replyId.slice(0, 6)}」`)
    expect(t.B.intro!.offers()).toMatchObject([{ replyId: t.replyId, hint: '找周末爬山搭子', viaLabel: '阿A' }])
    expect(await t.B.intro!.accept(t.replyId.slice(0, 6))).toEqual({ ok: true, replyId: t.replyId })
    await flush()
    expect(t.me.registry.get('cc-b00000001')).toMatchObject({ name: 'B' })
    expect(t.B.registry.get('cc-me00000001')).toMatchObject({ name: 'me' })
    expect(t.me.channels).toEqual([{ id: `intro:${t.replyId}`, peerAgentId: 'cc-b00000001', status: 'open' }])
    expect(t.B.channels).toEqual([{ id: `intro:${t.replyId}`, peerAgentId: 'cc-me00000001', status: 'open' }])
    expect(t.me.owner.at(-1)).toBe('🤝 你和 B 成了朋友(经 阿A 介绍)')
    expect(t.B.owner.at(-1)).toBe('🤝 你和 me 成了朋友(经 阿A 介绍)')
    expect(t.A.owner.at(-1)).toBe('🤝 我把 小我 介绍给了 阿B')
    expect(t.B.intro!.offers()).toEqual([])
    expect(t.A.registry.size).toBe(0)   // 介绍人自己不加任何人
  })
  it('B 不了 → 我一句话,无信道,myIntro 清掉', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    expect(await t.B.intro!.decline(t.replyId)).toEqual({ ok: true, replyId: t.replyId }); await flush()
    expect(t.me.owner.at(-1)).toBe('阿A 的朋友这次不想认识新朋友')
    expect(t.me.channels).toEqual([]); expect(t.B.channels).toEqual([])
    expect(await t.me.intro!.request(t.replyId)).toEqual({ ok: true, replyId: t.replyId })   // 可以再问一次
  })
  it('request:不认识的 replyId / 前缀撞车 / 重复请求', async () => {
    const t = await throughPostcard()
    expect(await t.me.intro!.request('zzzzzz')).toEqual({ ok: false, reason: 'not_found' })
    expect(await t.me.intro!.request(t.replyId)).toMatchObject({ ok: true })
    expect(await t.me.intro!.request(t.replyId)).toEqual({ ok: false, reason: 'already_requested' })
  })
  it('A 只接受来自发心愿那条信道的 request(别人冒充 → 丢)', async () => {
    const t = await throughPostcard()
    const card = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-evil0000001', name: 'E', mailbox_addr: 'ME', mailbox_enc_pub: 'EE', relays: ['https://r/mailbox'], bearer: 'e'.repeat(16), channel_id: 'ec', channel_pub: 'EP' }
    // 从 B 那条信道伪造一个 request
    t.deliver(t.B, 'B>A', { kind: 'intro', payload: { stage: 'request', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.B.letters.filter(l => l.dir === 'in' && l.kind === 'intro')).toHaveLength(0)
    expect(t.A.logs.some(l => /request.*(不是发心愿|丢)/.test(l))).toBe(true)
  })
  it('accept 没有对应 pending → 丢,没人被打扰', async () => {
    const t = await throughPostcard()
    const card = { v: 2, role: 'acceptor', nonce: 'x', self_id: 'cc-b00000001', name: 'B', mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'], bearer: 'b'.repeat(16), channel_id: 'bc', channel_pub: 'BP' }
    t.deliver(t.B, 'B>A', { kind: 'intro', payload: { stage: 'accept', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.me.letters.filter(l => l.dir === 'in' && l.kind === 'intro')).toHaveLength(0)
  })
  it('身份冲突:我这边已有同 id 不同信箱的联系人 → 介绍失败一句话,无信道', async () => {
    const t = await throughPostcard()
    t.me.registry.set('cc-b00000001', { id: 'cc-b00000001', name: 'Other', mailbox_addr: 'DIFFERENT' })
    await t.me.intro!.request(t.replyId); await flush()
    await t.B.intro!.accept(t.replyId); await flush()
    expect(t.me.owner.at(-1)).toBe('介绍失败:对方身份和已有联系人冲突')
    expect(t.me.channels).toEqual([])
  })
  it('pending 过期 → A 替 B 发 decline', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    t.me.clock.ms += 7 * 24 * 60 * 60_000 + 1000    // 三方共用一个时钟
    await t.me.intro!.request('nothing')            // 任何一次读索引都会触发 prune;这里用 A 自己的一次读
    await t.A.intro!.decline('nothing')             // A 侧读一次索引 → prune → 发 decline
    await flush()
    expect(t.me.owner.at(-1)).toBe('阿A 的朋友这次不想认识新朋友')
  })
  it('intro 信封持 busy token 且放开;非 intro kind → false', async () => {
    const t = await throughPostcard()
    expect(t.me.intro!.onInbound('me>A', { kind: 'letter', payload: {} }, 'x')).toBe(false)
  })
})
```

(busy token 的断言:夹具的 `holdBusy` 记账数组照 wire-wish.test.ts 的 `busy` 加进 `Peer`,最后一条测试断言 `t.A.busy.some(b => b.label === 'intro' && b.released)`。)

- [ ] **Step 3: 跑测试确认失败** → cannot find module `./wire-intro`
- [ ] **Step 4: 实现 `wire-intro.ts`**(照上面的 stage 表;文件头 WHY;所有失败只 log;`onInbound` 同步 true)
- [ ] **Step 5: 跑测试** — `bun --bun vitest run src/daemon/bootstrap/wire-intro.test.ts src/daemon/bootstrap/wire-wish.test.ts && bun run typecheck` → 全绿
- [ ] **Step 6: 提交** — `git add src/daemon/bootstrap/wire-intro.ts src/daemon/bootstrap/wire-intro.test.ts src/daemon/bootstrap/social-trio.fixture.ts && git commit -m "wire-intro:认识 → 转问 → 点头 → 介绍人交叉名片 → 双方 adoptPeerCard 成朋友;唯一的人工门在被介绍方"`

---

### Task 7: 接线 —— wire-social、类型、bootstrap、微信命令

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`(`case 'intro'`;构造 `intro`;`makeWish` 传 `forwardBudget`;`social.intro`)
- Modify: `src/daemon/bootstrap/types.ts`、`src/daemon/internal-api/types.ts`、`src/daemon/wiring/pipeline-deps.ts`(`social.intro`)
- Create: `src/core/intro-command.ts` + test(「认识 <ref>」「同意 <ref>」「不了 <ref>」解析)
- Modify: `src/daemon/wiring/command-router.ts` + test(三条命令)

**Interfaces:**
- Consumes: `makeIntro`(Task 6)、`buildOwnCard` / `adoptPeerCard`(Task 4)、`makeForwardBudget`、`FORWARD_*`。
- Produces:
  - `SocialWiring.social.intro` / `Bootstrap.social.intro`: `Omit<IntroService, 'onInbound'>`;`InternalApiDeps.social.intro?` 同形可选。
  - `CommandRouterDeps.social.intro: Pick<IntroService, 'request' | 'accept' | 'decline'>`。
  - `parseIntroCommand(text): { kind: 'request' | 'accept' | 'decline'; ref: string } | null`,正则 `^(认识|同意|不了)\s+#?([0-9a-fA-F]{2,8})\s*$`。
  - 微信文案:request ok → 「已经托 <A> 去问了,对方点头我就告诉你」;not_found → 「没有这张明信片」;ambiguous → 「有多张匹配,请给更长的编号」;already_requested → 「已经在问了,等对方点头」;send_failed → 「没送出去,稍后再试」。accept ok → 「好,我把名片递过去了」;decline ok → 「好,我回了不了」;not_found → 「没有这条邀约(可能过期了)」。

- [ ] **Step 1: 写失败测试**

`src/core/intro-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseIntroCommand } from './intro-command'
describe('parseIntroCommand', () => {
  it('认识 / 同意 / 不了 + 2–8 位 hex 引用;可带 #;两边空白', () => {
    expect(parseIntroCommand('认识 ab12')).toEqual({ kind: 'request', ref: 'ab12' })
    expect(parseIntroCommand(' 同意 #ff00aa ')).toEqual({ kind: 'accept', ref: 'ff00aa' })
    expect(parseIntroCommand('不了 c0ffee00')).toEqual({ kind: 'decline', ref: 'c0ffee00' })
  })
  it('不是这三个词 / 引用不是 hex / 太长 / 没引用 → null', () => {
    for (const t of ['认识 你', '认识', '同意 zz', '不了 123456789', '派 ab12', '认识 ab12 更多']) expect(parseIntroCommand(t)).toBe(null)
  })
})
```

`src/daemon/wiring/command-router.test.ts` 末尾追加(照文件里 派/取消 那个 describe 的 `baseDeps` 用法;`intro` 三个是 `vi.fn`):

```ts
describe('command-router — 认识 / 同意 / 不了', () => {
  const mkIntro = () => ({ request: vi.fn(), accept: vi.fn(), decline: vi.fn() })
  const run = async (text: string, intro: ReturnType<typeof mkIntro>) => {
    const say = vi.fn()
    const deps = baseDeps({ sendAssistantText: say, social: { wish: { resolveRef: vi.fn(), send: vi.fn(), cancel: vi.fn() }, penpal: { startVisit: vi.fn() }, intro } as never })
    const handled = await dispatch(deps, { chatId: 'admin', text } as never)   // 以文件里现有的调用形状为准
    return { handled, said: say.mock.calls.map(c => c[1]) }
  }
  it('认识:ok / not_found / ambiguous / already_requested / send_failed 各一句', async () => {
    const intro = mkIntro()
    intro.request.mockResolvedValueOnce({ ok: true, replyId: 'ab12cd34' })
    expect((await run('认识 ab12', intro)).said).toEqual(['已经托朋友去问了,对方点头我就告诉你'])
    for (const [reason, copy] of [['not_found', '没有这张明信片'], ['ambiguous', '有多张匹配,请给更长的编号'], ['already_requested', '已经在问了,等对方点头'], ['send_failed', '没送出去,稍后再试']] as const) {
      intro.request.mockResolvedValueOnce({ ok: false, reason })
      expect((await run('认识 ab12', intro)).said).toEqual([copy])
    }
  })
  it('同意 / 不了', async () => {
    const intro = mkIntro()
    intro.accept.mockResolvedValueOnce({ ok: true, replyId: 'x' })
    expect((await run('同意 ab', intro)).said).toEqual(['好,我把名片递过去了'])
    intro.decline.mockResolvedValueOnce({ ok: true, replyId: 'x' })
    expect((await run('不了 ab', intro)).said).toEqual(['好,我回了不了'])
    intro.accept.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await run('同意 ab', intro)).said).toEqual(['没有这条邀约(可能过期了)'])
  })
  it('非管理员 / social 没接 → 不处理(落回普通对话)', async () => {
    const intro = mkIntro()
    const deps = baseDeps({ social: undefined as never })
    expect(await dispatch(deps, { chatId: 'admin', text: '认识 ab12' } as never)).toBe(false)
    expect(intro.request).not.toHaveBeenCalled()
  })
})
```

(`dispatch(deps, msg)` 与 `baseDeps` 的确切名字以该测试文件现有代码为准 —— 派/取消 的 describe 就是模板。「已经托朋友去问了」里的「朋友」:route 层拿不到 A 的名字时用「朋友」;wire-intro 的 `request` 返回值不带 label,文案固定。)

- [ ] **Step 2: 实现**

`src/core/intro-command.ts`:

```ts
/** 「认识 <ref>」「同意 <ref>」「不了 <ref>」—— 介绍的三个主人动作,和 派/取消 同一套确定性解析。 */
const RE = /^\s*(认识|同意|不了)\s+#?([0-9a-fA-F]{2,8})\s*$/
export function parseIntroCommand(text: string): { kind: 'request' | 'accept' | 'decline'; ref: string } | null {
  const m = RE.exec(text)
  if (!m) return null
  const kind = m[1] === '认识' ? 'request' : m[1] === '同意' ? 'accept' : 'decline'
  return { kind, ref: m[2]!.toLowerCase() }
}
```
  - `wire-social.ts`:import `makeIntro`、`buildOwnCard`、`adoptPeerCard`、`makeForwardBudget`、`FORWARD_PER_SENDER`、`FORWARD_WINDOW_MS`;`let intro`;`case 'intro': if (!intro?.onInbound(...)) log; return`;`makeWish({..., forwardBudget: makeForwardBudget({ perSender: FORWARD_PER_SENDER, windowMs: FORWARD_WINDOW_MS }) })`;在 `wish = makeWish(...)` 之后:

    ```ts
    const cardDeps = { selfId: () => SOCIAL_SELF_ID, name: () => configuredAgent.bot_name?.trim() || 'wechat-cc', self: { mailbox_addr: myMailbox.addr, mailbox_enc_pub: myMailbox.enc_pub, relays: configuredAgent.mailbox_relays ?? [] } }
    const adoptDeps = { registry: a2aRegistry, channelStore, log: (m: string) => deps.log('INTRO', m) }
    intro = makeIntro({
      stateDir: deps.stateDir, channelStore, holdBusy: deps.holdBusy,
      sendEnvelope: (c, e) => correspondent.sendEnvelope(c, e),
      buildCard: (role, nonce, bearer, chan) => buildOwnCard(cardDeps, role, nonce, bearer, chan),
      adopt: (card, mine, myKey, nonce) => adoptPeerCard(adoptDeps, card, mine, myKey, nonce, 'intro'),
      mintKey: () => randomBytes(24).toString('hex'),
      genChannel: () => { const kp = generateKeypair(); return { channelId: randomUUID(), pubkey: kp.publicKey, privkey: kp.privateKey } },
      notifyOwner: (text) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, text) },
      peerLabel, log: deps.log,
    })
    socialIntro = { request: (r) => intro!.request(r), accept: (r) => intro!.accept(r), decline: (r) => intro!.decline(r), offers: () => intro!.offers() }
    ```
    `myMailbox` 的确切变量名以文件 L245-271 为准(`loadMailboxIdentity` 的结果);`mailbox_relays` 为空时 `intro` 仍可构造,只是名片 relays 为空 → 对方 `isValidPairCard` 会拒 —— 这种机器本来也配不了对,可接受,log 一行。`channelStore` 需要 `create/setPeerHandle/setStatus/get/list`(wire-social 里的是完整 `makeChannelStore`,够用)。
  - 三个类型文件 + `pipeline-deps.ts`(`social: { wish, intro: boot.social.intro, penpal: … }`)。
  - `command-router.ts`:在 派/取消 块后加 intro 块(同样 `deps.social && deps.isAdmin`)。
- [ ] **Step 3: 跑测试** — `bun run typecheck && bun --bun vitest run src/core/intro-command.test.ts src/daemon/wiring src/daemon/bootstrap.test.ts src/daemon/bootstrap` → 全绿(bootstrap.test.ts 若断言 `social` 的键集合,补 `intro`)。
- [ ] **Step 4: 提交** — `git add -A src/core/intro-command.ts src/core/intro-command.test.ts src/daemon && git commit -m "介绍接线:correspondent 加 intro case;心愿带转问预算;微信「认识 / 同意 / 不了」"`

---

### Task 8: 路由

**Files:**
- Modify: `src/daemon/internal-api/routes-social.ts`、`route-tiers.ts`
- Test: `src/daemon/internal-api/routes-social.test.ts`(追加 describe)

**Interfaces(全部 trusted):**
- `POST /v1/social/intro/request {reply_id}` → 200 `{ ok:true, reply_id }` | 200 `{ ok:false, reason }`;400 `missing_reply_id`;503 `social_not_wired`。
- `POST /v1/social/intro/accept {reply_id}`、`POST /v1/social/intro/decline {reply_id}` 同形。
- `GET /v1/social/intro/offers` → `{ offers: [{ reply_id, hint, via_label, at }] }`。
- `GET /v1/social/wishes` 每条加 `postcards: [{ reply_id, via_label, preview, at, requested: boolean }]`(`requested = !!myIntro`;`via_label` 用 `deps.social.wish` 拿不到 peerLabel —— 让 `WishService.list()` 的每条 `postcards` 项带 `viaLabel`:在 Task 5 的 `list()` 里用 `deps.peerLabel(ref.via)` 补上。若 Task 5 已合入没做,这里补做并加测试)。

- [ ] **Step 1: 写失败测试**

`src/daemon/internal-api/routes-social.test.ts` 末尾追加:

```ts
describe('/v1/social/intro/*', () => {
  const intro = {
    request: vi.fn(async (r: string) => (r === 'ab' ? { ok: true as const, replyId: 'ab12cd34' } : { ok: false as const, reason: 'not_found' as const })),
    accept: vi.fn(async () => ({ ok: true as const, replyId: 'ab12cd34' })),
    decline: vi.fn(async () => ({ ok: true as const, replyId: 'ab12cd34' })),
    offers: vi.fn(() => [{ replyId: 'ab12cd34', hint: '找搭子', viaLabel: '阿A', at: 't' }]),
  }
  const wish = { list: vi.fn(() => [{ id: 'w1', text: 'x', redacted: 'x', status: 'open' as const, effective: 'open' as const, createdAt: 'c', sentAt: 's', expiresAt: 'e', sentTo: 1, replies: 1,
    postcards: [{ replyId: 'ab12cd34', via: 'me>A', viaLabel: '阿A', at: 't', preview: 'p', myIntro: { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'B', at: 't' } }] }]), propose: vi.fn(), send: vi.fn(), cancel: vi.fn(), resolveRef: vi.fn() }
  const r = socialRoutes({ social: { wish, intro } } as unknown as InternalApiDeps)
  it('request / accept / decline:body reply_id → snake_case 结果;缺 → 400', async () => {
    expect((await r['POST /v1/social/intro/request']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/request']!(qs(), { reply_id: 'zz' })).body).toEqual({ ok: false, reason: 'not_found' })
    expect((await r['POST /v1/social/intro/accept']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/decline']!(qs(), { reply_id: 'ab' })).body).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect((await r['POST /v1/social/intro/request']!(qs(), {})).status).toBe(400)
  })
  it('offers 与 wishes 的 postcards 都是 snake_case;requested = 有 myIntro,且 myIntro 不外泄', async () => {
    expect((await r['GET /v1/social/intro/offers']!(qs(), undefined)).body).toEqual({ offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] })
    const w = (await r['GET /v1/social/wishes']!(qs(), undefined)).body as { wishes: Array<{ postcards: unknown[] }> }
    expect(w.wishes[0]!.postcards).toEqual([{ reply_id: 'ab12cd34', via_label: '阿A', preview: 'p', at: 't', requested: true }])
  })
  it('没接 → 503;四条 tier trusted', async () => {
    expect((await socialRoutes({ social: { wish } } as unknown as InternalApiDeps)['POST /v1/social/intro/request']!(qs(), { reply_id: 'ab' })).status).toBe(503)
    for (const k of ['POST /v1/social/intro/request', 'POST /v1/social/intro/accept', 'POST /v1/social/intro/decline', 'GET /v1/social/intro/offers']) expect(minTierFor(k)).toBe('trusted')
  })
})
```

- [ ] **Step 2: 实现** + `route-tiers.ts` 四条 `'trusted'`(handler 形状照 `/v1/social/wish/*`:`deps.social?.intro` 缺 → 503 `social_not_wired`;`reply_id` 非空字符串校验 → 400 `missing_reply_id`;`ok` 时 `{ ok: true, reply_id: r.replyId }`,否则原样透传 `{ ok:false, reason }`;`GET /v1/social/wishes` 的映射加 `postcards: (w.postcards ?? []).map(p => ({ reply_id: p.replyId, via_label: p.viaLabel, preview: p.preview, at: p.at, requested: !!p.myIntro }))`)
- [ ] **Step 3: 跑测试** — `bun --bun vitest run src/daemon/internal-api && bun run typecheck`(含 `route-tiers.test.ts` 的「每条路由有 tier」)
- [ ] **Step 4: 提交** — `git commit -m "/v1/social/intro/*:认识 / 同意 / 不了 / 待点头;心愿列表带 hop 2 明信片引用"`

---

### Task 9: 桌面 —— 「想认识 TA」与「待你点头」

**Files:**
- Modify: `apps/desktop/src/index.html`(心愿区加 `<div class="wsh-offers" id="fd-wish-offers" hidden></div>`,放在 `#fd-wish-list` 之前)
- Modify: `apps/desktop/src/modules/wishes.js`(每条 open/closed 心愿下列出 `postcards`:`「<via_label> 的朋友」<preview> [想认识 TA]`(`data-wsh-action="intro" data-wsh-reply="<reply_id>"`,`requested` 时显示「已在问」不可点);`renderOffers(data)`:每条 `「<via_label> 的朋友(问「<hint>」)想认识你」 [同意] [不了]`(`data-wsh-action="accept"|"decline" data-wsh-reply`);`refreshWishes()` 同时 `GET /v1/social/intro/offers`;`onWishAction` 三个新分支打对应路由并 toast:intro ok「已经托 TA 去问了」/ already_requested「已经在问了」/ not_found「这张明信片过期了」;accept ok「名片递过去了」;decline ok「回了不了」)
- Modify: `apps/desktop/src/styles.css`(`.wsh-pc-row`、`.wsh-offers` 两条)
- Test: `apps/desktop/src/modules/wishes.test.ts`(追加 describe:postcards 行与按钮、requested 态、offers 渲染、三个动作打对路由)

**注意:spec §5 写的是「明信片卡上加按钮」;实际 replyId 只有心愿列表(`GET /v1/social/wishes`)拿得到,journal 行没有它 —— 按钮放心愿区该心愿下面。Task 10 把 spec 改过来。**

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/modules/wishes.test.ts` 末尾追加(`els` / `mkEl` / `invokeApi` / `showToast` 是文件里已有的;把 `renderOffers` 加进顶层的 `await import('./wishes.js')` 解构;`beforeEach` 里给 `fd-wish-offers` 也 `els.set`):

```ts
describe('介绍:想认识 TA / 待你点头', () => {
  const wishWithPostcards = (requested = false) => ({ wishes: [{ id: 'w1', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 1,
    postcards: [{ reply_id: 'ab12cd34', via_label: '阿A', preview: '我朋友常去', at: 't', requested }] }] })
  it('心愿下列出 hop 2 明信片:「阿A 的朋友」+ 预览 + 想认识按钮;requested 时显示「已在问」且没有按钮', () => {
    renderWishes(wishWithPostcards())
    const html = els.get('fd-wish-list')!.innerHTML
    expect(html).toContain('阿A 的朋友'); expect(html).toContain('我朋友常去')
    expect(html).toContain('data-wsh-action="intro" data-wsh-reply="ab12cd34"')
    renderWishes(wishWithPostcards(true))
    const html2 = els.get('fd-wish-list')!.innerHTML
    expect(html2).toContain('已在问'); expect(html2).not.toContain('data-wsh-action="intro"')
  })
  it('renderOffers:每条邀约有 同意 / 不了;空 → 区块隐藏', () => {
    renderOffers({ offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] })
    const box = els.get('fd-wish-offers')!
    expect(box.hidden).toBe(false)
    expect(box.innerHTML).toContain('阿A 的朋友'); expect(box.innerHTML).toContain('找搭子')
    expect(box.innerHTML).toContain('data-wsh-action="accept" data-wsh-reply="ab12cd34"')
    expect(box.innerHTML).toContain('data-wsh-action="decline" data-wsh-reply="ab12cd34"')
    renderOffers({ offers: [] })
    expect(box.hidden).toBe(true)
  })
  it('三个动作打对路由并 toast', async () => {
    const click = (action: string) => onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? action : k === 'data-wsh-reply' ? 'ab12cd34' : null) }) } })
    invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('intro')
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/request', { reply_id: 'ab12cd34' })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('托'))
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: false, reason: 'already_requested' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('intro'); expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('已经在问'))
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('accept'); expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/accept', { reply_id: 'ab12cd34' })
    invokeApi.mockReset(); invokeApi.mockResolvedValueOnce({ ok: true, reply_id: 'ab12cd34' }).mockResolvedValue({ wishes: [], offers: [] })
    await click('decline'); expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/intro/decline', { reply_id: 'ab12cd34' })
  })
})
```

`mkEl()` 需要 `hidden: false` 字段(若还没有)。`onWishAction` 现在读 `data-wsh-reply`(intro / accept / decline)或 `data-wsh-id`(原有三种);`refreshWishes()` 并行拉 `/v1/social/wishes` 与 `/v1/social/intro/offers`,分别喂 `renderWishes` / `renderOffers`(offers 拉不到 → `renderOffers({ offers: [] })`)。

- [ ] **Step 2: 实现** → **Step 3:** `bun --bun vitest run apps/desktop/src/modules/wishes.test.ts apps/desktop/src/modules/a2a-agents.test.ts apps/desktop/shim.e2e.test.ts && node --check apps/desktop/src/modules/wishes.js` → **Step 4: 提交** `git commit -m "觅食台:hop 2 明信片下「想认识 TA」;「待你点头」列表(同意 / 不了)"`

---

### Task 10: 关系视图 origin、文档对齐、全量

**Files:**
- Modify: `src/core/relationships.ts`(有信道且 `known` 的 peer:`seek_id` 以 `intro:` 开头 → `origin: '经朋友介绍'`,`pair:` → '配对',其它 → '配对'(旧行);测试一条)
- Modify: `docs/superpowers/specs/2026-09-04-introduction-design.md`(§5 桌面行:按钮在心愿区不在明信片卡;§3 名片 `role` 字段只是名片格式沿用)、`docs/superpowers/specs/2026-09-04-social-architecture-rethink.md`(步 6 标「1 跳 + 介绍均已做;匿名层退役」)
- Full: `bun run typecheck && bun --bun vitest run && (cd apps/desktop/src-tauri && cargo check)`

- [ ] **Step 1:** relationships 测试 + 实现 → **Step 2:** 文档 → **Step 3:** 全量 → **Step 4:** 提交 `git commit -m "关系视图:经介绍开的信道标「经朋友介绍」;spec 对齐(按钮位置、步 6 完成)"`

---

## 完成后(真机)

- 两台真机只能验到「A 判不能就转 + 预算 + 索引」;完整三方链路靠 `wire-intro.test.ts`。有第三台时:me 派心愿 → A 转 → B 答 → me「认识」→ B「同意」→ 三边各一句、me 与 B 互见对方为 peer。
- memory:`wish-postcard-shipped` 的「介绍下一轮」改为已做;新建 `introduction-shipped`。
