# 伙伴日程判断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pushTick 里「冷却到了就做」换成「冷却到了先问伙伴一句现在要不要做」:候选由代码算,便宜模型在候选里选一个或选「不做」,冷却与 care 门一律不变,没有模型时行为与今天逐字相同。

**Architecture:** 新纯模块 `src/core/companion-plan.ts`(候选集、prompt、fail-closed 解析、回退顺序、退避)+ `src/daemon/companion/plan-memory.ts`(`companion/plan-log.json`,按天清零)。`tick-bodies.ts` 把 hunt / visit / gap 三段收成三个执行函数,中间插判断;agenda 段、`calibration.ts`、`care-ledger.ts` 不动。`wire-visit.ts` 暴露 `provenChannels()` 给 prompt 用。

**Tech Stack:** TypeScript on Bun;Vitest(`bun --bun vitest run <file>`);`CheapEval = (prompt: string) => Promise<string>`(`src/core/agent-provider.ts:74`)。

**Spec:** `docs/superpowers/specs/2026-09-05-companion-plan-design.md`

## Global Constraints

- 冷却、care 档、无回复暂停、安静天数**只在** `calibration.ts` 的 `shouldSpeak` 里,本轮一行不改;模型只能在通过了 `shouldSpeak` 的候选里选,选了候选外的动作一律降级为 `none`。
- 到期的 agenda 意图照旧由代码准时发,不经过判断;`planEval` 在 agenda 分支从不被调。
- 常量(逐字):`PLAN_REASK_MS = 90 * 60_000`、`PLAN_EVAL_TIMEOUT_MS = 20_000`、`PLAN_MAX_OBSERVATIONS = 3`、`PLAN_OBSERVATION_CHARS = 80`、`PLAN_PERSONA_CHARS = 300`、`PLAN_JOURNAL_ITEMS = 3`、`PLAN_TITLE_CHARS = 40`、`PLAN_WHY_CHARS = 120`、`PLAN_EARLIER_ITEMS = 5`、`PLAN_PROVEN_MAX = 5`。
- `PlanAction = 'hunt' | 'visit' | 'gap' | 'none'`;回退顺序 hunt → visit → gap。
- 回退(没有 evaluator / 超时 / 抛错 / 解析失败)= 执行候选里回退顺序的第一个,行为与今天一致;回退和降级**不计入**退避,只有 `source === 'model'` 且 `decision === 'none'` 的记录触发退避。
- prompt 只含衍生信号:observations 的 `tone` + 截断 `body`、persona 摘录、journal 标题、计数、时间;**任何字段都不含聊天原文、chat_id、姓名**。
- `plan-log.json` 用 `readJsonFile`(BOM 容忍)读、`mkdirSync` + `writeFileSync` 写(照 `wish-memory.ts`);`day` 不是今天就整个丢掉。理由只进日志(`PLAN` 标签)和 plan-log,不进 journal、不改桌宠状态、不发给主人。
- 串门 `target` 是候选信道的 **id**(`startVisit` 按 id 前缀解析;spec 写的 label 在 wire-visit 里只是「第 N 度的朋友」,不唯一),prompt 给模型 `{ id, label }`,回来的 `target` 不在候选 id 里就忽略、走 `startVisit()`。
- 每个提交全量测试绿(`bun --bun vitest run`)、`bun run typecheck` 干净;报告前 `git status --short` 必须为空。既有 `tick-bodies.test.ts` 的测试一条不改(它们的 registry 没有 cheapEval,应自然落到回退路径)。
- 提交信息一行中文(仓库风格);trailer:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01UyRSmFJFdAc7VP1TzUUdS7`。

---

### Task 1: `companion-plan.ts` 纯函数 —— 候选集、prompt、解析、回退、退避

**Files:**
- Create: `src/core/companion-plan.ts`
- Test: `src/core/companion-plan.test.ts`

**Interfaces:**
- Consumes: `shouldSpeak`、`CareLedgerEntry`、`CareLevel`(`src/daemon/companion/calibration.ts`)。core 引 daemon/companion 是既有先例(`companion-presence.ts` 无依赖,但 `visit.ts` 等已跨引);若 `tsc` 因 daemon→core 的 import 方向报层级守卫错误,把 `shouldSpeak` 的调用留在 Task 3 的 tick 里、这里只接收 `{ action, ok, reason }` 结果 —— **不要**复制 shouldSpeak 的逻辑。
- Produces:

```ts
export type PlanAction = 'hunt' | 'visit' | 'gap' | 'none'
export const PLAN_REASK_MS = 90 * 60_000
export const PLAN_EVAL_TIMEOUT_MS = 20_000
export const PLAN_MAX_OBSERVATIONS = 3
export const PLAN_OBSERVATION_CHARS = 80
export const PLAN_PERSONA_CHARS = 300
export const PLAN_JOURNAL_ITEMS = 3
export const PLAN_TITLE_CHARS = 40
export const PLAN_WHY_CHARS = 120
export const PLAN_EARLIER_ITEMS = 5
export const PLAN_PROVEN_MAX = 5

export interface Candidate { action: Exclude<PlanAction, 'none'> }
export interface Rejected { action: Exclude<PlanAction, 'none'>; reason: string }
export interface CandidateInput {
  isOwnerChat: boolean
  level: CareLevel                 // careLevel(chatId, prefs, defaultChatId) 的结果
  prefs: { hunt?: boolean; visit?: boolean }
  socialWired: boolean             // boot.social?.penpal 存在
  nowIso: string
  ledger: CareLedgerEntry
  lastInboundAtIso?: string
}
/** 三次 shouldSpeak 收口:hunt / visit 仅主人会话且 pref 不为 false(visit 还要 socialWired);gap 所有会话。 */
export function computeCandidates(i: CandidateInput): { candidates: Candidate[]; rejected: Rejected[] }

export interface PlanContext {
  nowLocal: string                                   // 'YYYY-MM-DD HH:mm 周X'
  ownerLastInboundMinutesAgo: number | null
  today: { lastHuntHoursAgo: number | null; lastVisitHoursAgo: number | null; lastProactiveHoursAgo: number | null }
  candidates: Candidate[]
  rejected: Rejected[]
  journal: { unread: number; latest: Array<{ kind: string; title: string; ts: string }> } | null
  social: { openWishes: number; pendingOffers: number; provenChannels: Array<{ id: string; label: string }> } | null
  observations: Array<{ tone: string | null; body: string }>
  personaExcerpt: string
  earlierToday: Array<{ at: string; decision: PlanAction; why: string }>
}
export function buildPlanPrompt(ctx: PlanContext): string   // 内部对每个字段套上限;不信任调用方已截断

export interface Plan { action: PlanAction; why: string; target?: string }
export function parsePlan(raw: string): { ok: true; plan: Plan } | { ok: false; reason: string }
export function pickFallback(candidates: Candidate[]): Exclude<PlanAction, 'none'> | null   // hunt → visit → gap
/** action 不在候选里 → 'none'(降级);target 不在 provenIds 里 → 删掉 target。 */
export function constrainPlan(plan: Plan, candidates: Candidate[], provenIds: readonly string[]): { plan: Plan; downgraded: boolean }
export interface PlanLogEntry { at: string; chatId: string; candidates: PlanAction[]; decision: PlanAction; why: string; source: 'model' | 'fallback' | 'downgraded' }
export function shouldReask(entries: readonly PlanLogEntry[], chatId: string, nowMs: number): boolean   // 上一条 model+none 且不到 PLAN_REASK_MS → false
export function formatLocal(nowIso: string, tz?: string): string   // 'YYYY-MM-DD HH:mm 周X'
```

- [ ] **Step 1: 写失败测试**

`src/core/companion-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  computeCandidates, buildPlanPrompt, parsePlan, pickFallback, constrainPlan, shouldReask, formatLocal,
  PLAN_REASK_MS, PLAN_OBSERVATION_CHARS, PLAN_PERSONA_CHARS, PLAN_TITLE_CHARS,
  type PlanContext, type PlanLogEntry,
} from './companion-plan'

const NOW = '2026-05-13T02:00:00.000Z'   // 北京 10:00 周三
const base = { isOwnerChat: true, level: 'low' as const, prefs: {}, socialWired: true, nowIso: NOW, ledger: { noReplyCount: 0 }, lastInboundAtIso: '2026-05-01T00:00:00.000Z' }

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  nowLocal: '2026-05-13 10:00 周三', ownerLastInboundMinutesAgo: 600,
  today: { lastHuntHoursAgo: null, lastVisitHoursAgo: null, lastProactiveHoursAgo: null },
  candidates: [{ action: 'hunt' }, { action: 'visit' }], rejected: [{ action: 'gap', reason: 'gap_inbound_recent' }],
  journal: { unread: 2, latest: [{ kind: 'postcard', title: '我朋友周末常去', ts: NOW }] },
  social: { openWishes: 1, pendingOffers: 0, provenChannels: [{ id: 'pair:abc', label: '第 1 度的朋友' }] },
  observations: [{ tone: 'warm', body: '主人最近在忙搬家' }], personaExcerpt: '话不多,爱观察',
  earlierToday: [{ at: '2026-05-13T00:30:00.000Z', decision: 'none', why: '太早了' }],
  ...over,
})

describe('computeCandidates', () => {
  it('主人会话、无冷却、安静不够久 → hunt 与 visit 是候选,gap 被拒并带 reason', () => {
    const r = computeCandidates({ ...base, lastInboundAtIso: '2026-05-13T01:00:00.000Z' })
    expect(r.candidates.map(c => c.action)).toEqual(['hunt', 'visit'])
    expect(r.rejected).toEqual([{ action: 'gap', reason: 'gap_inbound_recent' }])
  })
  it('打猎冷却中 → hunt 进 rejected(hunt_cooldown),visit 仍是候选', () => {
    const r = computeCandidates({ ...base, ledger: { noReplyCount: 0, lastHuntAtIso: '2026-05-13T00:00:00.000Z' }, lastInboundAtIso: '2026-05-13T01:00:00.000Z' })
    expect(r.candidates.map(c => c.action)).toEqual(['visit'])
    expect(r.rejected.find(x => x.action === 'hunt')?.reason).toBe('hunt_cooldown')
  })
  it('非主人会话只可能有 gap;pref hunt=false / 社交没接线 分别拿掉 hunt / visit', () => {
    expect(computeCandidates({ ...base, isOwnerChat: false }).candidates.map(c => c.action)).toEqual(['gap'])
    expect(computeCandidates({ ...base, prefs: { hunt: false } }).candidates.map(c => c.action)).not.toContain('hunt')
    expect(computeCandidates({ ...base, socialWired: false }).candidates.map(c => c.action)).not.toContain('visit')
  })
  it('care off → 全部被拒 care_off,候选为空', () => {
    const r = computeCandidates({ ...base, level: 'off' })
    expect(r.candidates).toEqual([])
    expect(r.rejected.every(x => x.reason === 'care_off')).toBe(true)
  })
})

describe('buildPlanPrompt', () => {
  it('含候选、被拒理由、今天之前的判断、包袱与社交计数,且要求严格 JSON', () => {
    const p = buildPlanPrompt(ctx())
    for (const s of ['"hunt"', '"visit"', 'gap_inbound_recent', '太早了', '"unread":2', '"openWishes":1', 'pair:abc', '只输出 JSON', '"none"']) expect(p).toContain(s)
  })
  it('observations / persona / 标题按上限截断', () => {
    const long = 'x'.repeat(500)
    const p = buildPlanPrompt(ctx({ observations: [{ tone: null, body: long }], personaExcerpt: long, journal: { unread: 1, latest: [{ kind: 'hunt', title: long, ts: NOW }] } }))
    expect(p).not.toContain('x'.repeat(PLAN_OBSERVATION_CHARS + 1) + '"')   // body 截到上限
    expect(p).toContain('x'.repeat(PLAN_OBSERVATION_CHARS))
    expect(p.match(/x{301,}/)).toBeNull()                                   // persona ≤ 300
    expect(p).toContain('x'.repeat(PLAN_TITLE_CHARS))
  })
  it('social / journal 为 null 时写「没接线」,不抛', () => {
    const p = buildPlanPrompt(ctx({ social: null, journal: null }))
    expect(p).toContain('没接线')
  })
})

describe('parsePlan', () => {
  it('接受四个动作、剥 ```json 围栏、保留 target', () => {
    expect(parsePlan('{"action":"visit","why":"上午没人聊","target":"pair:abc"}')).toEqual({ ok: true, plan: { action: 'visit', why: '上午没人聊', target: 'pair:abc' } })
    expect(parsePlan('```json\n{"action":"none","why":"主人在聊"}\n```')).toEqual({ ok: true, plan: { action: 'none', why: '主人在聊' } })
  })
  it('拒:非 JSON / 非对象 / 未知 action / 多余字段 / why 过长 / target 非字符串', () => {
    for (const raw of ['not json', '[]', '{"action":"paint","why":"x"}', '{"action":"hunt","why":"x","extra":1}', `{"action":"hunt","why":"${'x'.repeat(200)}"}`, '{"action":"hunt","why":"x","target":3}']) {
      expect(parsePlan(raw).ok).toBe(false)
    }
  })
})

describe('pickFallback / constrainPlan', () => {
  it('回退顺序 hunt → visit → gap;空候选 → null', () => {
    expect(pickFallback([{ action: 'gap' }, { action: 'visit' }])).toBe('visit')
    expect(pickFallback([{ action: 'gap' }])).toBe('gap')
    expect(pickFallback([])).toBeNull()
  })
  it('候选外的动作降级为 none;target 不在 provenIds 里被删掉', () => {
    expect(constrainPlan({ action: 'gap', why: 'w' }, [{ action: 'hunt' }], [])).toEqual({ plan: { action: 'none', why: 'w' }, downgraded: true })
    expect(constrainPlan({ action: 'visit', why: 'w', target: 'zzz' }, [{ action: 'visit' }], ['pair:abc'])).toEqual({ plan: { action: 'visit', why: 'w' }, downgraded: false })
    expect(constrainPlan({ action: 'visit', why: 'w', target: 'pair:abc' }, [{ action: 'visit' }], ['pair:abc']).plan.target).toBe('pair:abc')
  })
})

describe('shouldReask', () => {
  const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString()
  const e = (over: Partial<PlanLogEntry>): PlanLogEntry => ({ at: at(0), chatId: 'c1', candidates: ['hunt'], decision: 'none', why: 'w', source: 'model', ...over })
  it('上一条 model+none 且不到 90 分钟 → 不再问;超过 → 问', () => {
    expect(shouldReask([e({ at: at(PLAN_REASK_MS - 1) })], 'c1', Date.parse(NOW))).toBe(false)
    expect(shouldReask([e({ at: at(PLAN_REASK_MS + 1) })], 'c1', Date.parse(NOW))).toBe(true)
  })
  it('fallback / downgraded / 别的 chat / 上一条不是 none → 都问', () => {
    expect(shouldReask([e({ source: 'fallback' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ source: 'downgraded' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ chatId: 'c2' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ decision: 'hunt' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([], 'c1', Date.parse(NOW))).toBe(true)
  })
})

describe('formatLocal', () => {
  it('固定时区下输出 YYYY-MM-DD HH:mm 周X', () => {
    expect(formatLocal(NOW, 'Asia/Shanghai')).toBe('2026-05-13 10:00 周三')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/companion-plan.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/core/companion-plan.ts`:

```ts
/**
 * 伙伴日程判断(spec 2026-09-05-companion-plan):冷却到了不再「马上做」,
 * 先问伙伴一句「现在要不要」。这里是纯的部分 —— 候选集、prompt、fail-closed
 * 解析、回退顺序、退避;I/O 与执行在 tick-bodies.ts。
 *
 * 红线:模型只能在通过了 shouldSpeak 的候选里选,或选 none;候选外一律降级。
 * 冷却 / care 档 / 无回复暂停只在 calibration.ts,这里不复制一行。
 */
import { shouldSpeak, type CareLedgerEntry, type CareLevel } from '../daemon/companion/calibration'

export type PlanAction = 'hunt' | 'visit' | 'gap' | 'none'
export const PLAN_REASK_MS = 90 * 60_000
export const PLAN_EVAL_TIMEOUT_MS = 20_000
export const PLAN_MAX_OBSERVATIONS = 3
export const PLAN_OBSERVATION_CHARS = 80
export const PLAN_PERSONA_CHARS = 300
export const PLAN_JOURNAL_ITEMS = 3
export const PLAN_TITLE_CHARS = 40
export const PLAN_WHY_CHARS = 120
export const PLAN_EARLIER_ITEMS = 5
export const PLAN_PROVEN_MAX = 5

const ACTIONS: readonly PlanAction[] = ['hunt', 'visit', 'gap', 'none']
const FALLBACK_ORDER: ReadonlyArray<Exclude<PlanAction, 'none'>> = ['hunt', 'visit', 'gap']

export interface Candidate { action: Exclude<PlanAction, 'none'> }
export interface Rejected { action: Exclude<PlanAction, 'none'>; reason: string }
export interface CandidateInput {
  isOwnerChat: boolean
  level: CareLevel
  prefs: { hunt?: boolean; visit?: boolean }
  socialWired: boolean
  nowIso: string
  ledger: CareLedgerEntry
  lastInboundAtIso?: string
}

export function computeCandidates(i: CandidateInput): { candidates: Candidate[]; rejected: Rejected[] } {
  const candidates: Candidate[] = []
  const rejected: Rejected[] = []
  const consider = (action: Exclude<PlanAction, 'none'>, level: CareLevel) => {
    const d = shouldSpeak({ kind: action, level, nowIso: i.nowIso, ledger: i.ledger, lastInboundAtIso: i.lastInboundAtIso })
    if (d.ok) candidates.push({ action })
    else rejected.push({ action, reason: d.reason })
  }
  if (i.isOwnerChat) {
    // 与 tick-bodies 原逻辑一致:pref 明确 false → off,否则 low;care off 由 level 传入时 shouldSpeak 自己拒。
    consider('hunt', i.level === 'off' ? 'off' : (i.prefs.hunt !== false ? 'low' : 'off'))
    if (i.socialWired) consider('visit', i.level === 'off' ? 'off' : (i.prefs.visit !== false ? 'low' : 'off'))
  }
  consider('gap', i.level)
  return { candidates, rejected }
}

export interface PlanContext {
  nowLocal: string
  ownerLastInboundMinutesAgo: number | null
  today: { lastHuntHoursAgo: number | null; lastVisitHoursAgo: number | null; lastProactiveHoursAgo: number | null }
  candidates: Candidate[]
  rejected: Rejected[]
  journal: { unread: number; latest: Array<{ kind: string; title: string; ts: string }> } | null
  social: { openWishes: number; pendingOffers: number; provenChannels: Array<{ id: string; label: string }> } | null
  observations: Array<{ tone: string | null; body: string }>
  personaExcerpt: string
  earlierToday: Array<{ at: string; decision: PlanAction; why: string }>
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

export function buildPlanPrompt(ctx: PlanContext): string {
  const journal = ctx.journal
    ? { unread: ctx.journal.unread, latest: ctx.journal.latest.slice(0, PLAN_JOURNAL_ITEMS).map(x => ({ kind: x.kind, title: cut(x.title, PLAN_TITLE_CHARS), ts: x.ts })) }
    : '没接线'
  const social = ctx.social
    ? { openWishes: ctx.social.openWishes, pendingOffers: ctx.social.pendingOffers, provenChannels: ctx.social.provenChannels.slice(0, PLAN_PROVEN_MAX) }
    : '没接线'
  const observations = ctx.observations.slice(-PLAN_MAX_OBSERVATIONS).map(o => ({ tone: o.tone, body: cut(o.body, PLAN_OBSERVATION_CHARS) }))
  const earlier = ctx.earlierToday.slice(-PLAN_EARLIER_ITEMS).map(e => ({ at: e.at, decision: e.decision, why: cut(e.why, PLAN_WHY_CHARS) }))
  return [
    '你是伙伴自己。下面是此刻的处境,请判断现在要不要出门做一件事。',
    '可选的只有 candidates 里列出的动作(hunt=替主人去网上打猎、visit=去朋友的伙伴家串门、gap=主人好久没说话了问候一句);不想做就 "none"。理由一句话,写给自己看。',
    '判断时想想:主人是不是正在跟你聊(几分钟内有入站就别打扰);今天已经做过什么;包袱里是不是已经堆了主人没看的东西(堆着就别再往里塞);现在这个时间点合不合适;earlierToday 里你之前怎么想的,别每拍都翻来覆去。',
    '只输出 JSON,不要 Markdown、解释、额外字段:{"action":"hunt"|"visit"|"gap"|"none","why":"…"};action 是 visit 时可加 "target",只能是 social.provenChannels 里某一项的 id。',
    '【当前】', JSON.stringify({ nowLocal: ctx.nowLocal, ownerLastInboundMinutesAgo: ctx.ownerLastInboundMinutesAgo }),
    '【今天】', JSON.stringify(ctx.today),
    '【候选】', JSON.stringify(ctx.candidates.map(c => c.action)),
    '【被拒的】', JSON.stringify(ctx.rejected),
    '【包袱】', JSON.stringify(journal),
    '【社交】', JSON.stringify(social),
    '【最近观察】', JSON.stringify(observations),
    '【我的表达倾向】', JSON.stringify(cut(ctx.personaExcerpt, PLAN_PERSONA_CHARS)),
    '【今天之前的判断】', JSON.stringify(earlier),
  ].join('\n')
}

export interface Plan { action: PlanAction; why: string; target?: string }

export function parsePlan(raw: string): { ok: true; plan: Plan } | { ok: false; reason: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let v: unknown
  try { v = JSON.parse(text) } catch { return { ok: false, reason: 'not_json' } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'not_object' }
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'action' && k !== 'why' && k !== 'target') return { ok: false, reason: `unknown_field:${k}` }
  if (typeof o.action !== 'string' || !ACTIONS.includes(o.action as PlanAction)) return { ok: false, reason: 'bad_action' }
  if (typeof o.why !== 'string' || o.why.length === 0 || o.why.length > PLAN_WHY_CHARS) return { ok: false, reason: 'bad_why' }
  if (o.target !== undefined && typeof o.target !== 'string') return { ok: false, reason: 'bad_target' }
  const plan: Plan = { action: o.action as PlanAction, why: o.why }
  if (typeof o.target === 'string') plan.target = o.target
  return { ok: true, plan }
}

export function pickFallback(candidates: Candidate[]): Exclude<PlanAction, 'none'> | null {
  const have = new Set(candidates.map(c => c.action))
  return FALLBACK_ORDER.find(a => have.has(a)) ?? null
}

export function constrainPlan(plan: Plan, candidates: Candidate[], provenIds: readonly string[]): { plan: Plan; downgraded: boolean } {
  if (plan.action === 'none') return { plan: { action: 'none', why: plan.why }, downgraded: false }
  if (!candidates.some(c => c.action === plan.action)) return { plan: { action: 'none', why: plan.why }, downgraded: true }
  const out: Plan = { action: plan.action, why: plan.why }
  if (plan.action === 'visit' && plan.target && provenIds.includes(plan.target)) out.target = plan.target
  return { plan: out, downgraded: false }
}

export interface PlanLogEntry { at: string; chatId: string; candidates: PlanAction[]; decision: PlanAction; why: string; source: 'model' | 'fallback' | 'downgraded' }

export function shouldReask(entries: readonly PlanLogEntry[], chatId: string, nowMs: number): boolean {
  const last = [...entries].reverse().find(e => e.chatId === chatId)
  if (!last || last.source !== 'model' || last.decision !== 'none') return true
  const at = Date.parse(last.at)
  if (Number.isNaN(at)) return true
  return nowMs - at >= PLAN_REASK_MS
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function formatLocal(nowIso: string, tz?: string): string {
  const d = new Date(nowIso)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]))
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} 周${WEEKDAYS[idx] ?? '?'}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/companion-plan.test.ts && bun run typecheck`
Expected: PASS。若 typecheck 因 `core → daemon/companion` 的层级守卫报错,按 Interfaces 里的备选:`computeCandidates` 改为接收 `decide: (kind, level) => { ok: true } | { ok: false; reason }`,测试里传 `shouldSpeak` 的包装;其它不变。

- [ ] **Step 5: 提交**

```bash
git add src/core/companion-plan.ts src/core/companion-plan.test.ts
git commit -m "companion-plan:候选集、给伙伴看的处境、严格 JSON 解析、回退顺序与 90 分钟退避 —— 纯函数"
```

---

### Task 2: `plan-memory.ts` —— `companion/plan-log.json`,按天清零

**Files:**
- Create: `src/daemon/companion/plan-memory.ts`
- Test: `src/daemon/companion/plan-memory.test.ts`

**Interfaces:**
- Consumes: Task 1 `PlanLogEntry`。
- Produces:

```ts
export function readPlanLog(stateDir: string, today: string): PlanLogEntry[]   // 缺 / 坏 / 不是今天 → []
export function appendPlanLog(stateDir: string, today: string, entry: PlanLogEntry): void   // 跨天时先清空再追加
```

`today` 形如 `'2026-05-13'`(调用方用 `formatLocal(nowIso).slice(0, 10)`)。

- [ ] **Step 1: 写失败测试**

`src/daemon/companion/plan-memory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPlanLog, appendPlanLog } from './plan-memory'
import type { PlanLogEntry } from '../../core/companion-plan'

const e = (over: Partial<PlanLogEntry> = {}): PlanLogEntry => ({ at: '2026-05-13T02:00:00.000Z', chatId: 'c1', candidates: ['hunt'], decision: 'none', why: 'w', source: 'model', ...over })

describe('plan-memory', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plan-mem-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('缺文件 → [];追加后能读回;文件里带 day', () => {
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e())
    appendPlanLog(dir, '2026-05-13', e({ decision: 'hunt' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['none', 'hunt'])
  })
  it('跨天:读昨天的文件得 [];追加时先清掉昨天的', () => {
    appendPlanLog(dir, '2026-05-12', e())
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['visit'])
  })
  it('坏 JSON / BOM 前缀 / 形状不对 → [] 且不抛', () => {
    mkdirSync(join(dir, 'companion'), { recursive: true })
    writeFileSync(join(dir, 'companion', 'plan-log.json'), '{not json')
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    writeFileSync(join(dir, 'companion', 'plan-log.json'), '﻿' + JSON.stringify({ day: '2026-05-13', entries: [e()] }))
    expect(readPlanLog(dir, '2026-05-13')).toHaveLength(1)
    writeFileSync(join(dir, 'companion', 'plan-log.json'), JSON.stringify({ day: '2026-05-13', entries: 'nope' }))
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/companion/plan-memory.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/daemon/companion/plan-memory.ts`:

```ts
/**
 * 今天的日程判断记录(spec 2026-09-05-companion-plan §3)。只做两件事:
 * 喂回 prompt 的「今天之前的判断」;实现「说了不做就 90 分钟别再问」。
 * 每天清零 —— 文件里的 day 不是今天就整个丢掉。照 wish-memory.ts 的读写。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { PlanLogEntry } from '../../core/companion-plan'

const dirOf = (stateDir: string) => join(stateDir, 'companion')
const pathOf = (stateDir: string) => join(dirOf(stateDir), 'plan-log.json')

function writeJson(stateDir: string, value: unknown): void {
  const dir = dirOf(stateDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(pathOf(stateDir), JSON.stringify(value, null, 2))
}

export function readPlanLog(stateDir: string, today: string): PlanLogEntry[] {
  try {
    const raw = readJsonFile<{ day?: unknown; entries?: unknown }>(pathOf(stateDir))
    if (!raw || raw.day !== today || !Array.isArray(raw.entries)) return []
    return raw.entries.filter((x): x is PlanLogEntry =>
      !!x && typeof x === 'object' && typeof (x as PlanLogEntry).at === 'string' && typeof (x as PlanLogEntry).chatId === 'string')
  } catch { return [] }
}

export function appendPlanLog(stateDir: string, today: string, entry: PlanLogEntry): void {
  const entries = readPlanLog(stateDir, today)
  entries.push(entry)
  writeJson(stateDir, { day: today, entries })
}
```

(`readJsonFile` 在文件不存在时的行为以仓库实现为准:若它抛错,上面的 try/catch 已兜住;若返回 `null`,`!raw` 已兜住。)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/companion/plan-memory.test.ts src/lib/read-json-file*.test.ts && bun run typecheck`
Expected: PASS(含仓库的 bare-JSON.parse 守卫测试,若它在别的路径,跑一次全量即可)。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/companion/plan-memory.ts src/daemon/companion/plan-memory.test.ts
git commit -m "plan-log.json:今天的判断记录,跨天清零,照 wishes.json 的读写"
```

---

### Task 3: `wire-visit.ts` 暴露 `provenChannels()`

**Files:**
- Modify: `src/daemon/bootstrap/wire-visit.ts`(抽出 `provenChannels`,`startVisitInner` 复用它;`Visit` 接口加方法;返回对象加字段)
- Modify: `src/daemon/bootstrap/wire-social.ts`(`socialPenpal` 透传)
- Modify: `src/daemon/bootstrap/types.ts`(`social.penpal.provenChannels`)
- Test: `src/daemon/bootstrap/wire-visit.test.ts`(追加一条)

**Interfaces:**
- Produces: `Visit.provenChannels(): Array<{ id: string; label: string }>` —— open 且收到过 `kind='visit'` 入站信的信道,label 为 wire-visit 已有的 `peerLabelOf(id)`(「第 N 度的朋友」);`Bootstrap.social.penpal.provenChannels` 同签名。Task 4 用它填 prompt 的 `social.provenChannels`。

- [ ] **Step 1: 写失败测试**

在 `src/daemon/bootstrap/wire-visit.test.ts` 的第一个 describe(`'串门:两只伙伴对着聊'`)里追加一条。文件已有的夹具:`side(name, evalText)` 造一只伙伴(信道恒为 `'ch'`,open,degree 1;`sendEnvelope` 会往对端的 `letters` 推一封 `direction:'in'` 的信并调对端 `onInbound`),`flush()` 等异步落地:

```ts
  it('provenChannels:只列 open 且收到过串门信的信道,带「第 N 度的朋友」label', async () => {
    const fakeEval = (who: string) => async (p: string) =>
      (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一'))
    const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)
    // 还没人来过 → 两边都空
    expect(A.visit.provenChannels()).toEqual([])
    expect(B.visit.provenChannels()).toEqual([])
    // A 去 B 家串门 → B 的 letters 里有 in/visit,B 这边 'ch' 就算 proven;A 收到回话后同样 proven
    await A.visit.startVisit('ch'); await flush()
    expect(B.visit.provenChannels()).toEqual([{ id: 'ch', label: '第 1 度的朋友' }])
    expect(A.visit.provenChannels()).toEqual([{ id: 'ch', label: '第 1 度的朋友' }])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-visit.test.ts -t provenChannels`
Expected: FAIL —— `provenChannels` 不是函数。

- [ ] **Step 3: 实现**

`src/daemon/bootstrap/wire-visit.ts`:

1. `Visit` 接口在 `activeVisit()` 之后加:

```ts
  /** 可以自动去串门的真信道(open 且对方回过串门信),给日程判断当候选目标(spec 2026-09-05-companion-plan)。 */
  provenChannels(): Array<{ id: string; label: string }>
```

2. 在 `startVisitInner` 之前加一个闭包,并让 `startVisitInner` 用它(删掉原来内联的 `const proven = …` 两行,保留那段注释):

```ts
  /** open 且**以前串门成功过**(对方回过 kind='visit' 的信)的真信道 —— 见 startVisitInner 里的注释。 */
  const provenRows = () => deps.channelStore.list().filter(c => c.status === 'open')
    .filter(c => deps.letterStore.listForChannel(c.id).some(l => l.direction === 'in' && l.kind === 'visit'))
  const provenChannels = (): Array<{ id: string; label: string }> => provenRows().map(c => ({ id: c.id, label: peerLabelOf(c.id) }))
```

`startVisitInner` 内:`const proven = provenRows()`(`open` 仍需保留给后面的 `open.find(...)`)。

3. 返回对象加 `provenChannels,`(紧挨 `activeVisit,`)。

`src/daemon/bootstrap/types.ts` 的 `social.penpal` 里 `activeVisit()` 之后加:

```ts
      /** 可自动串门的真信道(spec 2026-09-05-companion-plan)。 */
      provenChannels(): Array<{ id: string; label: string }>
```

`src/daemon/bootstrap/wire-social.ts` 的 `socialPenpal = { …, startVisit: …, activeVisit: … }` 里加 `provenChannels: () => visit.provenChannels()`(与 `activeVisit` 同一写法)。

spec 对齐:`docs/superpowers/specs/2026-09-05-companion-plan-design.md` §2 表格里 `provenChannels:[label]` 与 `provenChannelLabels()` 改为 `provenChannels:[{ id, label }]` 与 `provenChannels()`;§4 改动清单同一行同步;§2 输出格式那句改为「`target` 只能是 `social.provenChannels` 里某一项的 **id**」。原因:`startVisit` 按信道 id 解析,而 wire-visit 的 label 是「第 N 度的朋友」,不唯一。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/bootstrap/ && bun run typecheck`
Expected: PASS(`bootstrap.test.ts` 若对 `social.penpal` 的键集合有断言,只允许追加 `provenChannels`)。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/bootstrap/wire-visit.ts src/daemon/bootstrap/wire-visit.test.ts src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/types.ts docs/superpowers/specs/2026-09-05-companion-plan-design.md
git commit -m "wire-visit:provenChannels() —— 能自动去串门的信道列出来,给日程判断当候选目标;spec 改成 id+label"
```

---

### Task 4: `tick-bodies.ts` —— 三段收成执行函数,中间插判断;全量

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts`(`TickDeps.planEval?`、`TickDeps.huntStore` 加可选 `list` / `summary`、`pushTickForChat`)
- Test: `src/daemon/wiring/tick-bodies.test.ts`(追加 describe)
- Full: `bun run typecheck && bun --bun vitest run`

**Interfaces:**
- Consumes: Task 1 全部;Task 2 `readPlanLog` / `appendPlanLog`;Task 3 `boot.social.penpal.provenChannels()`;既有 `readJournalSeen`(`src/core/journal-seen.ts`)、`makeObservationsStore(deps.db, chatId, { migrateFromFile })`(tick-bodies 已 import)、`boot.registry.getCheapEval()`。
- Produces: `TickDeps.planEval?: CheapEval`(测试注入;缺省 `boot.registry.getCheapEval() ?? null`);`TickDeps.huntStore.list?(limit)` / `summary?(seenUntil)`(main.ts 传的是完整 `Journal`,自动满足)。

- [ ] **Step 1: 写失败测试**

在 `src/daemon/wiring/tick-bodies.test.ts` 末尾追加(复用文件里的 `setupDeps` / `withVisit` / `cleanup`;`planEval` 通过 `buildTickBodies({ ...s.deps, planEval })` 注入):

```ts
describe('日程判断(spec 2026-09-05-companion-plan)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }) } catch { /* */ } } })
  const NOW = '2026-05-13T10:00:00.000Z'
  const planEvalOf = (raw: string | Error) => vi.fn(async () => { if (raw instanceof Error) throw raw; return raw })

  it('候选 [hunt, visit],模型选 visit → 只出门不打猎;prompt 含两个候选', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"visit","why":"上午没人聊"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).toHaveBeenCalledOnce()
    expect(planEval.mock.calls[0]![0]).toContain('"hunt"')
    expect(planEval.mock.calls[0]![0]).toContain('"visit"')
    expect(startVisit).toHaveBeenCalledOnce()
    expect(s.dispatch).not.toHaveBeenCalled()                       // 没打猎
    expect(s.careLedgerEntries['chat-1']?.lastVisitAtIso).toBe(NOW)
    expect(s.careLedgerEntries['chat-1']?.lastHuntAtIso).toBeUndefined()
    expect(s.logs.some(l => l.startsWith('PLAN|') && l.includes('→ visit'))).toBe(true)
  })

  it('模型选 none → 什么都不发,plan-log 多一条;10 分钟后再跑一拍不再问(退避)', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"none","why":"主人在聊"}')
    const ticks = buildTickBodies({ ...s.deps, planEval })
    await ticks.pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(readPlanLog(s.stateDir, formatLocal(NOW).slice(0, 10))).toHaveLength(1)
    await ticks.pushTick({ nowIso: '2026-05-13T10:10:00.000Z' })
    expect(planEval).toHaveBeenCalledOnce()                         // 第二拍没问
    expect(s.logs.some(l => l.includes('reason=backoff'))).toBe(true)
  })

  it('模型选了候选外的 gap → 降级为 none,日志含 downgraded,不发', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"gap","why":"想问候"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('downgraded'))).toBe(true)
  })

  it('模型抛错 / 回非 JSON → 回退旧顺序:先打猎', async () => {
    for (const bad of [new Error('boom'), 'not json']) {
      const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
      cleanup.push(s.stateDir)
      const startVisit = withVisit(s, { hasOpen: true })
      await buildTickBodies({ ...s.deps, planEval: planEvalOf(bad) }).pushTick({ nowIso: NOW })
      expect(s.dispatch).toHaveBeenCalledOnce()                     // 打猎
      expect(startVisit).not.toHaveBeenCalled()
      expect(s.logs.some(l => l.includes('PLAN|fallback'))).toBe(true)
    }
  })

  it('模型超时 → 回退旧顺序', async () => {
    vi.useFakeTimers()
    try {
      const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
      cleanup.push(s.stateDir)
      const planEval = vi.fn(() => new Promise<string>(() => { /* never */ }))
      const p = buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
      await vi.advanceTimersByTimeAsync(PLAN_EVAL_TIMEOUT_MS + 1)
      await p
      expect(s.dispatch).toHaveBeenCalledOnce()
      expect(s.logs.some(l => l.includes('reason=timeout'))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('没有 planEval 且 registry 没有 cheapEval → 旧行为,不写 plan-log', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    await buildTickBodies(s.deps).pushTick({ nowIso: NOW })
    expect(s.dispatch).toHaveBeenCalledOnce()                       // 打猎(旧顺序第一)
    expect(s.logs.some(l => l.includes('reason=no_evaluator'))).toBe(true)
  })

  it('agenda 到期 → 直接发 agenda,planEval 从未被调', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false, agendaMd: '- [ ] 问问搬家 (due: 2026-05-13)' })
    cleanup.push(s.stateDir)
    const planEval = planEvalOf('{"action":"none","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('候选为空(打猎与串门都在冷却、安静不够久)→ planEval 从未被调', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1', inFlight: false,
      careLedgerEntries: { 'chat-1': { lastHuntAtIso: '2026-05-13T09:00:00.000Z', lastVisitAtIso: '2026-05-13T09:30:00.000Z', lastProactiveAtIso: '2026-05-13T09:00:00.000Z', noReplyCount: 0 } },
    })
    cleanup.push(s.stateDir)
    withVisit(s, { hasOpen: true })
    const planEval = planEvalOf('{"action":"hunt","why":"x"}')
    await buildTickBodies({ ...s.deps, planEval }).pushTick({ nowIso: NOW })
    expect(planEval).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
  })

  it('visit 带候选 id 的 target → startVisit(target);不在候选里 → startVisit()', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const startVisit = withVisit(s, { hasOpen: true })
    ;(s.deps.boot as unknown as { social: { penpal: Record<string, unknown> } }).social.penpal.provenChannels = () => [{ id: 'ch', label: '第 1 度的朋友' }]
    await buildTickBodies({ ...s.deps, planEval: planEvalOf('{"action":"visit","why":"w","target":"ch"}') }).pushTick({ nowIso: NOW })
    expect(startVisit).toHaveBeenCalledWith('ch')
    const s2 = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s2.stateDir)
    const startVisit2 = withVisit(s2, { hasOpen: true })
    ;(s2.deps.boot as unknown as { social: { penpal: Record<string, unknown> } }).social.penpal.provenChannels = () => [{ id: 'ch', label: '第 1 度的朋友' }]
    await buildTickBodies({ ...s2.deps, planEval: planEvalOf('{"action":"visit","why":"w","target":"zzz"}') }).pushTick({ nowIso: NOW })
    expect(startVisit2).toHaveBeenCalledWith()
  })
})
```

文件顶部的 import 加:`import { readPlanLog } from '../companion/plan-memory'` 与 `import { formatLocal, PLAN_EVAL_TIMEOUT_MS } from '../../core/companion-plan'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts -t 日程判断`
Expected: FAIL —— `planEval` 不是 `TickDeps` 字段(typecheck)/ 模型从未被调 / 日志没有 `PLAN|`。

- [ ] **Step 3: 实现**

`src/daemon/wiring/tick-bodies.ts`:

1. import:

```ts
import type { CheapEval } from '../../core/agent-provider'
import {
  computeCandidates, buildPlanPrompt, parsePlan, pickFallback, constrainPlan, shouldReask, formatLocal,
  PLAN_EVAL_TIMEOUT_MS, PLAN_MAX_OBSERVATIONS, PLAN_JOURNAL_ITEMS,
  type PlanAction, type PlanContext, type PlanLogEntry,
} from '../../core/companion-plan'
import { readPlanLog, appendPlanLog } from '../companion/plan-memory'
import { readJournalSeen } from '../../core/journal-seen'
import { readFileSync } from 'node:fs'
```

2. `TickDeps`:`huntStore?` 加两个可选方法;新增 `planEval?`:

```ts
  huntStore?: {
    recordHunt(a: { chatId: string; text: string; nowIso?: string }): number
    recordVisit?(a: { chatId: string; text: string; peerLabel: string; nowIso?: string }): string | null
    /** 日程判断用(spec 2026-09-05-companion-plan):包袱里最近几条 + 没看的数量。main.ts 传的是完整 Journal。 */
    list?(limit?: number): Array<{ kind: string; title: string; ts: string }>
    summary?(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
  }
  /**
   * 日程判断的便宜模型(spec 2026-09-05-companion-plan)。测试注入;缺省
   * `boot.registry.getCheapEval()`。没有 → 回退到固定顺序 hunt → visit → gap。
   */
  planEval?: CheapEval
```

3. `pushTickForChat` 里,把原来 hunt 段(从 `if (chatId === defaultChatId) {` 到 visit 段结束的 `}`)和 gap 段(`const decision = shouldSpeak({ kind: 'gap', … })` 到函数末尾)**原样**搬进三个局部 async 函数 `runHunt()`、`runVisit(target?: string)`、`runGap()`,只做这些改动:
   - 三个函数**不再**自己调 `shouldSpeak`(判定已由 `computeCandidates` 做过),也不再打 `CARE skip` 日志(由下面统一打);其余(claim、busy token、旁听入库、`startVisit`、`buildGapCheckinText` 的 `daysSinceContact` 计算)逐字保留。
   - `runVisit(target)`:`const r = await visit.startVisit(target)`(`target` 为 undefined 时等价于原来的 `startVisit()`)。
   
   然后在 agenda 段的 `return` 之后写:

```ts
    // ── 日程判断(spec 2026-09-05-companion-plan)──────────────────────────
    // 候选由代码算(三次 shouldSpeak,冷却 / care 门 / 无回复暂停一律不变);
    // 模型只能在候选里选一个或选 none。没有模型 / 超时 / 解析失败 → 固定顺序。
    const socialWired = !!deps.boot.social?.penpal
    const { candidates, rejected } = computeCandidates({
      isOwnerChat: chatId === defaultChatId, level,
      prefs: deps.chatPrefs.get(chatId), socialWired, nowIso, ledger, lastInboundAtIso,
    })
    for (const r of rejected) deps.log('CARE', `skip chat=${chatId} kind=${r.action} reason=${r.reason}`)
    if (candidates.length === 0) return

    const today = formatLocal(nowIso).slice(0, 10)
    const nowMs = Date.parse(nowIso)
    const run = async (action: PlanAction, target?: string) => {
      if (action === 'hunt') await runHunt()
      else if (action === 'visit') await runVisit(target)
      else if (action === 'gap') await runGap()
    }
    const record = (decision: PlanAction, why: string, source: PlanLogEntry['source']) => {
      try { appendPlanLog(deps.stateDir, today, { at: nowIso, chatId, candidates: candidates.map(c => c.action), decision, why, source }) }
      catch (err) { deps.log('PLAN', `plan-log 写不进去(不影响这一拍): ${errMsg(err)}`) }
    }
    const fallback = async (reason: string) => {
      const pick = pickFallback(candidates)!
      deps.log('PLAN', `fallback chat=${chatId} reason=${reason} → ${pick}`)
      record(pick, `fallback:${reason}`, 'fallback')
      await run(pick)
    }

    const evaluate = deps.planEval ?? deps.boot.registry.getCheapEval() ?? null
    if (!evaluate) { await fallback('no_evaluator'); return }

    const earlier = readPlanLog(deps.stateDir, today)
    if (!shouldReask(earlier, chatId, nowMs)) { deps.log('PLAN', `skip chat=${chatId} reason=backoff`); return }

    const proven = socialWired ? (deps.boot.social!.penpal.provenChannels?.() ?? []) : []
    const ctx = await buildContext()   // 见下
    deps.log('PLAN', `ask chat=${chatId} candidates=[${candidates.map(c => c.action).join(',')}]`)

    let raw: string
    try {
      raw = await Promise.race([
        evaluate(buildPlanPrompt(ctx)),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PLAN_EVAL_TIMEOUT_MS)),
      ])
    } catch (err) {
      await fallback(err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error')
      return
    }
    const parsed = parsePlan(raw)
    if (!parsed.ok) { await fallback(`parse:${parsed.reason}`); return }
    const { plan, downgraded } = constrainPlan(parsed.plan, candidates, proven.map(p => p.id))
    if (downgraded) deps.log('PLAN', `downgraded chat=${chatId} action=${parsed.plan.action} → none`)
    deps.log('PLAN', `→ ${plan.action}${plan.target ? ` target=${plan.target}` : ''} (${plan.why})`)
    record(plan.action, plan.why, downgraded ? 'downgraded' : 'model')
    if (plan.action === 'none') return
    await run(plan.action, plan.target)
```

   其中 `buildContext` 是同一作用域内的局部函数(只读、每个来源各自 try/catch,任何一处失败都退化为空 / null,绝不让判断这一步抛):

```ts
    async function buildContext(): Promise<PlanContext> {
      const hoursAgo = (iso?: string) => iso && !Number.isNaN(Date.parse(iso)) ? Math.round((nowMs - Date.parse(iso)) / 3_600_000) : null
      let journal: PlanContext['journal'] = null
      try {
        if (deps.huntStore?.summary && deps.huntStore.list) {
          const s = deps.huntStore.summary(readJournalSeen(deps.stateDir))
          journal = { unread: s.unread, latest: deps.huntStore.list(PLAN_JOURNAL_ITEMS).map(x => ({ kind: x.kind, title: x.title, ts: x.ts })) }
        }
      } catch { journal = null }
      let social: PlanContext['social'] = null
      try {
        const so = deps.boot.social
        if (so) social = {
          openWishes: so.wish.list().filter(w => w.effective === 'open').length,
          pendingOffers: so.intro.offers().length,
          provenChannels: proven,
        }
      } catch { social = null }
      let observations: PlanContext['observations'] = []
      try {
        const rows = await makeObservationsStore(deps.db, chatId, { migrateFromFile: join(deps.stateDir, 'memory', chatId, 'observations.jsonl') }).listActive()
        observations = rows.slice(-PLAN_MAX_OBSERVATIONS).map(o => ({ tone: o.tone ?? null, body: o.body }))
      } catch { observations = [] }
      let personaExcerpt = ''
      try { personaExcerpt = readFileSync(join(deps.stateDir, 'memory', chatId, 'persona.md'), 'utf8') } catch { personaExcerpt = '' }
      return {
        nowLocal: formatLocal(nowIso),
        ownerLastInboundMinutesAgo: lastInboundAtIso ? Math.round((nowMs - Date.parse(lastInboundAtIso)) / 60_000) : null,
        today: { lastHuntHoursAgo: hoursAgo(ledger.lastHuntAtIso), lastVisitHoursAgo: hoursAgo(ledger.lastVisitAtIso), lastProactiveHoursAgo: hoursAgo(ledger.lastProactiveAtIso) },
        candidates, rejected, journal, social, observations, personaExcerpt,
        earlierToday: earlier.filter(e => e.chatId === chatId).map(e => ({ at: e.at, decision: e.decision, why: e.why })),
      }
    }
```

   注意:`makeObservationsStore` 与 `join` 在文件里已 import;`errMsg` 已存在(旁听入库那里在用)。`readFileSync` 不是 JSON 读,不触发 readJsonFile 守卫。

4. 既有 hunt / visit / gap 的 `CARE skip … reason=` 日志格式必须保持 `kind=<x> reason=<y>`,因为既有测试 `l.includes('kind=visit') && l.includes('visit_cooldown')` 依赖它 —— 上面的统一日志正是这个格式。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts && bun run typecheck`
Expected: PASS —— 新 describe 全过;**既有** tick 测试(它们的 registry 没有 cheapEval)自然走 `no_evaluator` 回退,一条不改也全过。

然后全量:`bun run typecheck && bun --bun vitest run`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "pushTick:打猎 / 串门 / 问候冷却到了先问伙伴一句现在要不要 —— 候选代码算,模型只能少做,没模型照旧"
```

---

## 完成后(真机)

- 日志里应能看到 `PLAN ask chat=… candidates=[hunt,visit]` → `PLAN → none (主人正在聊)` / `PLAN → hunt (上午,包袱是空的)`;`PLAN skip reason=backoff` 在两次 none 之间出现;打猎和串门仍各不超过一天一次(`CARE skip … hunt_cooldown` / `visit_cooldown` 照旧)。
- 没配便宜模型的机器:每拍一行 `PLAN fallback reason=no_evaluator → hunt`,行为与升级前完全一样。
- memory:新建 `companion-plan-shipped`;`social-tools-shipped` 的「下一项」改为已做。
