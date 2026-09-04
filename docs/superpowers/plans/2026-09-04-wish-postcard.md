# 心愿与明信片(Wish / Postcard)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「派心愿 → 回声 → 揭晓」这条旧的工具社交管道,改写成两种走 E2E 信道的信封(`wish` / `postcard`),补上「配对即开信道」,然后把旧管道整个删掉。

**Architecture:** 心愿是一个纯状态机(`src/core/wish.ts`)+ 一个小的 JSON 索引(`companion/wishes.json`);发出去的心愿和回来的明信片都是 `penpal_letter` 里带 kind 的信封,不建表。接线层新增 `wire-wish.ts`(照 `wire-visit.ts` 的形状:deps 注入、纯逻辑可在同进程两个 daemon 之间对跑),在 correspondent 的 `switch (env.kind)` 各加一个 case。6 位配对码的 PairCard 带上信道句柄,配对完成即双方各建一条 open 信道。最后一次性删掉 broker / seek / echo / pledge / relay / reveal 及其路由、表、桌面区块。

**Tech Stack:** TypeScript + Bun + Vitest(`bun --bun vitest run <file>`),internal-api 路由表 + route-tiers,zod,桌面纯 JS(`// @ts-check`),SQLite 迁移(`src/lib/db.ts` 的 `migrations[]`,`user_version` = 已应用条数)。

**Spec:** `docs/superpowers/specs/2026-09-04-wish-postcard-design.md`

## Global Constraints

- **不加任何 `/a2a/<功能>` 路由**;新交互 = correspondent `switch (env.kind)` 里的一个 case。新的主人侧接口全部在 `/v1/social/wish*`,tier **trusted**。
- **不兼容旧协议**:`/a2a/intent` `/a2a/echo` `/a2a/reveal` 删除;`A2A_PROTO_VERSION` 升到 **3**。
- **常量**:`WISH_TTL_MS = 7 * 24 * 60 * 60_000`;`MAX_OPEN_WISHES = 3`;收件方幂等记录保留 `WISH_SEEN_TTL_MS = 14 * 24 * 60 * 60_000`;`GET /v1/social/wishes` 列最近 **30** 天。
- **披露门**:任何出站文本(心愿正文、明信片正文)必须经 `gateOutbound(text, { policy, cheapEval, timeoutMs })`(`src/core/a2a-disclosure.ts`),没有第二个出口。
- **邻居不参与**:心愿只广播给 `channelStore.list()` 里 `status === 'open'` 的信道;不排序不挑人。
- **微信两步确认保留**:MCP 工具 / 桌面只 `propose`(草稿);发出必须是主人「派 <id>」或桌面点「派」。
- **不建新表**;新状态文件:`<stateDir>/companion/wishes.json`、`<stateDir>/companion/wishes-seen.json`,读一律走 `readJsonFile`(仓库守卫测试会抓裸 `JSON.parse(readFileSync)`)。
- **迁移**:追加在 `migrations[]` 末尾(写作时数组长 42,新条目即 v43;若前面又进了别的迁移,顺延,不要写死数字);`repairBranchRenumberedSchema` 只看 user_version 19–21,不受影响。
- **笔友信箱(`#fd-mailbox`,`/v1/penpal/*`)保留** —— 它是桌面唯一读信的地方;删的是「我派出去的心愿」「回声」两块。`/v1/social/inbound`(a2a_listen 开关)和 `/v1/social/enable` 保留。
- **每个任务提交前**跑该任务列出的测试文件 + `bun run typecheck`;大删除任务额外跑全量 `bun --bun vitest run`。提交信息中文一句话说清楚为什么。

---

### Task 1: `wish.ts` 纯状态机 + 信封载荷

**Files:**
- Create: `src/core/wish.ts`
- Test: `src/core/wish.test.ts`

**Interfaces:**
- Produces:

```ts
export type WishStatus = 'draft' | 'open' | 'closed' | 'cancelled'
export interface WishRecord {
  id: string; text: string; redacted: string
  status: WishStatus
  createdAt: string; sentAt: string | null; expiresAt: string | null
  sentTo: number; replies: number
}
export const WISH_TTL_MS: number            // 7 天
export const MAX_OPEN_WISHES: number        // 3
export interface WishPayload { id: string; text: string; expiresAt: string }
export interface PostcardPayload { wishId: string; text: string }
export function newWishId(): string                                   // 8 hex(crypto.randomBytes)
export function isExpired(w: WishRecord, nowMs: number): boolean       // open 且 expiresAt 已过
export function effectiveStatus(w: WishRecord, nowMs: number): WishStatus | 'expired'
export function openCount(list: readonly WishRecord[], nowMs: number): number
export function draftWish(list, args: { id: string; text: string; redacted: string; nowIso: string }): WishRecord[]
export function sendWish(list, id: string, nowIso: string, sentTo: number): { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'not_draft' | 'too_many_open' }
export function cancelWish(list, id: string): { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'already_done' }
export function acceptPostcard(list, wishId: string, nowMs: number): { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'unknown' | 'expired' }
export function resolveWishRef(list, ref: string, among: readonly WishStatus[]): { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' }
export function recentWishes(list, nowMs: number, days?: number): WishRecord[]   // 默认 30 天,按 createdAt 降序
export function wishEnvelope(w: WishRecord): Envelope<WishPayload>
export function parseWishPayload(env: Envelope): WishPayload | null
export function postcardEnvelope(wishId: string, text: string): Envelope<PostcardPayload>
export function parsePostcardPayload(env: Envelope): PostcardPayload | null
export function seenKey(wishId: string, channelRowId: string): string   // `${wishId}:${channelRowId}`
```

- [ ] **Step 1: 写失败测试**

`src/core/wish.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  WISH_TTL_MS, MAX_OPEN_WISHES, newWishId, draftWish, sendWish, cancelWish, acceptPostcard,
  resolveWishRef, recentWishes, effectiveStatus, isExpired, openCount,
  wishEnvelope, parseWishPayload, postcardEnvelope, parsePostcardPayload, seenKey, type WishRecord,
} from './wish'

const T0 = '2026-09-04T10:00:00.000Z'
const ms = (iso: string) => Date.parse(iso)
const mk = (over: Partial<WishRecord> = {}): WishRecord => ({
  id: 'abcd1234', text: '找周末爬山搭子', redacted: '找周末爬山搭子', status: 'draft',
  createdAt: T0, sentAt: null, expiresAt: null, sentTo: 0, replies: 0, ...over,
})

describe('wish 状态机', () => {
  it('draft → send → open,expiresAt = sentAt + 7 天,sentTo 记下', () => {
    const list = draftWish([], { id: 'abcd1234', text: 'x', redacted: 'x', nowIso: T0 })
    const r = sendWish(list, 'abcd1234', T0, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wish.status).toBe('open')
    expect(r.wish.sentTo).toBe(2)
    expect(ms(r.wish.expiresAt!)).toBe(ms(T0) + WISH_TTL_MS)
  })
  it('只有 draft 能 send;不存在 → not_found', () => {
    expect(sendWish([mk({ status: 'open' })], 'abcd1234', T0, 1)).toEqual({ ok: false, reason: 'not_draft' })
    expect(sendWish([], 'nope', T0, 1)).toEqual({ ok: false, reason: 'not_found' })
  })
  it('最多 3 条 open;第 4 条 send 被拒 too_many_open;过期的不占名额', () => {
    const opens = [1, 2, 3].map(i => mk({ id: `open000${i}`, status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' }))
    const list = [...opens, mk({ id: 'draft001' })]
    expect(sendWish(list, 'draft001', T0, 1)).toEqual({ ok: false, reason: 'too_many_open' })
    const expired = [...opens.map(w => ({ ...w, expiresAt: '2026-09-04T09:00:00.000Z' })), mk({ id: 'draft001' })]
    expect(sendWish(expired, 'draft001', T0, 1).ok).toBe(true)
    expect(openCount(opens, ms(T0))).toBe(MAX_OPEN_WISHES)
  })
  it('cancel:draft → cancelled,open → closed;closed 再取消 → already_done', () => {
    const a = cancelWish([mk()], 'abcd1234'); expect(a.ok && a.wish.status).toBe('cancelled')
    const b = cancelWish([mk({ status: 'open' })], 'abcd1234'); expect(b.ok && b.wish.status).toBe('closed')
    expect(cancelWish([mk({ status: 'closed' })], 'abcd1234')).toEqual({ ok: false, reason: 'already_done' })
  })
  it('effectiveStatus / isExpired:open 过期 → expired;closed 不算过期', () => {
    const w = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    expect(effectiveStatus(w, ms('2026-09-10T00:00:00.000Z'))).toBe('open')
    expect(effectiveStatus(w, ms('2026-09-12T00:00:00.000Z'))).toBe('expired')
    expect(isExpired({ ...w, status: 'closed' }, ms('2026-09-12T00:00:00.000Z'))).toBe(false)
  })
  it('acceptPostcard:open 且未过期 → replies+1;closed 也收(人家已经答了);过期 → expired;不认识 → unknown', () => {
    const open = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    const r = acceptPostcard([open], 'abcd1234', ms('2026-09-05T00:00:00.000Z'))
    expect(r.ok && r.wish.replies).toBe(1)
    const c = acceptPostcard([{ ...open, status: 'closed' }], 'abcd1234', ms('2026-09-05T00:00:00.000Z'))
    expect(c.ok).toBe(true)
    expect(acceptPostcard([open], 'abcd1234', ms('2026-09-12T00:00:00.000Z'))).toEqual({ ok: false, reason: 'expired' })
    expect(acceptPostcard([open], 'zzzz', ms(T0))).toEqual({ ok: false, reason: 'unknown' })
  })
  it('resolveWishRef:前缀匹配,限定状态;多条 → ambiguous', () => {
    const list = [mk({ id: 'abcd1234' }), mk({ id: 'abcd9999', status: 'open' }), mk({ id: 'ffff0000' })]
    expect(resolveWishRef(list, 'abcd', ['draft'])).toEqual({ ok: true, id: 'abcd1234' })
    expect(resolveWishRef(list, 'abcd', ['draft', 'open'])).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveWishRef(list, 'ff', ['open'])).toEqual({ ok: false, reason: 'not_found' })
  })
  it('recentWishes:30 天内,按 createdAt 降序', () => {
    const list = [mk({ id: 'old', createdAt: '2026-07-01T00:00:00.000Z' }), mk({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z' }), mk({ id: 'b', createdAt: '2026-09-03T00:00:00.000Z' })]
    expect(recentWishes(list, ms(T0)).map(w => w.id)).toEqual(['b', 'a'])
  })
  it('newWishId:8 位 hex,每次不同', () => {
    const a = newWishId(), b = newWishId()
    expect(a).toMatch(/^[0-9a-f]{8}$/); expect(a).not.toBe(b)
  })
})

describe('信封载荷', () => {
  it('wishEnvelope ↔ parseWishPayload 往返;非 wish / 缺字段 → null', () => {
    const w = mk({ status: 'open', sentAt: T0, expiresAt: '2026-09-11T10:00:00.000Z' })
    const env = wishEnvelope(w)
    expect(env.kind).toBe('wish')
    expect(parseWishPayload(env)).toEqual({ id: 'abcd1234', text: '找周末爬山搭子', expiresAt: '2026-09-11T10:00:00.000Z' })
    expect(parseWishPayload({ kind: 'letter', payload: {} })).toBe(null)
    expect(parseWishPayload({ kind: 'wish', payload: { id: 'x' } })).toBe(null)
  })
  it('wishEnvelope 发的是 redacted,不是原文', () => {
    const w = mk({ text: '找爬山搭子,我住XX路', redacted: '找爬山搭子', status: 'open', sentAt: T0, expiresAt: T0 })
    expect(parseWishPayload(wishEnvelope(w))!.text).toBe('找爬山搭子')
  })
  it('postcardEnvelope ↔ parsePostcardPayload;空 text → null', () => {
    expect(parsePostcardPayload(postcardEnvelope('abcd1234', '我朋友周末常去'))).toEqual({ wishId: 'abcd1234', text: '我朋友周末常去' })
    expect(parsePostcardPayload({ kind: 'postcard', payload: { wishId: 'a', text: '  ' } })).toBe(null)
  })
  it('seenKey', () => { expect(seenKey('w1', 'ch1')).toBe('w1:ch1') })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/wish.test.ts`
Expected: FAIL — cannot find module `./wish`

- [ ] **Step 3: 实现**

`src/core/wish.ts`:

```ts
/**
 * wish.ts — 「心愿」:伙伴替主人去问认识的人,纯函数部分
 * (spec 2026-09-04-wish-postcard-design §1)。
 *
 * 心愿是一种信封(kind='wish'),回来的明信片是另一种(kind='postcard'),
 * 都走已有的 E2E 信道 —— 和串门同一个形状。这里只定义:状态怎么走、载荷长
 * 什么样;不碰传输,不碰存储。
 *
 * 状态:draft ─派─▶ open ─7 天─▶ expired;draft ─取消─▶ cancelled;open ─取消─▶ closed。
 * 「expired」不是存的状态,是 open + 过了 expiresAt 的派生视图。
 */
import { randomBytes } from 'node:crypto'
import type { Envelope } from './envelope'

export type WishStatus = 'draft' | 'open' | 'closed' | 'cancelled'

export interface WishRecord {
  id: string
  /** 主人原话(只留在本机)。 */
  text: string
  /** 过了披露门的版本 —— 发出去的是它。 */
  redacted: string
  status: WishStatus
  createdAt: string
  sentAt: string | null
  expiresAt: string | null
  /** 派给了几条信道(投出去就算,信箱是 store-and-forward)。 */
  sentTo: number
  replies: number
}

export const WISH_TTL_MS = 7 * 24 * 60 * 60_000
export const MAX_OPEN_WISHES = 3

export interface WishPayload { id: string; text: string; expiresAt: string }
export interface PostcardPayload { wishId: string; text: string }

export function newWishId(): string {
  return randomBytes(4).toString('hex')
}

export function isExpired(w: WishRecord, nowMs: number): boolean {
  return w.status === 'open' && w.expiresAt !== null && Date.parse(w.expiresAt) < nowMs
}

export function effectiveStatus(w: WishRecord, nowMs: number): WishStatus | 'expired' {
  return isExpired(w, nowMs) ? 'expired' : w.status
}

export function openCount(list: readonly WishRecord[], nowMs: number): number {
  return list.filter(w => effectiveStatus(w, nowMs) === 'open').length
}

export function draftWish(list: readonly WishRecord[], a: { id: string; text: string; redacted: string; nowIso: string }): WishRecord[] {
  return [...list, { id: a.id, text: a.text, redacted: a.redacted, status: 'draft', createdAt: a.nowIso, sentAt: null, expiresAt: null, sentTo: 0, replies: 0 }]
}

const replace = (list: readonly WishRecord[], w: WishRecord): WishRecord[] => list.map(x => (x.id === w.id ? w : x))

export function sendWish(list: readonly WishRecord[], id: string, nowIso: string, sentTo: number):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'not_draft' | 'too_many_open' } {
  const w = list.find(x => x.id === id)
  if (!w) return { ok: false, reason: 'not_found' }
  if (w.status !== 'draft') return { ok: false, reason: 'not_draft' }
  if (openCount(list, Date.parse(nowIso)) >= MAX_OPEN_WISHES) return { ok: false, reason: 'too_many_open' }
  const wish: WishRecord = { ...w, status: 'open', sentAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + WISH_TTL_MS).toISOString(), sentTo }
  return { ok: true, wish, list: replace(list, wish) }
}

export function cancelWish(list: readonly WishRecord[], id: string):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'not_found' | 'already_done' } {
  const w = list.find(x => x.id === id)
  if (!w) return { ok: false, reason: 'not_found' }
  if (w.status === 'closed' || w.status === 'cancelled') return { ok: false, reason: 'already_done' }
  const wish: WishRecord = { ...w, status: w.status === 'draft' ? 'cancelled' : 'closed' }
  return { ok: true, wish, list: replace(list, wish) }
}

/** 收到一张明信片。closed 也收 —— 人家已经答了;只有过期和不认识的才拒。 */
export function acceptPostcard(list: readonly WishRecord[], wishId: string, nowMs: number):
  { ok: true; wish: WishRecord; list: WishRecord[] } | { ok: false; reason: 'unknown' | 'expired' } {
  const w = list.find(x => x.id === wishId && x.sentAt !== null)
  if (!w) return { ok: false, reason: 'unknown' }
  if (w.expiresAt !== null && Date.parse(w.expiresAt) < nowMs) return { ok: false, reason: 'expired' }
  const wish: WishRecord = { ...w, replies: w.replies + 1 }
  return { ok: true, wish, list: replace(list, wish) }
}

/** 主人只会打编号开头。限定状态,免得「取消」打到草稿、「派」打到已开的。 */
export function resolveWishRef(list: readonly WishRecord[], ref: string, among: readonly WishStatus[]):
  { ok: true; id: string } | { ok: false; reason: 'not_found' | 'ambiguous' } {
  const hits = list.filter(w => among.includes(w.status) && w.id.startsWith(ref.toLowerCase()))
  if (hits.length === 0) return { ok: false, reason: 'not_found' }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, id: hits[0]!.id }
}

export function recentWishes(list: readonly WishRecord[], nowMs: number, days = 30): WishRecord[] {
  const since = nowMs - days * 24 * 60 * 60_000
  return list.filter(w => Date.parse(w.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function wishEnvelope(w: WishRecord): Envelope<WishPayload> {
  return { kind: 'wish', payload: { id: w.id, text: w.redacted, expiresAt: w.expiresAt ?? '' } }
}

export function parseWishPayload(env: Envelope): WishPayload | null {
  if (env.kind !== 'wish') return null
  const p = env.payload as Partial<WishPayload> | null
  if (!p || typeof p.id !== 'string' || typeof p.text !== 'string' || typeof p.expiresAt !== 'string') return null
  if (p.id === '' || p.text.trim() === '' || Number.isNaN(Date.parse(p.expiresAt))) return null
  return { id: p.id, text: p.text, expiresAt: p.expiresAt }
}

export function postcardEnvelope(wishId: string, text: string): Envelope<PostcardPayload> {
  return { kind: 'postcard', payload: { wishId, text: text.trim() } }
}

export function parsePostcardPayload(env: Envelope): PostcardPayload | null {
  if (env.kind !== 'postcard') return null
  const p = env.payload as Partial<PostcardPayload> | null
  if (!p || typeof p.wishId !== 'string' || typeof p.text !== 'string' || p.wishId === '' || p.text.trim() === '') return null
  return { wishId: p.wishId, text: p.text.trim() }
}

export function seenKey(wishId: string, channelRowId: string): string {
  return `${wishId}:${channelRowId}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/wish.test.ts && bun run typecheck`
Expected: PASS;typecheck 干净。

- [ ] **Step 5: 提交**

```bash
git add src/core/wish.ts src/core/wish.test.ts
git commit -m "心愿状态机 wish.ts:draft/open/closed/expired + 两种信封载荷 —— 派心愿改写成信封的纯函数部分"
```

---

### Task 2: `wishes.json` / `wishes-seen.json` 存取

**Files:**
- Create: `src/daemon/companion/wish-memory.ts`
- Test: `src/daemon/companion/wish-memory.test.ts`

**Interfaces:**
- Consumes: `WishRecord`(Task 1),`readJsonFile`(`src/lib/read-json-file.ts`)。
- Produces:

```ts
export function readWishes(stateDir: string): WishRecord[]                 // 缺 / 坏 → []
export function writeWishes(stateDir: string, list: readonly WishRecord[]): void
export const WISH_SEEN_TTL_MS: number                                        // 14 天
/** 记一个幂等键;已存在 → false(重复投递),否则写入并顺手清掉 14 天前的 → true。 */
export function markWishSeen(stateDir: string, key: string, nowIso: string): boolean
```

文件:`<stateDir>/companion/wishes.json` = `{ wishes: WishRecord[] }`;`<stateDir>/companion/wishes-seen.json` = `{ seen: Record<string, string> }`。写法照 `src/daemon/companion/neighbor-memory.ts`(mkdir recursive + writeFileSync JSON)。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWishes, writeWishes, markWishSeen, WISH_SEEN_TTL_MS } from './wish-memory'
import type { WishRecord } from '../../core/wish'

const dir = () => mkdtempSync(join(tmpdir(), 'wishmem-'))
const w: WishRecord = { id: 'abcd1234', text: 't', redacted: 't', status: 'draft', createdAt: '2026-09-04T10:00:00.000Z', sentAt: null, expiresAt: null, sentTo: 0, replies: 0 }

describe('wishes.json', () => {
  it('没文件 → [];写了读回来;坏 JSON / 形状不对 → []', () => {
    const d = dir()
    expect(readWishes(d)).toEqual([])
    writeWishes(d, [w])
    expect(readWishes(d)).toEqual([w])
    writeFileSync(join(d, 'companion', 'wishes.json'), '{oops')
    expect(readWishes(d)).toEqual([])
    writeFileSync(join(d, 'companion', 'wishes.json'), JSON.stringify({ wishes: 'nope' }))
    expect(readWishes(d)).toEqual([])
  })
  it('容忍 BOM(PowerShell 写的文件)', () => {
    const d = dir(); mkdirSync(join(d, 'companion'), { recursive: true })
    writeFileSync(join(d, 'companion', 'wishes.json'), '﻿' + JSON.stringify({ wishes: [w] }))
    expect(readWishes(d)).toEqual([w])
  })
})

describe('wishes-seen.json', () => {
  it('第一次 true,第二次 false;14 天前的键被清掉', () => {
    const d = dir()
    expect(markWishSeen(d, 'w1:ch', '2026-09-04T10:00:00.000Z')).toBe(true)
    expect(markWishSeen(d, 'w1:ch', '2026-09-04T10:00:01.000Z')).toBe(false)
    const later = new Date(Date.parse('2026-09-04T10:00:00.000Z') + WISH_SEEN_TTL_MS + 1000).toISOString()
    expect(markWishSeen(d, 'w2:ch', later)).toBe(true)
    // w1 已被清:再记一次又是 true
    expect(markWishSeen(d, 'w1:ch', later)).toBe(true)
  })
  it('坏文件当空', () => {
    const d = dir(); mkdirSync(join(d, 'companion'), { recursive: true })
    writeFileSync(join(d, 'companion', 'wishes-seen.json'), 'garbage')
    expect(markWishSeen(d, 'k', '2026-09-04T10:00:00.000Z')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/companion/wish-memory.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: 实现**

```ts
/**
 * wish-memory.ts — 心愿的本机索引与收件幂等记录(spec 2026-09-04-wish-postcard §1.2/§1.3)。
 *
 * 发出去的心愿真相在 penpal_letter(direction=out, kind=wish);这里是它的索引
 * + 还没派的草稿。收件方的 wishes-seen 是幂等键:信箱 at-least-once,同一条
 * 心愿可能到两次,判官不能跑两次、主人不能被打扰两次。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { WishRecord } from '../../core/wish'

export const WISH_SEEN_TTL_MS = 14 * 24 * 60 * 60_000

const dirOf = (stateDir: string) => join(stateDir, 'companion')
const wishesPath = (stateDir: string) => join(dirOf(stateDir), 'wishes.json')
const seenPath = (stateDir: string) => join(dirOf(stateDir), 'wishes-seen.json')

function writeJson(path: string, dir: string, value: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

export function readWishes(stateDir: string): WishRecord[] {
  try {
    const raw = readJsonFile<{ wishes?: unknown }>(wishesPath(stateDir))
    return Array.isArray(raw.wishes) ? (raw.wishes as WishRecord[]) : []
  } catch { return [] }
}

export function writeWishes(stateDir: string, list: readonly WishRecord[]): void {
  writeJson(wishesPath(stateDir), dirOf(stateDir), { wishes: list })
}

function readSeen(stateDir: string): Record<string, string> {
  try {
    const raw = readJsonFile<{ seen?: unknown }>(seenPath(stateDir))
    return raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? (raw.seen as Record<string, string>) : {}
  } catch { return {} }
}

export function markWishSeen(stateDir: string, key: string, nowIso: string): boolean {
  const nowMs = Date.parse(nowIso)
  const seen = readSeen(stateDir)
  const kept: Record<string, string> = {}
  for (const [k, at] of Object.entries(seen)) {
    const t = Date.parse(at)
    if (!Number.isNaN(t) && nowMs - t <= WISH_SEEN_TTL_MS) kept[k] = at
  }
  if (kept[key] !== undefined) { writeJson(seenPath(stateDir), dirOf(stateDir), { seen: kept }); return false }
  kept[key] = nowIso
  writeJson(seenPath(stateDir), dirOf(stateDir), { seen: kept })
  return true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/companion/wish-memory.test.ts src/lib/read-json-file.test.ts && bun run typecheck`
Expected: PASS(仓库守卫也绿)。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/companion/wish-memory.ts src/daemon/companion/wish-memory.test.ts
git commit -m "心愿索引 wishes.json + 收件幂等 wishes-seen.json —— 不建表,照 neighbors.json 的做法"
```

---

### Task 3: journal 加 `postcard` kind(daemon + 桌面卡片)

**Files:**
- Modify: `src/core/journal-store.ts`(`CatchKind`、`Journal.recordPostcard`)
- Modify: `apps/desktop/src/modules/journal.js`(`renderCard` 分支、`countLabel`)
- Test: `src/core/journal-store.test.ts`、`apps/desktop/src/modules/journal.test.ts`

**Interfaces:**
- Produces:
  - `export type CatchKind = 'hunt' | 'visit' | 'postcard'`
  - `Journal.recordPostcard(args: { chatId: string; text: string; peerLabel: string; nowIso?: string }): string | null` — 一张一条,title = `${peerLabel} 回了你的心愿`,kind `postcard`,status `new`,无 url / image。
  - 桌面:kind `postcard` 的卡片(📮 前缀、无状态档、无链接)、`countLabel` 多一桶「N 张明信片」。

- [ ] **Step 1: 写失败测试(store)**

`src/core/journal-store.test.ts` 末尾追加:

```ts
describe('recordPostcard —— 别人回心愿的明信片', () => {
  it('一张一条,kind=postcard,标题带对方;空文本不记;summary 的 latest 认得它', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.recordPostcard({ chatId: 'o', text: '   ', peerLabel: '阿一' })).toBe(null)
    const id = j.recordPostcard({ chatId: 'o', text: '我朋友周末常去', peerLabel: '阿一', nowIso: '2026-09-04T10:00:00.000Z' })
    expect(id).toMatch(/:postcard:/)
    const row = j.list()[0]!
    expect(row).toMatchObject({ kind: 'postcard', title: '阿一 回了你的心愿', note: '我朋友周末常去', status: 'new', url: null })
    expect(j.summary(null).latest?.kind).toBe('postcard')
  })
})
```

- [ ] **Step 2: 写失败测试(桌面)**

`apps/desktop/src/modules/journal.test.ts` 末尾追加(文件顶部已有 `renderHuntBag` / `countLabel` 的解构 import 和 DOM stub;`item()` 是已有的造数助手):

```ts
describe('明信片卡(kind=postcard)', () => {
  it('渲染成 📮 卡,没有状态档、没有链接;计数多一桶', () => {
    els.set('fd-catch', mkEl()); els.set('fd-catch-count', mkEl())
    renderHuntBag({ items: [
      item({ id: 'p1', kind: 'postcard', title: '阿一 回了你的心愿', note: '我朋友周末常去' }),
      item({ id: 'h1', kind: 'hunt', title: 'x', url: 'https://a.com' }),
    ] })
    const html = els.get('fd-catch')!.innerHTML
    expect(html).toContain('hb-postcard-card')
    expect(html).toContain('📮 阿一 回了你的心愿')
    expect(html).not.toContain('data-hb-status="tried"')
    expect(countLabel([{ kind: 'postcard' } as never, { kind: 'hunt' } as never, { kind: 'visit' } as never])).toBe('1 件 · 1 段见闻 · 1 张明信片')
  })
})
```

(若 `els` / `mkEl` / `item` 的名字与文件里不同,以文件为准改名。)

- [ ] **Step 3: 跑测试确认失败**

Run: `bun --bun vitest run src/core/journal-store.test.ts apps/desktop/src/modules/journal.test.ts`
Expected: FAIL — `recordPostcard is not a function` / 卡片类名不存在

- [ ] **Step 4: 实现 store**

`src/core/journal-store.ts`:
- `export type CatchKind = 'hunt' | 'visit' | 'postcard'`,注释加一句「'postcard' = 别人回心愿的明信片(spec 2026-09-04-wish-postcard)」。
- 接口加 `recordPostcard(args: { chatId: string; text: string; peerLabel: string; nowIso?: string }): string | null`。
- `makeJournal` 里加一条 prepared insert(和 `insVisit` 并排):

```ts
  const insPostcard = db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind, image_svg)
     VALUES (?, ?, ?, ?, NULL, ?, 'new', 'postcard', NULL)`,
  )
```

返回对象里加:

```ts
    recordPostcard({ chatId, text, peerLabel, nowIso }) {
      const ts = nowIso ?? new Date().toISOString()
      const body = text.trim()
      if (body === '') return null
      const id = `${ts}:postcard:${Math.random().toString(36).slice(2, 8)}`
      insPostcard.run(id, ts, chatId, `${peerLabel} 回了你的心愿`, body)
      prune.run(PRUNE_KEEP)
      return id
    },
```

- [ ] **Step 5: 实现桌面卡片**

`apps/desktop/src/modules/journal.js`:
- `renderCard` 开头加分支 `if (it.kind === 'postcard') return renderPostcardCard(it)`(放在 `visit` 分支旁)。
- 新函数(放在 `renderVisitCard` 之后):

```js
/** 明信片卡(kind='postcard'):别人的伙伴回了你的心愿。没有链接,也没有状态档。 */
function renderPostcardCard(it) {
  return `<article class="hb-card hb-postcard-card" data-hb-id="${escapeHtml(it.id)}">
    <div class="hb-head">
      <h3 class="hb-title">📮 ${escapeHtml(it.title || '明信片')}</h3>
      <span class="hb-day">${escapeHtml(dayLabel(it.ts))}</span>
    </div>
    <p class="hb-note">${escapeHtml(it.note || '')}</p>
    <div class="hb-foot hb-foot-visit">
      <button class="hb-del" data-hb-action="remove" data-hb-id="${escapeHtml(it.id)}" type="button" title="从背包里删掉">×</button>
    </div>
  </article>`
}
```

- `countLabel` 改成三桶:

```js
export function countLabel(kept) {
  const things = kept.filter(i => i.kind !== 'visit' && i.kind !== 'postcard').length
  const visits = kept.filter(i => i.kind === 'visit').length
  const cards = kept.filter(i => i.kind === 'postcard').length
  const parts = []
  if (things) parts.push(`${things} 件`)
  if (visits) parts.push(`${visits} 段见闻`)
  if (cards) parts.push(`${cards} 张明信片`)
  return parts.join(' · ')
}
```

- `apps/desktop/src/styles.css`:在 `.hb-visit` 规则旁加 `.hb-postcard-card .hb-title { color: var(--fd-accent, inherit); }`(一行,只是让明信片标题和见闻有区别;没有 `--fd-accent` 变量就用 `inherit`,别新造颜色)。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun --bun vitest run src/core/journal-store.test.ts apps/desktop/src/modules/journal.test.ts apps/desktop/src/companion-scene-state.test.ts && bun run typecheck`
Expected: PASS(`sceneStateFrom` 早已把 `latest_kind === 'postcard'` 映射成明信片道具,不用改)。

- [ ] **Step 7: 提交**

```bash
git add src/core/journal-store.ts src/core/journal-store.test.ts apps/desktop/src/modules/journal.js apps/desktop/src/modules/journal.test.ts apps/desktop/src/styles.css
git commit -m "journal 加 postcard kind:别人回心愿的明信片进「带回来的」—— 桌宠包袱自动认得"
```

---

### Task 4: 配对即开信道(6 位配对码 PairCard v2)

**Files:**
- Modify: `src/core/pairing.ts`(`PairCard`、`PairingDeps`、`isValidCard`、`start()`、`accept()`、新 `openPairChannel`)
- Modify: `src/daemon/bootstrap/wire-pairing.ts`(注入 `channelStore` + `genChannel`)
- Test: `src/core/pairing.test.ts`(扩 `baseDeps` + 追加 describe)

**Interfaces:**
- Consumes: `ChannelStore`(`src/core/penpal-channel-store.ts`:`create / setPeerHandle / setStatus / list`),`generateKeypair()`(`src/core/penpal-crypto.ts`,返回 `{ publicKey, privateKey }` base64url DER —— 以文件为准取字段名),`randomUUID`。
- Produces:
  - `PairCard.v: 2`,新增 `channel_id: string`、`channel_pub: string`。
  - `PairingDeps.channelStore: Pick<ChannelStore, 'create' | 'setPeerHandle' | 'setStatus' | 'list'>`;`PairingDeps.genChannel: () => { channelId: string; pubkey: string; privkey: string }`。
  - 配对成功后双方各有一条 `penpal_channel` 行:`id = 'pair:' + card.nonce`,`degree 1`,`peer_agent_id = 对方 self_id`,`status open`,`peer_mailbox` 带对方 `{addr, enc_pub, relays}`。
  - 已有同 `peer_agent_id` 的 open 信道 → 不再建第二条。
  - `v !== 2` 或缺 channel 字段的 card → `isValidCard` 为 false(旧对端的 card 被忽略;`accept` 于是报 `no_card` / 超时,和现在遇到坏 card 的行为一样)。

- [ ] **Step 1: 写失败测试**

`src/core/pairing.test.ts`:先在 `baseDeps(over)` 返回的对象里加两项(其它字段照旧):

```ts
    channelStore: makeFakeChannelStore(),
    genChannel: (() => { let n = 0; return () => { n++; return { channelId: `chan-${n}`, pubkey: `PUB${n}`, privkey: `PRIV${n}` } } })(),
```

并在 `makeFakeRegistry` 旁加:

```ts
type FakeChan = { id: string; seekId: string; myPrivkey: string; myPubkey: string; myChannelId: string; degree: number; peerAgentId: string | null; status: 'pending' | 'open'; peer: unknown }
function makeFakeChannelStore(): PairingDeps['channelStore'] & { rows: FakeChan[] } {
  const rows: FakeChan[] = []
  return {
    rows,
    create: (c) => { rows.push({ id: c.id, seekId: c.seekId, myPrivkey: c.myPrivkey, myPubkey: c.myPubkey, myChannelId: c.myChannelId, degree: c.degree, peerAgentId: c.peerAgentId ?? null, status: 'pending', peer: null }) },
    setPeerHandle: (id, h) => { const r = rows.find(x => x.id === id); if (r) r.peer = h },
    setStatus: (id, s) => { const r = rows.find(x => x.id === id); if (r) r.status = s },
    list: () => rows.map(r => ({ id: r.id, seek_id: r.seekId, my_privkey: r.myPrivkey, my_pubkey: r.myPubkey, my_channel_id: r.myChannelId, peer_pubkey: null, peer_channel_id: null, peer_mailbox: null, degree: r.degree, relay_via: null, peer_agent_id: r.peerAgentId, status: r.status, created_at: '' })) as never,
  }
}
```

然后在文件末尾追加(用文件里已有的 `makeFakeRelay` / `makeManualScheduler` / `mustStart` / `baseDeps` 把两端接到同一个 relay 上;若文件里已有一个「两端配对成功」的 happy-path 测试,照它的搭法):

```ts
describe('配对即开信道(spec 2026-09-04-wish-postcard §2)', () => {
  function pairBoth() {
    const relay = makeFakeRelay()
    const sA = makeManualScheduler(), sB = makeManualScheduler()
    const chanA = makeFakeChannelStore(), chanB = makeFakeChannelStore()
    const A = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-aaaa0001', name: () => 'A', self: { mailbox_addr: 'MA', mailbox_enc_pub: 'EA', relays: ['https://r/mailbox'] }, schedule: sA.schedule, channelStore: chanA, genNonce: () => 'n0nce' }))
    const B = makePairing(baseDeps({ client: relay.client, selfId: () => 'cc-bbbb0002', name: () => 'B', self: { mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'] }, schedule: sB.schedule, channelStore: chanB }))
    return { A, B, sA, chanA, chanB }
  }

  it('双方 card 带 channel 字段;完成后各一条 open 信道,peer_agent_id 互指,peer_mailbox 是对方的', async () => {
    const { A, B, sA, chanA, chanB } = pairBoth()
    const { code } = await mustStart(A)
    const r = await B.accept(code)
    expect(r.ok).toBe(true)
    sA.tick()                       // initiator 轮询到 acceptor 的 card
    await new Promise(r => setTimeout(r, 0))
    expect(chanB.rows).toHaveLength(1)
    expect(chanB.rows[0]).toMatchObject({ id: 'pair:n0nce', degree: 1, peerAgentId: 'cc-aaaa0001', status: 'open' })
    expect(chanB.rows[0]!.peer).toMatchObject({ channel_id: 'chan-1', pubkey: 'PUB1', mailbox: { addr: 'MA', enc_pub: 'EA' } })
    expect(chanA.rows).toHaveLength(1)
    expect(chanA.rows[0]).toMatchObject({ id: 'pair:n0nce', peerAgentId: 'cc-bbbb0002', status: 'open' })
    expect(chanA.rows[0]!.peer).toMatchObject({ mailbox: { addr: 'MB', enc_pub: 'EB' } })
  })

  it('同一对端已有 open 信道 → 重新配对不建第二条', async () => {
    const { A, B, sA, chanB } = pairBoth()
    chanB.rows.push({ id: 'pair:old', seekId: 'pair:old', myPrivkey: 'p', myPubkey: 'P', myChannelId: 'c', degree: 1, peerAgentId: 'cc-aaaa0001', status: 'open', peer: null })
    const { code } = await mustStart(A)
    expect((await B.accept(code)).ok).toBe(true)
    sA.tick(); await new Promise(r => setTimeout(r, 0))
    expect(chanB.rows).toHaveLength(1)
  })

  it('v1 旧 card(没有 channel 字段)不被认可', async () => {
    const relay = makeFakeRelay()
    const B = makePairing(baseDeps({ client: relay.client }))
    // 手工往 rendezvous 信箱塞一张 v1 initiator card,再 accept 同一个 code
    const code = '123456'
    const rv = deriveRendezvous(code)   // 以 pairing-crypto 的实际签名为准
    const v1 = { v: 1, role: 'initiator', nonce: 'x', self_id: 'cc-old00001', name: 'old', mailbox_addr: 'MO', mailbox_enc_pub: 'EO', relays: ['https://r/mailbox'], bearer: 'b' }
    await relay.client.drop('https://r/mailbox', rv.addr, sealEnvelope(v1 as never, rv.encPub as never) as never)
    const r = await B.accept(code)
    expect(r.ok).toBe(false)
  })
})
```

`deriveRendezvous` / `sealEnvelope` 的确切参数以文件顶部已有测试的用法为准(它们已在 import 里)。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/pairing.test.ts -t 配对即开信道`
Expected: FAIL(`channelStore` 不在 deps 类型上 / 没建信道)

- [ ] **Step 3: 实现**

`src/core/pairing.ts`:

(a) `PairCard`:`v: 2`;加 `channel_id: string` 与 `channel_pub: string`(注释:「我的收信地址 / X25519 公钥 —— 配对完直接开 E2E 信道,不再靠揭晓」)。

(b) `PairingDeps` 加:

```ts
  /** 配对即开信道(spec 2026-09-04-wish-postcard §2)。 */
  channelStore: Pick<import('./penpal-channel-store').ChannelStore, 'create' | 'setPeerHandle' | 'setStatus' | 'list'>
  /** 生成我方信道句柄:X25519 密钥对 + 收信地址。 */
  genChannel: () => { channelId: string; pubkey: string; privkey: string }
```

(c) `ownCard(...)` 加一个参数 `chan: { channelId: string; pubkey: string }`,输出 `v: 2, channel_id: chan.channelId, channel_pub: chan.pubkey`。

(d) `isValidCard`:`c.v === 2`,并校验 `channel_id` / `channel_pub` 为非空字符串。

(e) 新增(放在 `writePeerFromCard` 之后):

```ts
  /**
   * 配对完成即开信道:双方各建一条 open 的 penpal_channel,peer_agent_id 互指。
   * 同一对端已有 open 信道就不重建 —— 重新配对是为了修注册表,不是为了多一条信道。
   */
  function openPairChannel(card: PairCard, mine: { channelId: string; pubkey: string; privkey: string }): void {
    const exists = deps.channelStore.list().some(r => r.status === 'open' && r.peer_agent_id === card.self_id)
    if (exists) return
    const rowId = `pair:${card.nonce}`
    deps.channelStore.create({ id: rowId, seekId: rowId, myPrivkey: mine.privkey, myPubkey: mine.pubkey, myChannelId: mine.channelId, degree: 1, peerAgentId: card.self_id })
    deps.channelStore.setPeerHandle(rowId, { pubkey: card.channel_pub, channel_id: card.channel_id, mailbox: { addr: card.mailbox_addr, enc_pub: card.mailbox_enc_pub, relays: card.relays } })
    deps.channelStore.setStatus(rowId, 'open')
  }
```

(f) `start()`:生成 `const mine = deps.genChannel()` 一次,传给 `ownCard`;轮询 `tick()` 里 `writePeerFromCard(card, key)` 成功之后调 `openPairChannel(card, mine)`。`accept()`:同样先 `const mine = deps.genChannel()`,own card 带它,`writePeerFromCard(initiator, myKey)` 成功之后 `openPairChannel(initiator, mine)`。**顺序**:注册表先写、信道后开;`writePeerFromCard` 返回 `id_conflict` 时不开信道。

`src/daemon/bootstrap/wire-pairing.ts`:import `makeChannelStore`(`../../core/penpal-channel-store`)、`generateKeypair`(`../../core/penpal-crypto`)、`randomUUID`;deps 对象加:

```ts
  channelStore: makeChannelStore(deps.db),
  genChannel: () => { const kp = generateKeypair(); return { channelId: randomUUID(), pubkey: kp.publicKey, privkey: kp.privateKey } },
```

(`generateKeypair` 返回字段名以 `penpal-crypto.ts:40-46` 为准;`wire-pairing` 的 deps 若没有 `db`,从 bootstrap 调用处把 `db` 传进来 —— 看 `bootstrap/index.ts` 里 `wirePairing(` 的实参。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/pairing.test.ts src/core/pairing.integration.test.ts src/core/pairing-crypto.test.ts && bun run typecheck`
Expected: PASS。`pairing.integration.test.ts` 若自己构造 `PairingDeps`,补上同样的两个 fake 字段。

- [ ] **Step 5: 提交**

```bash
git add src/core/pairing.ts src/core/pairing.test.ts src/core/pairing.integration.test.ts src/daemon/bootstrap/wire-pairing.ts
git commit -m "配对即开信道:6 位配对码 PairCard v2 带信道句柄,配对完成双方各开一条 open 信道 —— 揭晓不再是开信道的唯一入口"
```

---

### Task 5: `wire-wish.ts` 交互层 + correspondent 两个 case + 类型露出

**Files:**
- Create: `src/daemon/bootstrap/wire-wish.ts`
- Test: `src/daemon/bootstrap/wire-wish.test.ts`
- Modify: `src/daemon/bootstrap/wire-social.ts`(构造 `wish`、`onInbound` 两个 case、`socialPenpal` 旁露出 `wish`、`SocialWiring.social.wish`)
- Modify: `src/daemon/bootstrap/types.ts`(`Bootstrap.social.wish`)
- Modify: `src/daemon/internal-api/types.ts`(`InternalApiDeps.social.wish?`)

**Interfaces:**
- Consumes: Task 1 全部;Task 2 `readWishes / writeWishes / markWishSeen`;Task 3 `Journal.recordPostcard`;现有 `makeJudge` 的返回 `(card: { topic: string; city?: string }) => Promise<{ match: 'yes' | 'no'; blurb?: string }>`;`gateOutbound`;`correspondent.sendEnvelope`。
- Produces:

```ts
export interface WishDeps {
  stateDir: string
  channelStore: Pick<ChannelStore, 'get' | 'list'>
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string }>
  /** 披露门:返回 ok/redacted/violations(a2a-disclosure.gateOutbound 的裹法由调用方给)。 */
  gate(text: string): Promise<{ ok: boolean; redacted: string; violations: string[] }>
  /** 判官:我主人能不能帮。 */
  judge(topic: string): Promise<{ match: 'yes' | 'no'; blurb?: string }>
  /** 见闻进日志(seeker 侧)。 */
  recordPostcard(a: { text: string; peerLabel: string }): string | null
  notifyOwner(text: string): void
  /** 怎么称呼这条信道那头的人(注册表名字 / 第 N 度的某人)。 */
  peerLabel(channelRowId: string): string
  now?: () => number
  newId?: () => string
  log(tag: string, line: string): void
}
export interface WishService {
  propose(text: string): Promise<{ ok: true; id: string; preview: string } | { ok: false; error: 'gate_failed' | 'checker_unavailable' | 'empty'; violations?: string[] }>
  send(id: string): Promise<{ ok: true; sentTo: number } | { ok: false; reason: 'not_found' | 'not_draft' | 'too_many_open' | 'no_channels' }>
  cancel(id: string): { ok: true; status: 'closed' | 'cancelled' } | { ok: false; reason: 'not_found' | 'already_done' }
  list(): Array<WishRecord & { effective: WishStatus | 'expired' }>
  resolveRef(ref: string, among: readonly WishStatus[]): ReturnType<typeof resolveWishRef>
  /** correspondent 分发进来的 kind='wish' / 'postcard'。不是这两种 → false。 */
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean
}
export function makeWish(deps: WishDeps): WishService
```

行为(照 spec §1.2/§1.3):
- `propose(text)`:空 → `empty`;`gate` 抛错 → `checker_unavailable`;`!ok` → `gate_failed` + violations;否则 `draftWish` 落 wishes.json,返回 `{ id, preview: redacted }`。
- `send(id)`:`sendWish` 校验;`targets = channelStore.list().filter(c => c.status === 'open')`;为空 → `no_channels`(草稿保留);逐条 `sendEnvelope(c.id, wishEnvelope(wish))`,`ok` 计数为 `sentTo`;写回。
- `cancel(id)`:`cancelWish` 写回。
- `list()`:`recentWishes` + `effective`。
- `onInbound` kind=`wish`:`parseWishPayload` 失败 → `log` + `return true`(是我们的 kind,只是坏);过期(`expiresAt < now`)→ log,true;`markWishSeen(seenKey(id, channelRowId))` 为 false → log 重复,true;然后**异步**(`void (async () => …)()`,onInbound 本身同步返回 true):`judge(text)` → `no` → `notifyOwner('🙋 ' + label + ' 的伙伴来打听「' + text + '」,我说不知道')`;`yes` 且 blurb 非空 → `gate(blurb)`,不过门则按「不知道」处理并 log;过门 → `sendEnvelope(channelRowId, postcardEnvelope(id, redacted))` → `notifyOwner('🙋 ' + label + ' 的伙伴来打听「' + text + '」,我回了:' + redacted)`;judge / send 抛错只 log。
- `onInbound` kind=`postcard`:`parsePostcardPayload` 失败 → log,true;`markWishSeen(seenKey('pc:' + wishId, channelRowId))` 为 false → 重复,true;`acceptPostcard(list, wishId, now)`:`unknown` / `expired` → log 丢弃,true;否则写回 wishes.json、`recordPostcard({ text, peerLabel: label })`、`notifyOwner('📮 ' + label + ' 回了你的心愿「' + wish.redacted.slice(0, 20) + '」:' + text)`,true。
- 其它 kind → `false`。

- [ ] **Step 1: 写失败测试**

`src/daemon/bootstrap/wire-wish.test.ts`(照 `wire-visit.test.ts` 的 `side()`:两个 daemon 同进程,`sendEnvelope` 直接把信封塞给对端的 `onInbound`):

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWish, type WishDeps } from './wire-wish'
import { readWishes } from '../companion/wish-memory'
import type { Envelope } from '../../core/envelope'

type Row = { id: string; direction: 'in' | 'out'; kind: string; payload: string | null }
interface Side {
  name: string; stateDir: string; letters: Row[]; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  wish: ReturnType<typeof makeWish>; setPeer(p: Side): void; judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
}
const NOW = { ms: Date.parse('2026-09-04T10:00:00.000Z') }

const ONE_CHANNEL = [{ id: 'ch', status: 'open', degree: 1 }]
function side(name: string, judgeSays: Side['judgeSays'] = { match: 'no' }, gateOk = true, channels: Array<{ id: string; status: string; degree: number }> = ONE_CHANNEL): Side {
  const letters: Row[] = [], owner: string[] = [], logs: string[] = [], journal: Side['journal'] = []
  let peer: Side | null = null
  const self: Side = { name, stateDir: mkdtempSync(join(tmpdir(), 'wish-')), letters, owner, logs, journal, wish: null as never, setPeer: p => { peer = p }, judgeSays }
  const deps: WishDeps = {
    stateDir: self.stateDir,
    channelStore: { get: (id) => channels.find(c => c.id === id) ?? null, list: () => channels } as never,
    sendEnvelope: async (_c, env) => {
      letters.push({ id: `${name}-out-${letters.length}`, direction: 'out', kind: env.kind, payload: JSON.stringify(env.payload) })
      const inId = `${peer!.name}-in-${peer!.letters.length}`
      peer!.letters.push({ id: inId, direction: 'in', kind: env.kind, payload: JSON.stringify(env.payload) })
      if (!peer!.wish.onInbound('ch', env, inId)) peer!.owner.push(`📬 ${env.kind}`)
      return { ok: true }
    },
    gate: async (t) => (gateOk ? { ok: true, redacted: t.replace('我住XX路', ''), violations: [] } : { ok: false, redacted: '', violations: ['住址'] }),
    judge: async () => { if (self.judgeSays instanceof Error) throw self.judgeSays; return self.judgeSays },
    recordPostcard: (a) => { journal.push(a); return `row-${journal.length}` },
    notifyOwner: (t) => owner.push(t),
    peerLabel: () => (name === 'A' ? '阿二' : '阿一'),
    now: () => NOW.ms,
    newId: (() => { let n = 0; return () => `${name.toLowerCase()}${String(++n).padStart(7, '0')}` })(),
    log: (tag, line) => logs.push(`${tag} ${line}`),
  }
  self.wish = makeWish(deps)
  return self
}
const flush = () => new Promise(r => setTimeout(r, 20))

describe('心愿:两只伙伴对着问', () => {
  it('A 派 → B 判「能」→ 明信片回 A:A 日志一条、A 主人一句、B 主人一句、replies=1', async () => {
    const A = side('A'), B = side('B', { match: 'yes', blurb: '我朋友周末常去,我住XX路' })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('找周末爬山搭子')
    expect(p.ok).toBe(true); if (!p.ok) return
    const s = await A.wish.send(p.id)
    expect(s).toEqual({ ok: true, sentTo: 1 })
    await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「找周末爬山搭子」,我回了:我朋友周末常去,'])
    expect(A.journal).toEqual([{ text: '我朋友周末常去,', peerLabel: '阿二' }])
    expect(A.owner).toEqual(['📮 阿二 回了你的心愿「找周末爬山搭子」:我朋友周末常去,'])
    expect(readWishes(A.stateDir)[0]).toMatchObject({ status: 'open', sentTo: 1, replies: 1 })
    expect(A.letters.filter(l => l.direction === 'in').map(l => l.kind)).toEqual(['postcard'])
  })
  it('B 判「不能」→ 静默不回,B 主人仍被告知;A 无变化', async () => {
    const A = side('A'), B = side('B', { match: 'no' }); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我说不知道'])
    expect(A.journal).toEqual([]); expect(A.owner).toEqual([])
  })
  it('B 的判官抛错 → 只记日志,不打扰任何人', async () => {
    const A = side('A'), B = side('B', new Error('provider down')); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual([]); expect(B.logs.some(l => l.includes('provider down'))).toBe(true)
  })
  it('同一条心愿重投 → B 只判一次', async () => {
    const A = side('A'), B = side('B', { match: 'no' }); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    const env: Envelope = { kind: 'wish', payload: JSON.parse(A.letters[0]!.payload!) }
    expect(B.wish.onInbound('ch', env, 'dup')).toBe(true); await flush()
    expect(B.owner).toHaveLength(1)
  })
  it('过期的心愿被 B 丢;A 收到不认识 / 过期 wishId 的明信片丢', async () => {
    const A = side('A'), B = side('B', { match: 'yes', blurb: 'ok' }); A.setPeer(B); B.setPeer(A)
    expect(B.wish.onInbound('ch', { kind: 'wish', payload: { id: 'dead0000', text: 'x', expiresAt: '2020-01-01T00:00:00.000Z' } }, 'l1')).toBe(true)
    await flush(); expect(B.owner).toEqual([])
    expect(A.wish.onInbound('ch', { kind: 'postcard', payload: { wishId: 'nope0000', text: 'hi' } }, 'l2')).toBe(true)
    expect(A.journal).toEqual([])
  })
  it('propose:披露门不过 → gate_failed 带 violations,不存草稿;门抛错 → checker_unavailable', async () => {
    const A = side('A', { match: 'no' }, false)
    expect(await A.wish.propose('我住XX路')).toMatchObject({ ok: false, error: 'gate_failed', violations: ['住址'] })
    expect(readWishes(A.stateDir)).toEqual([])
  })
  it('send:没有开着的信道 → no_channels,草稿保留', async () => {
    const A = side('A', { match: 'no' }, true, [])          // 第 4 个参数:没有任何信道
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    expect(await A.wish.send(p.id)).toEqual({ ok: false, reason: 'no_channels' })
    expect(readWishes(A.stateDir)[0]!.status).toBe('draft')
  })
  it('send:已有 3 条 open → 第 4 条 too_many_open', async () => {
    const A = side('A'), B = side('B'); A.setPeer(B); B.setPeer(A)
    for (let i = 0; i < 3; i++) { const p = await A.wish.propose(`w${i}`); if (!p.ok) throw new Error(); expect((await A.wish.send(p.id)).ok).toBe(true) }
    const p4 = await A.wish.propose('w4'); if (!p4.ok) throw new Error()
    expect(await A.wish.send(p4.id)).toEqual({ ok: false, reason: 'too_many_open' })
  })
  it('cancel:draft → cancelled,open → closed;list 带 effective', async () => {
    const A = side('A'); A.setPeer(side('B'))
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    expect(A.wish.cancel(p.id)).toEqual({ ok: true, status: 'cancelled' })
    const q = await A.wish.propose('y'); if (!q.ok) throw new Error()
    await A.wish.send(q.id)
    expect(A.wish.cancel(q.id)).toEqual({ ok: true, status: 'closed' })
    expect(A.wish.list().map(w => w.effective)).toEqual(['closed', 'cancelled'])
  })
  it('不是 wish / postcard 的信封 → false', () => {
    expect(side('A').wish.onInbound('ch', { kind: 'letter', payload: {} }, 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-wish.test.ts`
Expected: FAIL — cannot find module `./wire-wish`

- [ ] **Step 3: 实现 `wire-wish.ts`**

按上面 Interfaces 与行为逐条实现(结构照 `wire-visit.ts`:文件头 WHY 注释、`makeWish(deps)` 返回对象、内部小函数 `handleWish` / `handlePostcard`、所有失败只 `deps.log('WISH', …)`)。要点:
- 状态读写:每次操作 `readWishes(stateDir)` → 纯函数 → `writeWishes`。不缓存(和 neighbors.json 一样,量小)。
- `now` 默认 `Date.now`,`newId` 默认 `newWishId`。
- `onInbound` 对 `wish` 的重活放进 `void (async () => { … })().catch(err => deps.log('WISH', …))`,函数本身同步返回 `true`。

- [ ] **Step 4: 接进 wire-social + 类型**

`src/daemon/bootstrap/wire-social.ts`:
- import `makeWish` from `./wire-wish`;
- 在 `visit = makeVisit({...})` 之后:

```ts
      const wish = makeWish({
        stateDir: deps.stateDir,
        channelStore,
        sendEnvelope: (c, e) => correspondent.sendEnvelope(c, e),
        gate: (text) => gateOutbound(text, { policy: socialPolicy, cheapEval: socialCheapEval, timeoutMs: cheapEvalBudgetMs }),
        judge: (topic) => socialJudge({ topic }),
        recordPostcard: ({ text, peerLabel }) => { const op = resolveOperatorChatId(); return op ? makeJournal(deps.db).recordPostcard({ chatId: op, text, peerLabel }) : null },
        notifyOwner: (text) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, text) },
        peerLabel: (channelRowId) => {
          const ch = channelStore.get(channelRowId)
          const name = ch?.peer_agent_id ? a2aRegistry.get(ch.peer_agent_id)?.name : undefined
          return name || (ch ? `第 ${ch.degree} 度的某人` : '某人')
        },
        log: deps.log,
      })
```

(`socialPolicy` / `socialCheapEval` / `cheapEvalBudgetMs` / `socialJudge` / `a2aRegistry` 都是该文件里已有的名字;以文件为准。`gateOutbound` 的第二参数形状照 `a2a-disclosure.ts:24`。)
- `onInbound` 的 switch 加:

```ts
    case 'wish':
    case 'postcard':
      if (!wish.onInbound(channelRowId, env, letterId)) deps.log('SOCIAL', `${env.kind} envelope rejected channel=${channelRowId}`)
      return
```

- `socialPenpal = {...}` 旁边加 `socialWish = { propose: (t) => wish.propose(t), send: (id) => wish.send(id), cancel: (id) => wish.cancel(id), list: () => wish.list(), resolveRef: (r, a) => wish.resolveRef(r, a) }`(前面对应加一个 `let socialWish: … | undefined`),并在返回的 `social: {...}` 对象里加 `wish: socialWish!`。
- `SocialWiring.social` 加 `wish: import('./wire-wish').WishService`(去掉 `onInbound`,用 `Omit<WishService, 'onInbound'>`)。

`src/daemon/bootstrap/types.ts` `Bootstrap.social` 加同样的 `wish: Omit<import('./wire-wish').WishService, 'onInbound'>`。
`src/daemon/internal-api/types.ts` `InternalApiDeps.social` 加 `wish?: Omit<import('../bootstrap/wire-wish').WishService, 'onInbound'>`(可选:老 fixture 没有)。

- [ ] **Step 5: 跑测试 + typecheck**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-wish.test.ts src/daemon/bootstrap/wire-visit.test.ts src/daemon/bootstrap/wire-social.mailbox.test.ts src/daemon/bootstrap/bootstrap.test.ts && bun run typecheck`
Expected: PASS。若某个手工构造 `boot.social` 的夹具报缺 `wish`,给它 `wish: { propose: async () => ({ ok: false, error: 'empty' }), send: async () => ({ ok: false, reason: 'not_found' }), cancel: () => ({ ok: false, reason: 'not_found' }), list: () => [], resolveRef: () => ({ ok: false, reason: 'not_found' }) }`。

- [ ] **Step 6: 提交**

```bash
git add src/daemon/bootstrap/wire-wish.ts src/daemon/bootstrap/wire-wish.test.ts src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/types.ts src/daemon/internal-api/types.ts
git commit -m "wire-wish:心愿 / 明信片两个信封 case 接进 correspondent —— 判官 + 披露门 + 日志 + 两边主人各一句话"
```

---

### Task 6: 路由 / MCP 工具 / CLI 切到心愿

**Files:**
- Modify: `src/daemon/internal-api/routes-social.ts`(删 seek/echoes/pledges/reveal 路由,加 4 条 wish 路由)
- Modify: `src/daemon/internal-api/route-tiers.ts`(对应增删)
- Modify: `src/mcp-servers/wechat/tools-social.ts`(打 `/v1/social/wish`)
- Modify: `src/cli/social.ts`(删 seeks/echoes/pledges/reveal/propose/confirm/cancel 子命令,加 `wishes`)
- Test: `src/daemon/internal-api/routes-social.test.ts`(重写为 wish 用例)、`src/daemon/internal-api/route-tiers.test.ts`、`src/cli/social.test.ts`、`src/mcp-servers/wechat/*social*.test.ts`(若有)

**Interfaces:**
- Consumes: `deps.social.wish`(Task 5)。
- Produces(spec §4):
  - `POST /v1/social/wish {text}` → 200 `{ ok: true, id, preview }` | 200 `{ ok: false, error, violations? }`;400 `missing_text`;503 `social_not_wired`。
  - `POST /v1/social/wish/send {id}` → 200 `{ ok: true, sent_to }` | 200 `{ ok: false, reason }`;400 `missing_id`。
  - `POST /v1/social/wish/cancel {id}` → 200 `{ ok: true, status }` | 200 `{ ok: false, reason }`。
  - `GET /v1/social/wishes` → 200 `{ wishes: [{ id, text, status, created_at, expires_at, sent_to, replies }] }`(`status` 用 `effective`;`text` 给 `redacted`)。
  - 四条 tier **trusted**。旧的 `seek/*` `seeks` `echoes` `echoes/reveal` `pledges` `pledges/reveal` 路由与 tier 条目删除。

- [ ] **Step 1: 写失败测试**

`src/daemon/internal-api/routes-social.test.ts`:删掉 seek / echo / pledge / reveal 的 describe,保留 visit / inbound / enable 的(若有);追加:

```ts
describe('/v1/social/wish*', () => {
  const wish = {
    propose: vi.fn(async (t: string) => (t === 'bad' ? { ok: false as const, error: 'gate_failed' as const, violations: ['住址'] } : { ok: true as const, id: 'abcd1234', preview: t })),
    send: vi.fn(async (id: string) => (id === 'abcd1234' ? { ok: true as const, sentTo: 2 } : { ok: false as const, reason: 'not_found' as const })),
    cancel: vi.fn((id: string) => (id === 'abcd1234' ? { ok: true as const, status: 'closed' as const } : { ok: false as const, reason: 'not_found' as const })),
    list: vi.fn(() => [{ id: 'abcd1234', text: '原文', redacted: '脱敏', status: 'open' as const, effective: 'open' as const, createdAt: 'c', sentAt: 's', expiresAt: 'e', sentTo: 2, replies: 1 }]),
    resolveRef: vi.fn(),
  }
  const deps = { social: { wish } } as unknown as InternalApiDeps
  const r = socialRoutes(deps)
  it('propose 过门 → id + preview;不过门 → ok:false + violations;缺 text → 400', async () => {
    expect((await r['POST /v1/social/wish']!(qs(), { text: '找搭子' })).body).toEqual({ ok: true, id: 'abcd1234', preview: '找搭子' })
    expect((await r['POST /v1/social/wish']!(qs(), { text: 'bad' })).body).toMatchObject({ ok: false, error: 'gate_failed', violations: ['住址'] })
    expect((await r['POST /v1/social/wish']!(qs(), {})).status).toBe(400)
  })
  it('send / cancel', async () => {
    expect((await r['POST /v1/social/wish/send']!(qs(), { id: 'abcd1234' })).body).toEqual({ ok: true, sent_to: 2 })
    expect((await r['POST /v1/social/wish/cancel']!(qs(), { id: 'abcd1234' })).body).toEqual({ ok: true, status: 'closed' })
    expect((await r['POST /v1/social/wish/send']!(qs(), {})).status).toBe(400)
  })
  it('list 给脱敏文本和 effective 状态,字段 snake_case', async () => {
    expect((await r['GET /v1/social/wishes']!(qs(), undefined)).body).toEqual({ wishes: [{ id: 'abcd1234', text: '脱敏', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 }] })
  })
  it('social 没接 → 503;四条 tier 是 trusted;旧路由不存在', () => {
    expect(socialRoutes({} as InternalApiDeps)['POST /v1/social/wish']).toBeDefined()
    for (const k of ['POST /v1/social/wish', 'POST /v1/social/wish/send', 'POST /v1/social/wish/cancel', 'GET /v1/social/wishes']) expect(minTierFor(k)).toBe('trusted')
    for (const k of ['POST /v1/social/seek/propose', 'GET /v1/social/seeks', 'GET /v1/social/echoes', 'POST /v1/social/echoes/reveal', 'GET /v1/social/pledges']) expect(r[k]).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-social.test.ts`
Expected: FAIL(路由不存在)

- [ ] **Step 3: 实现路由 + tier**

`routes-social.ts`:删除 `seek/propose|confirm|cancel`、`seeks`、`echoes`、`pledges`、`echoes/reveal`、`pledges/reveal` 七条及其 import;加:

```ts
    // 心愿(spec 2026-09-04-wish-postcard §4)。propose 只存草稿 —— 发出必须是主人的动作。
    'POST /v1/social/wish': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const text = ((body ?? {}) as { text?: unknown }).text
      if (typeof text !== 'string' || text.trim() === '') return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await deps.social.wish.propose(text.trim()) }
    },
    'POST /v1/social/wish/send': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      const r = await deps.social.wish.send(id)
      return { status: 200, body: r.ok ? { ok: true, sent_to: r.sentTo } : r }
    },
    'POST /v1/social/wish/cancel': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: deps.social.wish.cancel(id) }
    },
    'GET /v1/social/wishes': async () => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { wishes: deps.social.wish.list().map(w => ({ id: w.id, text: w.redacted, status: w.effective, created_at: w.createdAt, expires_at: w.expiresAt, sent_to: w.sentTo, replies: w.replies })) } }
    },
```

`route-tiers.ts`:删七条旧键,加四条 `'trusted'`。

- [ ] **Step 4: MCP 工具 + CLI**

`tools-social.ts`:工具名保留 `social_seek`(模型已学会),描述改成「替主人向认识的人打听」;请求改 `client.request<{ ok: boolean; id?: string; preview?: string; error?: string; violations?: string[] }>('POST', '/v1/social/wish', { text: topic + (city ? `(${city})` : '') })`;hint 文案:`已生成脱敏预览并暂存;请把 preview 转述给主人,主人回「派 <id>」才发出,「取消 <id>」作废。`;`ok:false` 原样返回给模型(它要告诉主人哪里不能说)。

`src/cli/social.ts`:删 `cmdSocialSeeks / Echoes / Pledges / Reveal / Propose / Confirm / Cancel` 与它们在子命令分发表里的登记;加 `cmdSocialWishes`(GET `/v1/social/wishes`,表格打印 id / status / sent_to / replies / text),登记为 `wechat-cc social wishes`。`src/cli/social.test.ts` 对应删改。检查 `src/cli/index.ts`(或分发处)的帮助文案。

- [ ] **Step 5: 跑测试 + typecheck**

Run: `bun --bun vitest run src/daemon/internal-api/routes-social.test.ts src/daemon/internal-api/routes-social.relationships.test.ts src/daemon/internal-api/route-tiers.test.ts src/cli/social.test.ts src/mcp-servers/wechat && bun run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/daemon/internal-api/routes-social.ts src/daemon/internal-api/routes-social.test.ts src/daemon/internal-api/route-tiers.ts src/mcp-servers/wechat/tools-social.ts src/cli/social.ts src/cli/social.test.ts
git commit -m "/v1/social/wish*:四条心愿路由替掉 seek/echo/pledge/reveal;MCP 工具和 CLI 跟着切"
```

---

### Task 7: wire-social 瘦身 + 上下游接线(微信命令、bootstrap、main)

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`(删除全部旧管道,只剩 correspondent / 串门 / 心愿)
- Modify: `src/daemon/bootstrap/types.ts`、`src/daemon/internal-api/types.ts`(`social` 收成 `{ penpal, wish }`)
- Modify: `src/daemon/bootstrap/index.ts`(`wireA2aServer` 不再传 onIntent/onEcho/onReveal;`mailboxPollerDeps` 不再传 onReveal/onIntent/onEcho/sweepUndelivered;删 `resumeForaging` 调用)
- Modify: `src/daemon/wiring/pipeline-deps.ts`(`social` 只装 `{ wish, penpal }`)
- Modify: `src/daemon/wiring/command-router.ts`(删「揭晓」块;「派 / 取消」块改用 wish;`CommandRouterDeps.social` 收窄)
- Modify: `src/daemon/main.ts`(若直接读了 `socialWiring.onIntent` 等)
- Delete tests: `src/daemon/bootstrap/wire-social.busy.test.ts`、`wire-social.discover.test.ts`、`wire-social.events.test.ts`、`wire-social.forage.test.ts`、`reveal-crossing.mailbox.test.ts`、`social-post-seam.test.ts`、`forward-budget-seam.test.ts`、`social-finish-seek.test.ts`
- Modify tests: `wire-social.mailbox.test.ts`(只留信件/串门/心愿相关)、`bootstrap.test.ts`、`src/daemon/wiring/command-router.test.ts`、`pipeline-deps-social-dispatch.test.ts`

**Interfaces:**
- Produces:
  - `SocialWiring = { onLetter; onMailboxLetter?; social?: { penpal: {...}; wish: Omit<WishService,'onInbound'> } }`;`social` 存在 ⇔ `social_enabled && social_disclosure_policy && cheapEval 可用`(和现在的门一样,只是不再挂在 `socialBroker` 上)。
  - `Bootstrap.social` / `InternalApiDeps.social` 同形(`InternalApiDeps` 里 `penpal?` `wish?` 保持可选)。
  - `CommandRouterDeps.social = { wish: Pick<WishService, 'send' | 'cancel' | 'resolveRef'>; penpal: { startVisit } }`。
  - 微信:「派 <ref>」→ `resolveRef(ref, ['draft'])` → `send` → 「已派给 N 个朋友,等回音…」/「你还没有开着信道的朋友,先配对」(no_channels)/「同时最多 3 条,先取消一条」(too_many_open);「取消 <ref>」→ `resolveRef(ref, ['draft','open'])` → `cancel` → 「已作废」/「已关掉,之后的回音还会进背包」。ambiguous / not_found 文案沿用现有两句。

- [ ] **Step 1: 改测试(RED)**

`command-router.test.ts`:删「揭晓」用例;「派 / 取消」用例改成用 `social.wish` 夹具(`resolveRef` / `send` / `cancel` 三个 `vi.fn`),断言上面的文案。`pipeline-deps-social-dispatch.test.ts`:`boot.social` 夹具改成 `{ wish, penpal }`,断言 `CommandRouterDeps.social` 装的是 `{ wish, penpal }`。`bootstrap.test.ts`:找到引用 `seekStore / echoStore / pledgeStore / revealer / onIntent / onEcho / onReveal / resumeForaging / sweepUndelivered` 的断言,删除或改为断言它们**不存在**于 `SocialWiring`(用 `expect('onIntent' in wiring).toBe(false)` 这种形状,一条即可)。

Run: `bun --bun vitest run src/daemon/wiring/command-router.test.ts src/daemon/wiring/pipeline-deps-social-dispatch.test.ts`
Expected: FAIL(类型 / 行为都还没改)

- [ ] **Step 2: wire-social 瘦身**

按 §1 段落图(以**符号**为准,不以行号):删除
- imports:`makeAnswerIntent` `makeBroker` `makeSeekStore` `makeEchoStore` `makePledgeStore` `makeRevealer/Revealer/RevealBeat/NotifyCtx/ChannelPort` `makeAsyncResponder` `A2A_PROTO_VERSION` `makeEchoIntake` `makeEchoHandler` `makeRelayStore` `makeSeenIntentStore` `makeRelayReconciler` `makeLetterRelay` `intentUrl/revealUrl/echoUrl`(留 `letterUrl`)`rankPeersByCloseness` `makeSocialPost/PostOutcome` `makeEchoRetry` `makeRelayRetry` `buildSharedForwardBudget` `buildCrossedHandle`(留 `peerMailboxOf`/`chooseTransport` 若 `postLetter` 仍用)`generateKeypair`(若只剩 reveal 用);
- `SocialDeps.eventsStore`(若只喂 `rankPeersByCloseness`);`makeBusySchedule`(两个调用点都删)及其测试;
- 前置 `let`:`socialOnIntent/onEcho/onReveal`、`socialBroker`、`socialResumeRow/SeekStore/EchoStore/PledgeStore/Revealer/Sweep`;
- `SOCIAL_EVENT_LABEL` + `recordSocialEvent`;`socialPost` / `postToHand` / `postToPeer`;`answerIntent`;seek/echo/pledge/relay/seenIntent 四个 store 构造;`withinForwardBudget`;`letterRelay`(`socialOnLetter` 里 `mine ? correspondent.receiveLetter(ev) : letterRelay.routeLetter(ev)` 改为 `mine ? correspondent.receiveLetter(ev) : (deps.log('SOCIAL', 'letter for unknown channel — dropped'), false)`,返回形状照原函数);`notify`(beat);`channel: ChannelPort`;`postPeerReveal` / `postReveal`;`revealer` / `relayRetry` / `socialSweep` / `relayReconciler`;`socialOnReveal`;`recordEcho` / `markEchoed` / `echoIntake` / `echoHandler` / `socialOnEcho`;`answerLocally` / `postOwnEcho` / `echoRetry` / `asyncResponder` / `socialOnIntent`;`broker` / `socialBroker`;`socialResumeRow`;`resumeForaging`。
- `SocialWiring` 与 `return`:

```ts
export interface SocialWiring {
  onLetter: A2AServerOpts['onLetter']
  onMailboxLetter?: A2AServerOpts['onLetter']
  social?: {
    penpal: { /* 现有六项:sendLetter resendLetter channelStore letterStore startVisit activeVisit */ }
    wish: Omit<import('./wire-wish').WishService, 'onInbound'>
  }
}
// …
return {
  onLetter: socialOnLetter,
  onMailboxLetter: socialOnMailboxLetter,
  ...(socialPenpal && socialWish ? { social: { penpal: socialPenpal, wish: socialWish } } : {}),
}
```

保留:config 门、cheapEval/strongEval + `cheapEvalBudgetMs`、`SOCIAL_SELF_ID`、mailbox sender/identity、`makeOwnerGrounding` / `socialJudge`、`channelStore` / `letterStore`、`postLetter`、`onInbound` switch(letter / visit / wish / postcard)、`correspondent`、`visit`、`wish`、`socialOnLetter`、`socialOnMailboxLetter`、`socialPenpal` / `socialWish`。`gateOutbound` 现在只被 `wire-wish` 的 `gate` 用,import 保留。

- [ ] **Step 3: 上下游**

- `bootstrap/index.ts`:`wireA2aServer(...)` 的 opts 去掉 `onIntent/onEcho/onReveal`;`mailboxPollerDeps` 去掉 `onReveal/onIntent/onEcho/sweepUndelivered`;删 `socialWiring.resumeForaging()` 调用;`inertSocialWiring` 只剩 `onLetter`(+ `onMailboxLetter`)。
- `bootstrap/types.ts` `Bootstrap.social` → `{ penpal: {...}; wish: Omit<WishService,'onInbound'> }`。
- `internal-api/types.ts` `InternalApiDeps.social` → `{ penpal?: {...}; wish?: … }`。
- `pipeline-deps.ts`:`social: { wish: boot.social.wish, penpal: { startVisit: (c) => boot.social!.penpal.startVisit(c) } }`。
- `command-router.ts`:删「揭晓」块与 `parseRevealCommand` import;「派 / 取消」块:

```ts
      if (deps.social && deps.isAdmin(msg.chatId)) {
        const cmd = parseSeekCommand(msg.text)
        if (cmd) {
          const among = cmd.kind === 'confirm' ? ['draft'] as const : ['draft', 'open'] as const
          const res = deps.social.wish.resolveRef(cmd.ref, among)
          if (!res.ok) {
            say(msg.chatId, res.reason === 'ambiguous' ? '有多条心愿匹配这个开头,请给更长的编号' : '这条心愿不存在或已处理')
            return true
          }
          if (cmd.kind === 'confirm') {
            const r = await deps.social.wish.send(res.id)
            say(msg.chatId, r.ok ? `已派给 ${r.sentTo} 个朋友,等回音…` : r.reason === 'no_channels' ? '你还没有开着信道的朋友,先配对' : r.reason === 'too_many_open' ? '同时最多 3 条心愿,先取消一条' : '这条心愿不存在或已处理')
          } else {
            const r = deps.social.wish.cancel(res.id)
            say(msg.chatId, r.ok ? (r.status === 'cancelled' ? '已作废' : '已关掉,之后的回音还会进背包') : '这条心愿不存在或已处理')
          }
          return true
        }
      }
```

  `CommandRouterDeps.social` 改为 `{ wish: Pick<WishService,'send'|'cancel'|'resolveRef'>; penpal: {...} }`,删 `Revealer` / `SeekStore` / `ConfirmOutcome` / `CancelOutcome` import。`seek-command.ts` 的 `resolveSeekRef` 不再使用 —— 删掉它和它的测试用例,只留 `parseSeekCommand`(文件头注释改成「派 / 取消 心愿」)。
- `main.ts`:grep `onIntent|onEcho|onReveal|sweepUndelivered|resumeForaging`,若有引用一并删。
- 删除 §Files 里列出的 8 个测试文件;`wire-social.mailbox.test.ts` 保留信件 / 串门相关用例,删 reveal / echo / intent 的。

- [ ] **Step 4: 跑测试 + typecheck + 全量**

Run: `bun run typecheck && bun --bun vitest run src/daemon/bootstrap src/daemon/wiring src/daemon/internal-api`
Expected: PASS。此时 `src/core/social-*` 等旧文件已无生产调用方,但它们自己的单测仍绿(Task 8 再删)。

- [ ] **Step 5: 提交**

```bash
git add -A src/daemon src/core/seek-command.ts src/core/seek-command.test.ts
git commit -m "wire-social 瘦身:只剩 correspondent / 串门 / 心愿;揭晓命令删除,派/取消改走心愿;bootstrap 与 a2a-server 不再接 intent/echo/reveal"
```

---

### Task 8: 删除孤儿:core 旧管道 + a2a-server / mailbox-dispatch 路由 + 判官输入收窄

**Files:**
- Delete: `src/core/social-broker.ts` `social-seek-store.ts` `social-echo-store.ts` `social-echo-intake.ts` `social-echo-relay.ts` `social-echo-retry.ts` `social-pledge-store.ts` `social-relay-store.ts` `social-relay-retry.ts` `social-reveal.ts` `social-relay-reveal.ts` `social-seen-intent-store.ts` `social-answer.ts` `social-async-responder.ts` `reveal-command.ts` `forward-budget.ts` `penpal-relay-letter.ts` `peer-closeness.ts`(各自的 `.test.ts` 一起删)+ `src/core/social-async.e2e.test.ts` + `src/daemon/bootstrap/social-post-seam.ts` `forward-budget-seam.ts` `social-finish-seek.ts`(及测试,若 Task 7 未删)
- Modify: `src/core/a2a-server.ts`(删 `/a2a/intent` `/a2a/echo` `/a2a/reveal` handler、`onIntent/onEcho/onReveal` opts、`IntentEvent/EchoEvent/RevealEvent` 类型、agent card 的 `intent/echo/reveal` capability 条目)
- Modify: `src/core/mailbox-dispatch.ts`(删三条分支与 deps 里的 `onReveal/onIntent/onEcho`)
- Modify: `src/core/a2a-intent.ts` → 只剩 `export const A2A_PROTO_VERSION = 3`(文件头注释说明 v3 = 心愿走信封,intent/echo/reveal 退役)
- Modify: `src/core/a2a-delegate.ts`(删 `intentUrl/revealUrl/echoUrl`)
- Modify: `src/daemon/bootstrap/mailbox-dispatch-seam.ts`(删 `buildCrossedHandle`)
- Modify: `src/core/social-judge.ts`(`makeJudge` 输入类型改为 `export interface JudgeInput { topic: string; city?: string }`,不再 import `IntentCard`;`ground?: (card: JudgeInput) => Promise<string>`)
- Modify tests: `a2a-server.test.ts` `mailbox-dispatch.test.ts` `mailbox-e2e.test.ts` `penpal.e2e.test.ts` `mailbox-metadata-boundary.test.ts` `social-judge.test.ts` `mailbox-dispatch-seam.test.ts` `internal-api.test.ts` `src/lib/test-runner-guard.test.ts`(若列了被删文件名)

**Interfaces:**
- Produces:`A2AServerOpts` 不再有 `onIntent/onEcho/onReveal`;`makeEnvelopeDispatch` deps 只剩 `registry / onLetter / log`;`A2A_PROTO_VERSION === 3`;`makeJudge(deps): (card: JudgeInput) => Promise<JudgeVerdict>`。

- [ ] **Step 1: 先删文件,让编译告诉你剩下什么**

```bash
git rm -q src/core/{social-broker,social-seek-store,social-echo-store,social-echo-intake,social-echo-relay,social-echo-retry,social-pledge-store,social-relay-store,social-relay-retry,social-reveal,social-relay-reveal,social-seen-intent-store,social-answer,social-async-responder,reveal-command,forward-budget,penpal-relay-letter,peer-closeness}.ts
git rm -q src/core/{social-broker,social-seek-store,social-echo-store,social-echo-intake,social-echo-relay,social-echo-retry,social-pledge-store,social-relay-store,social-relay-retry,social-reveal,social-relay-reveal,social-seen-intent-store,social-answer,social-async-responder,reveal-command,forward-budget,penpal-relay-letter,peer-closeness}.test.ts src/core/social-async.e2e.test.ts
git rm -q src/daemon/bootstrap/{social-post-seam,forward-budget-seam,social-finish-seek}.ts src/daemon/bootstrap/{social-post-seam,forward-budget-seam,social-finish-seek}.test.ts 2>/dev/null || true
bun run typecheck 2>&1 | head -40
```

(某个文件已在 Task 7 删过则 `git rm` 报错,忽略;不存在的测试文件同理。)

- [ ] **Step 2: 按编译错误修剩余引用**

- `a2a-server.ts`:删三个 handler 函数体、三个 opts 字段、三个 Event 类型、card 里三个 capability 对象、`IntentCardSchema/EchoMessageSchema/IntentCard/MatchReceipt/EchoMessage` import;`A2A_PROTO_VERSION` 继续从 `a2a-intent` 拿。
- `mailbox-dispatch.ts`:删 `/a2a/reveal` `/a2a/intent` `/a2a/echo` 分支与对应 deps 字段与 schema import;未知 path → 原来的兜底(log + 忽略)。
- `a2a-intent.ts`:整文件替换为版本常量 + 注释。
- `a2a-delegate.ts`:删三个 url 函数(留 `handExecUrl` `letterUrl` `delegateToHand` 及常量)。
- `mailbox-dispatch-seam.ts`:删 `buildCrossedHandle` 与其 import。
- `social-judge.ts`:`JudgeInput` 替换 `IntentCard`。
- 测试:`a2a-server.test.ts` 删 intent/echo/reveal 用例,card 断言里去掉三项;`mailbox-dispatch.test.ts` 只留 letter/unknown;`mailbox-e2e.test.ts` / `penpal.e2e.test.ts` / `mailbox-metadata-boundary.test.ts` 删涉及 reveal/echo/intent 的用例,信件闭环保留;`social-judge.test.ts` 的 card 夹具改成 `{ topic, city? }`;`mailbox-dispatch-seam.test.ts` 删 `buildCrossedHandle` 用例;`internal-api.test.ts` 删 seek/echo 路由用例;`src/lib/test-runner-guard.test.ts` 若维护了测试文件清单,去掉被删的。

- [ ] **Step 3: 全量验证**

Run: `bun run typecheck && bun --bun vitest run`
Expected: 全绿。顺手 `grep -rn "social_seek\|social_echo\|social_pledge\|social_relay\|IntentCard\|/a2a/intent\|/a2a/echo\|/a2a/reveal" src apps --include='*.ts' --include='*.js' | grep -v "db.ts\|\.test\.ts"` 只剩 `db.ts` 的迁移历史(Task 9 处理)和注释。

- [ ] **Step 4: 提交**

```bash
git add -A src
git commit -m "删掉旧的工具社交管道:broker/seek/echo/pledge/relay/reveal 及 /a2a/intent|echo|reveal;判官输入收窄为 {topic};proto v3"
```

---

### Task 9: 迁移:删四张社交表 + seen_intent

**Files:**
- Modify: `src/lib/db.ts`(`migrations[]` 末尾追加一条)
- Test: `src/lib/db.test.ts`(追加 describe)

**Interfaces:**
- Produces:新迁移(写作时 v43)执行后 `social_seek / social_echo / social_pledge / social_relay / social_seen_intent` 不存在;`penpal_channel / penpal_letter / journal / a2a_events` 原样。

- [ ] **Step 1: 写失败测试**

`src/lib/db.test.ts` 末尾追加(文件里已有 `openDb` / `migrations` / `runMigrations`(名字以文件为准)的 import 与「把库跑到第 N 条」的帮手;若没有帮手,用 `openDb({ path: ':memory:' })` 拿全迁移库即可):

```ts
describe('旧社交表退役(spec 2026-09-04-wish-postcard §3)', () => {
  const tables = (db: Db) => new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
  it('全迁移库里没有四张社交表和 seen_intent;penpal/journal 还在', () => {
    const db = openDb({ path: ':memory:' })
    const t = tables(db)
    for (const n of ['social_seek', 'social_echo', 'social_pledge', 'social_relay', 'social_seen_intent']) expect(t.has(n), n).toBe(false)
    for (const n of ['penpal_channel', 'penpal_letter', 'journal', 'a2a_events']) expect(t.has(n), n).toBe(true)
  })
  it('迁移条数与 user_version 一致(位置契约)', () => {
    const db = openDb({ path: ':memory:' })
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(migrations.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/lib/db.test.ts -t 旧社交表退役`
Expected: FAIL(表还在)

- [ ] **Step 3: 实现**

`src/lib/db.ts` `migrations[]` 末尾(在最后一条之后、`]` 之前)追加:

```ts
  // v43 — 旧的工具社交管道退役(spec 2026-09-04-wish-postcard §3)。
  //
  // 派心愿 / 回声 / 揭晓改写成走 E2E 信道的信封(kind='wish' / 'postcard'),
  // 状态在 penpal_letter + companion/wishes.json。四张表 + seen_intent 在
  // 真机上全是 0 行。DROP IF EXISTS:#79 路径下的库可能从没建过它们。
  // repairBranchRenumberedSchema 只看 user_version 19–21,这里不受影响。
  (db) => {
    db.exec(`
      DROP TABLE IF EXISTS social_seen_intent;
      DROP TABLE IF EXISTS social_relay;
      DROP TABLE IF EXISTS social_pledge;
      DROP TABLE IF EXISTS social_echo;
      DROP TABLE IF EXISTS social_seek;
    `)
  },
```

(若数组长度已不是 42,注释里的编号写成实际的 `length + 1`。)

- [ ] **Step 4: 跑测试**

Run: `bun --bun vitest run src/lib/db.test.ts src/lib/migration-order.test.ts src/lib/state-migration.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "迁移:删 social_seek/echo/pledge/relay/seen_intent —— 心愿改走信封后这些表没人读写,真机全 0 行"
```

---

### Task 10: 桌面:技术区去掉心愿 / 回声,加「📮 心愿」区块

**Files:**
- Modify: `apps/desktop/src/index.html`(`#fd-tools` 内删「我派出去的心愿」「回声」两个 sub;在「👥 认识的人」之后加 `#fd-wish` 区块)
- Create: `apps/desktop/src/modules/wishes.js`
- Test: `apps/desktop/src/modules/wishes.test.ts`
- Modify: `apps/desktop/src/modules/a2a-agents.js`(删 wish/postcard 渲染、compose、seek / postcard action、`fdDegreePath/fdDegBar`、对应 test seam;`refresh()` 去掉 seeks/echoes 两腿;`initA2AAgentsTab` 调 `initWishes()`;`renderForageDesk` 去掉 wishes/postcards 段)
- Modify: `apps/desktop/src/modules/a2a-agents.test.ts`(删 §3 表里 DELETE 的 describe;`installDom()` 去掉 `fd-compose*` `fd-preview` `fd-postcards*`,加 `fd-wish*`;hero describe 里依赖 seeks/echoes 计数的两个 it 改为不依赖)
- Modify: `apps/desktop/src/styles.css`(删 `.fd-compose*` `.fd-preview*` `.fd-wish*` `.fd-kind*` `.fd-lock` `.fd-rightcol` `.fd-forage` `.fd-pulse*` `.fd-degree*` `.fd-deg*` `.fd-echo-badge` `.fd-postcards*` `.fd-postcard*` `.fd-stamp` `.fd-pc-*` `.fd-masked*` `.fd-mask-av` `.fd-who` `.fd-outcome*` `.fd-reveal-note` `.fd-btn-reveal`;加 `.wsh-*`)

**Interfaces:**
- Consumes:`POST /v1/social/wish` `POST /v1/social/wish/send` `POST /v1/social/wish/cancel` `GET /v1/social/wishes`(Task 6)。
- Produces(`wishes.js`):

```js
export function renderWishes(data /* { wishes: Array<{id,text,status,created_at,expires_at,sent_to,replies}> | null } */)
export function renderWishDraft(preview /* { id, preview } | null */)
export async function refreshWishes()
export async function onWishCompose(ev)      // form submit → POST /v1/social/wish → renderWishDraft
export async function onWishAction(ev)       // data-wsh-action = send | discard | cancel
export function initWishes()
```

DOM(index.html 新块,放在 `#fd-people` 那个 section 之后、`#fd-tools` 之前):

```html
                <section class="fd-section" id="fd-wish">
                  <div class="fd-sec-head"><h2>📮 心愿</h2><span class="fd-count" id="fd-wish-count"></span><span class="fd-hint">伙伴替你去问认识的人 · 回信在「带回来的」里</span></div>
                  <form class="wsh-compose" id="fd-wish-form">
                    <input id="fd-wish-text" type="text" maxlength="140" placeholder="想让伙伴帮你打听什么?" autocomplete="off">
                    <button id="fd-wish-submit" type="submit">先看看怎么问</button>
                  </form>
                  <div class="wsh-draft" id="fd-wish-draft" hidden></div>
                  <div class="wsh-list" id="fd-wish-list"></div>
                </section>
```

行为:提交 → `POST /v1/social/wish {text}` → `ok` 时 `#fd-wish-draft` 显示 preview + 「派」(`data-wsh-action="send" data-wsh-id`)「算了」(`discard`);`ok:false` 显示 `error` / `violations` 文案(gate_failed:「这句里有不能说的:…」;checker_unavailable:「模型这会儿没响应,稍后再试」)。「派」→ `POST /wish/send` → toast「已派给 N 个朋友」/ no_channels「还没有开着信道的朋友,先配对」/ too_many_open「同时最多 3 条」→ `refreshWishes()`;「算了」→ `POST /wish/cancel` 后清空草稿。列表每条:`text`、`status`(open「等回音」/ closed「已关」/ expired「过期」/ cancelled「作废」/ draft「草稿」)、`派给 ${sent_to} 人 · ${replies} 张回信`、open/draft 有「取消」(`data-wsh-action="cancel"`)。计数 `#fd-wish-count` = open 条数。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/modules/wishes.test.ts`(照 `journal.test.ts` 的 DOM stub + `vi.mock('../api.js')` + `vi.mock('../view.js')` 写法;`await import('./wishes.js')` 顶层解构):

```ts
describe('心愿区块', () => {
  beforeEach(() => { for (const id of ['fd-wish-count', 'fd-wish-draft', 'fd-wish-list', 'fd-wish-text']) els.set(id, mkEl()) ; invokeApi.mockReset() })
  it('renderWishes:每条有状态字、派给几人、几张回信;计数 = open 条数;null → 不可用文案', () => {
    renderWishes({ wishes: [
      { id: 'a1', text: '找搭子', status: 'open', created_at: 'c', expires_at: 'e', sent_to: 2, replies: 1 },
      { id: 'b2', text: '旧的', status: 'expired', created_at: 'c', expires_at: 'e', sent_to: 1, replies: 0 },
    ] })
    const html = els.get('fd-wish-list')!.innerHTML
    expect(html).toContain('找搭子'); expect(html).toContain('等回音'); expect(html).toContain('派给 2 人 · 1 张回信'); expect(html).toContain('过期')
    expect(html).toContain('data-wsh-action="cancel" data-wsh-id="a1"'); expect(html).not.toContain('data-wsh-id="b2"')
    expect(els.get('fd-wish-count')!.textContent).toBe('1')
    renderWishes({ wishes: null })
    expect(els.get('fd-wish-list')!.innerHTML).toContain('社交没开')
  })
  it('compose:过门 → 草稿显示 preview + 派/算了;不过门 → 显示不能说的', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, id: 'a1', preview: '找搭子' })
    els.get('fd-wish-text')!.value = '找搭子'
    await onWishCompose({ preventDefault() {} })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish', { text: '找搭子' })
    expect(els.get('fd-wish-draft')!.innerHTML).toContain('data-wsh-action="send" data-wsh-id="a1"')
    invokeApi.mockResolvedValueOnce({ ok: false, error: 'gate_failed', violations: ['住址'] })
    await onWishCompose({ preventDefault() {} })
    expect(els.get('fd-wish-draft')!.innerHTML).toContain('住址')
  })
  it('send / discard / cancel 各打对路由;no_channels 有提示', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, sent_to: 2 }).mockResolvedValueOnce({ wishes: [] })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'send' : 'a1') }) } })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish/send', { id: 'a1' })
    invokeApi.mockResolvedValueOnce({ ok: false, reason: 'no_channels' })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'send' : 'a1') }) } })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('先配对'))
    invokeApi.mockResolvedValueOnce({ ok: true, status: 'cancelled' }).mockResolvedValueOnce({ wishes: [] })
    await onWishAction({ target: { closest: () => ({ getAttribute: (k: string) => (k === 'data-wsh-action' ? 'cancel' : 'a1') }) } })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/wish/cancel', { id: 'a1' })
  })
})
```

`mkEl()` 需要有 `value` 字段(给 input 用),照 `journal.test.ts` 的 stub 加一项。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run apps/desktop/src/modules/wishes.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: 实现 `wishes.js` + index.html + styles**

`wishes.js` 照 `journal.js` 的写法(`// @ts-check`、`invokeApi` / `escapeHtml` / `showToast` import、委托点击)。状态字映射:

```js
const STATUS_LABEL = { draft: '草稿', open: '等回音', closed: '已关', expired: '过期', cancelled: '作废' }
```

`initWishes()`:`#fd-wish-form` submit → `onWishCompose`;`#fd-wish-draft` 与 `#fd-wish-list` click → `onWishAction`;然后 `refreshWishes()`。

styles:`.wsh-compose{display:flex;gap:8px}` `.wsh-compose input{flex:1}` `.wsh-draft{margin:8px 0;padding:8px 10px;border:1px dashed var(--fd-line,#ccc);border-radius:8px}` `.wsh-list .wsh-row{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--fd-line,#eee)}` `.wsh-meta{opacity:.7;font-size:.9em}` —— 五行,不多。

- [ ] **Step 4: a2a-agents.js 删块 + 接 initWishes**

按 §2 表:删 `fdDegreePath` `fdDegBar` `renderWish` `renderProposedWish` `renderCancelledWish` `renderClosedWish` `renderPostcard` `onPostcardAction` `composeErrText` `onComposeSubmit` `renderProposePreview` `clearComposePreview` `onSeekAction` 及 `__onComposeSubmitForTest` `__onSeekActionForTest` `__onPostcardActionForTest`;`refresh()` 的 `Promise.all` 去掉 seeks / echoes 两腿(信箱 `/v1/penpal/channels` 那腿**保留**);`renderForageDesk` 去掉 wishes / postcards 两段(信箱段保留);`initA2AAgentsTab` 去掉 compose / wishes 监听,加 `initWishes()`(import from `./wishes.js`)。`index.html` 删 `#fd-tools` 里的 sub 1(派心愿)和 sub 2(回声),保留 sub 3(笔友信箱);`#fd-tools-summary` 文案改成「配对 · 信箱」。

`a2a-agents.test.ts`:删 §3 表 DELETE 的 describe(wishes / postcards / reveal action / compose / proposed-cancelled 行);hero describe 里断言 seek/echo 计数与 `fd-social-note` 的两个 it 改成只断言 hero 状态字与 peers 数;`installDom()` 清单同步。

- [ ] **Step 5: 跑测试**

Run: `bun --bun vitest run apps/desktop/src/modules/wishes.test.ts apps/desktop/src/modules/a2a-agents.test.ts apps/desktop/src/modules/journal.test.ts apps/desktop/src/modules/module-syntax.test.ts apps/desktop/src/view.test.ts && node --check apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/wishes.js`
Expected: PASS。浏览器手看(`cd apps/desktop && bun run dev:web`,觅食台 pane):心愿区块在「认识的人」下面,技术区只剩配对 + 信箱。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/index.html apps/desktop/src/modules/wishes.js apps/desktop/src/modules/wishes.test.ts apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/a2a-agents.test.ts apps/desktop/src/styles.css
git commit -m "觅食台:心愿区块(输入 → 预览 → 派)替掉派心愿 / 回声两块;技术区只剩配对和信箱"
```

---

### Task 11: 文档对齐 + 全量收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-wish-postcard-design.md`(§3 迁移编号改为「追加,写作时 v43」;§3 桌面行加「笔友信箱保留」;§3 internal-api 行加 `pledges` / `pledges/reveal`;§5 提到信箱保留)
- Modify: `docs/superpowers/specs/2026-09-04-social-architecture-rethink.md`(§3 步 6 标「1 跳已做(2026-09-04-wish-postcard);介绍待做」)
- Modify: `src/core/relationships.ts` 注释里「派心愿牵线」的 origin 文案保留(历史行仍可能存在),但加一句注释说明新信道 origin 是「配对」

- [ ] **Step 1: 改文档与注释**(纯文本)
- [ ] **Step 2: 全量**

Run: `bun run typecheck && bun --bun vitest run && cd apps/desktop/src-tauri && cargo check`
Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-09-04-wish-postcard-design.md docs/superpowers/specs/2026-09-04-social-architecture-rethink.md src/core/relationships.ts
git commit -m "docs:心愿 spec 与架构 spec 对齐(迁移编号、信箱保留、步 6 一跳已做)"
```

---

## 完成后(真机)

1. Mac、Windows 都升到含本计划的版本;两边 daemon 重启。
2. 两边用 6 位配对码**重新配对**一次 → 桌面「认识的人」里对方应带信道(origin「配对」)。
3. Mac 微信「派心愿 找周末爬山搭子」→ 伙伴复述 → 「派 <id>」→ Windows 日志见 `WISH` 判官跑 → Mac 微信收到 📮 → 觅食台「带回来的」多一张明信片 → 桌宠脚边明信片道具。
4. 记 memory:`companion-presence-shipped` 的真机闭环一并验掉。
