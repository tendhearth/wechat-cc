# 随身 CC 首屏「伙伴的一天」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/m` 手机页首屏换成伙伴的一天——三个已有来源(journal / plan-log / turn_records)读时合并成一条只读事件流,外加当下 presence;断连时给带时间戳的缓存。

**Architecture:** 纯函数 `src/daemon/mobile-feed.ts` 做映射/合并/分页(无 IO);settings-panel 新增三个 `/m/api/*` 路由,IO 全部经 `SettingsPanelDeps` 注入;presence 从 `routes-presence.ts` 抽成 `computePresence` 经 internal-api lifecycle 暴露,不在手机侧第二次拼输入;plan-log 留存从「只留当天」改为「留 14 天」,`readPlanLog(today)` 语义不变。页面无框架单文件,缓存在 `localStorage`,事件可缓存、presence 永不缓存。

**Tech Stack:** Bun + TypeScript,vitest(`bun --bun vitest run`),bun:sqlite(`openDb({ path: ':memory:' })` 可建内存库),无前端框架。

**Spec:** `docs/superpowers/specs/2026-09-06-mobile-home-feed-design.md`

## Global Constraints

- 测试命令:`bun --bun vitest run <file>`;类型检查:`bun run typecheck`(= `tsc --noEmit`)
- 事件信封:`{ id, ts, kind, title, note, day, ref? }`,`kind` 开放;`id` 形如 `journal:<id>` / `thought:<at>` / `chat_day:<YYYY-MM-DD>`
- 排序:`ts` 降序,同 `ts` 按 `id` 升序;游标 = base64url(`${ts}|${id}`)
- 三源窗口:journal `list(200)`、plan-log 最近 14 天、turn_records 最近 14 天;`limit` 缺省 30、上限 100
- `thought`:`why` 以 `(failed) ` / `(skipped) ` 开头 → title「想出门,没走成」、note null;`note = why` 仅当 `source === 'model'`
- `chat_day`:只算 `outcome === 'completed'`;客人不列名字;按伙伴时区(`companion/config.json.timezone`)分桶
- 单源失败不 500:进 `sources_degraded`;presence 拿不到 → `presence: null` + `presence_error: 'unavailable'`
- 水位 `POST /m/api/seen`:非法 → 400 `invalid_until`;夹到 now;单调不后退;`seen` dep 缺 → 503 `seen_not_wired`
- 页面:缓存键 `cc.home.v1`;缓存的 presence 永不渲染;推水位用服务端 `synced_at`
- 中文文案照 spec §6 原文;不做视觉/精灵/推送/写操作
- 提交信息用中文,风格同仓库近期 commit(一句话说清「改了什么、为什么」)

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/daemon/companion/plan-memory.ts`(改) | plan-log 留 14 天;新增 `readPlanLogDays` |
| `src/daemon/internal-api/routes-presence.ts`(改) | 抽出 `computePresence(deps)`;路由调它 |
| `src/daemon/internal-api/index.ts` / `lifecycle.ts` / `types.ts`(改) | 暴露 `getPresence()` |
| `src/daemon/mobile-feed.ts`(新) | 纯函数:三源映射、合并、游标、未读、时区分桶 |
| `src/daemon/settings-panel.ts`(改) | `SettingsPanelDeps` 新字段;`/m/api/home`、`/m/api/feed`、`/m/api/seen` |
| `src/daemon/settings-panel-html.ts`(改) | `phoneHtml`:「今天」tab + 缓存/横幅/空态;原三块并入「口袋」 |
| `src/daemon/wiring/pipeline-deps.ts` + `wiring/index.ts` + `main.ts`(改) | 注入 feed / presence / seen;传 `turns` 与 `presence` |
| `docs/architecture.md`(改) | 随身 CC 段落补 feed 一句 |

---

### Task 1: plan-log 留 14 天

**Files:**
- Modify: `src/daemon/companion/plan-memory.ts`
- Test: `src/daemon/companion/plan-memory.test.ts`

**Interfaces:**
- Consumes: `PlanLogEntry`(`src/core/companion-plan.ts:144`:`{ at, chatId, candidates, decision, why, source: 'model'|'fallback'|'downgraded' }`)
- Produces: `readPlanLog(stateDir, today): PlanLogEntry[]`(签名与语义不变)、`appendPlanLog(stateDir, today, entry): void`(不变)、**新** `readPlanLogDays(stateDir: string, days: number): PlanLogEntry[]`(最近 `days` 个有记录的天,按 `at` 升序拍平)、**新** `PLAN_LOG_KEEP_DAYS = 14`

- [ ] **Step 1: 改现有跨天测试并加三条新测试**

在 `src/daemon/companion/plan-memory.test.ts` 里把 `import { readPlanLog, appendPlanLog } from './plan-memory'` 改为 `import { readPlanLog, appendPlanLog, readPlanLogDays, PLAN_LOG_KEEP_DAYS } from './plan-memory'`,把「跨天」那条测试整体替换为下面第一条,并在 describe 末尾追加另外三条:

```ts
  it('跨天:读昨天仍读得到(留存),读今天得 [];追加今天不抹昨天', () => {
    appendPlanLog(dir, '2026-05-12', e())
    expect(readPlanLog(dir, '2026-05-13')).toEqual([])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['visit'])
    expect(readPlanLog(dir, '2026-05-12').map(x => x.decision)).toEqual(['none'])
  })
  it('readPlanLogDays:按 at 升序拍平,days 限制取最近几天', () => {
    appendPlanLog(dir, '2026-05-11', e({ at: '2026-05-11T01:00:00.000Z', decision: 'hunt' }))
    appendPlanLog(dir, '2026-05-13', e({ at: '2026-05-13T03:00:00.000Z', decision: 'visit' }))
    appendPlanLog(dir, '2026-05-13', e({ at: '2026-05-13T01:00:00.000Z', decision: 'none' }))
    expect(readPlanLogDays(dir, 14).map(x => x.decision)).toEqual(['hunt', 'none', 'visit'])
    expect(readPlanLogDays(dir, 1).map(x => x.decision)).toEqual(['none', 'visit'])
    expect(readPlanLogDays(dir, 0)).toEqual([])
  })
  it('只留最近 PLAN_LOG_KEEP_DAYS 天', () => {
    for (let d = 1; d <= PLAN_LOG_KEEP_DAYS + 3; d++) {
      const day = `2026-06-${String(d).padStart(2, '0')}`
      appendPlanLog(dir, day, e({ at: `${day}T00:00:00.000Z` }))
    }
    expect(readPlanLog(dir, '2026-06-01')).toEqual([])
    expect(readPlanLog(dir, '2026-06-03')).toEqual([])
    expect(readPlanLog(dir, '2026-06-04')).toHaveLength(1)
    expect(readPlanLogDays(dir, 99)).toHaveLength(PLAN_LOG_KEEP_DAYS)
  })
  it('旧形状 {day, entries} 读得出,追加后迁成 {days}', () => {
    mkdirSync(join(dir, 'companion'), { recursive: true })
    writeFileSync(join(dir, 'companion', 'plan-log.json'), JSON.stringify({ day: '2026-05-13', entries: [e({ decision: 'hunt' })] }))
    expect(readPlanLog(dir, '2026-05-13').map(x => x.decision)).toEqual(['hunt'])
    appendPlanLog(dir, '2026-05-13', e({ decision: 'visit' }))
    const raw = JSON.parse(readFileSync(join(dir, 'companion', 'plan-log.json'), 'utf8')) as { days?: Record<string, unknown[]> }
    expect(Object.keys(raw.days ?? {})).toEqual(['2026-05-13'])
    expect(raw.days!['2026-05-13']).toHaveLength(2)
  })
```

测试文件顶部 `node:fs` 的 import 加上 `readFileSync`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/companion/plan-memory.test.ts`
Expected: FAIL —— `readPlanLogDays is not a function` / 跨天那条读昨天得 `[]`

- [ ] **Step 3: 实现留存**

把 `src/daemon/companion/plan-memory.ts` 的 `readPlanLog` 与 `appendPlanLog` 整体替换为:

```ts
/** 留几天。spec 2026-09-06-mobile-home-feed §5.1:手机 feed 要看历史,不再每天清零。 */
export const PLAN_LOG_KEEP_DAYS = 14

type DaysShape = { days: Record<string, PlanLogEntry[]> }

const isEntry = (x: unknown): x is PlanLogEntry =>
  !!x && typeof x === 'object' && typeof (x as PlanLogEntry).at === 'string' && typeof (x as PlanLogEntry).chatId === 'string'

/** 读整个文件成 {days};旧形状 {day, entries} 视为只有那一天。坏文件 → 空。 */
function readAll(stateDir: string): DaysShape {
  try {
    const raw = readJsonFile<{ day?: unknown; entries?: unknown; days?: unknown }>(pathOf(stateDir))
    if (!raw || typeof raw !== 'object') return { days: {} }
    if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      const days: Record<string, PlanLogEntry[]> = {}
      for (const [day, list] of Object.entries(raw.days as Record<string, unknown>)) {
        if (Array.isArray(list)) days[day] = list.filter(isEntry)
      }
      return { days }
    }
    if (typeof raw.day === 'string' && Array.isArray(raw.entries)) {
      return { days: { [raw.day]: raw.entries.filter(isEntry) } }
    }
    return { days: {} }
  } catch { return { days: {} } }
}

export function readPlanLog(stateDir: string, today: string): PlanLogEntry[] {
  return readAll(stateDir).days[today] ?? []
}

/** 最近 `days` 个有记录的天,按 at 升序拍平。days ≤ 0 → []。 */
export function readPlanLogDays(stateDir: string, days: number): PlanLogEntry[] {
  if (!(days > 0)) return []
  const all = readAll(stateDir).days
  const keys = Object.keys(all).sort().slice(-days)
  return keys.flatMap(k => all[k] ?? []).sort((a, b) => a.at.localeCompare(b.at))
}

export function appendPlanLog(stateDir: string, today: string, entry: PlanLogEntry): void {
  const all = readAll(stateDir).days
  all[today] = [...(all[today] ?? []), entry]
  const keep = Object.keys(all).sort().slice(-PLAN_LOG_KEEP_DAYS)
  const days: Record<string, PlanLogEntry[]> = {}
  for (const k of keep) days[k] = all[k]!
  writeJson(stateDir, { days })
}
```

文件头注释里「每天清零 —— 文件里的 day 不是今天就整个丢掉」改为「留最近 14 天(手机 feed 要看历史),`readPlanLog(today)` 仍只回今天的」。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/companion/plan-memory.test.ts`
Expected: PASS(6 条)

- [ ] **Step 5: 确认 tick-bodies 没被影响 + 类型**

Run: `bun --bun vitest run src/daemon/wiring && bun run typecheck`
Expected: PASS;typecheck 无错

- [ ] **Step 6: Commit**

```bash
git add src/daemon/companion/plan-memory.ts src/daemon/companion/plan-memory.test.ts
git commit -m "plan-log 留 14 天不再每天清零(手机 feed 要看历史);readPlanLog(today) 语义不变"
```

---

### Task 2: presence 抽出共用,internal-api 暴露 getPresence

**Files:**
- Modify: `src/daemon/internal-api/routes-presence.ts`
- Modify: `src/daemon/internal-api/index.ts:355-358`(`setPetTurn` 旁)
- Modify: `src/daemon/internal-api/lifecycle.ts:6-24`、`:48-62`
- Modify: `src/daemon/internal-api/types.ts:539`(`setPetTurn` 旁)
- Test: `src/daemon/internal-api/routes-presence.test.ts`

**Interfaces:**
- Consumes: `derivePresence(inputs): Presence`(`src/core/companion-presence.ts`)、`InternalApiDeps`
- Produces: `computePresence(deps: InternalApiDeps): Promise<Presence | null>`(`null` = journal 没接);`InternalApiLifecycle.getPresence(): Promise<Presence | null>`

- [ ] **Step 1: 加测试**

在 `src/daemon/internal-api/routes-presence.test.ts` 的 import 里把 `import { presenceRoutes } from './routes-presence'` 改为 `import { presenceRoutes, computePresence } from './routes-presence'`,并在文件末尾追加:

```ts
describe('computePresence(共用)', () => {
  it('和路由吐一样的东西;journal 没接 → null', async () => {
    const d = deps()
    const viaRoute = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    const direct = await computePresence(d)
    expect(direct).toEqual(viaRoute.body)
    expect(await computePresence(deps({ hunt: undefined }))).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-presence.test.ts`
Expected: FAIL —— `computePresence` 不是导出

- [ ] **Step 3: 抽函数**

把 `src/daemon/internal-api/routes-presence.ts` 的 `presenceRoutes` 整体替换为:

```ts
import type { Presence } from '../../core/companion-presence'

/**
 * 三轴的唯一组装点。路由和随身 CC 手机页(经 lifecycle.getPresence)都调它
 * —— 两个界面一个事实(spec 2026-09-06-mobile-home-feed §5.2)。
 * 返回 null = journal 没接(路由据此 503,手机页据此显示「不知道」)。
 */
export async function computePresence(deps: InternalApiDeps): Promise<Presence | null> {
  if (!deps.hunt) return null
  let ownerChatId: string | null = null
  try { ownerChatId = loadCompanionConfig(deps.stateDir).default_chat_id } catch { ownerChatId = null }
  // 「在聊」看的是**入站**时间,不是会话的 lastUsedAt —— 打猎 / 关心推送 /
  // 提醒这些伙伴自己的外发也会 bump lastUsedAt,拿它当证据熊就会在主人
  // 一言未发时说「在跟你聊」(spec 2026-09-03 §2.1)。没接 latestInboundTs
  // 就一律当 null:没有入站证据,就不算在聊。
  const sessions = await Promise.all((deps.listSessions?.() ?? []).map(async s => {
    let iso: string | null = null
    try { iso = (await deps.latestInboundTs?.(s.chatId)) ?? null } catch { iso = null }
    const ms = iso ? Date.parse(iso) : NaN
    return { chatId: s.chatId, lastInboundAt: Number.isFinite(ms) ? ms : null }
  }))
  return derivePresence({
    nowMs: Date.now(),
    ownerChatId,
    sessions,
    busyLabels: deps.busyLabels?.() ?? [],
    visit: deps.social?.penpal?.activeVisit?.() ?? null,
    outbound: deps.outbound?.().state ?? null,
    subsystemsDegraded: (deps.subsystems?.() ?? []).filter(s => s.state === 'degraded').length,
    journal: deps.hunt.summary(readJournalSeen(deps.stateDir)),
  })
}

export function presenceRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/presence': async () => {
      const body = await computePresence(deps)
      if (!body) return { status: 503, body: { error: 'journal_not_wired' } }
      return { status: 200, body }
    },
  }
}
```

(把 `import type { Presence }` 放到文件现有 import 区。)

- [ ] **Step 4: 暴露到 lifecycle**

`src/daemon/internal-api/index.ts`:在 `setPetTurn(fn) { deps.petTurn = fn },` 后面加

```ts
    getPresence() {
      return computePresence(deps)
    },
```

并在文件顶部 import 区加 `import { computePresence } from './routes-presence'`。

`src/daemon/internal-api/types.ts`:在 `setPetTurn(fn: ...): void` 那一行后加

```ts
  /** 三轴 presence 的共用入口(随身 CC 手机页经此读,不自己拼输入)。null = journal 没接。 */
  getPresence(): Promise<import('../../core/companion-presence').Presence | null>
```

`src/daemon/internal-api/lifecycle.ts`:接口 `InternalApiLifecycle` 里 `setPetTurn(...)` 后加

```ts
  getPresence(): Promise<import('../../core/companion-presence').Presence | null>
```

返回对象里 `setPetTurn: (fn) => api.setPetTurn(fn),` 后加

```ts
    getPresence: () => api.getPresence(),
```

- [ ] **Step 5: 跑测试 + 类型**

Run: `bun --bun vitest run src/daemon/internal-api/routes-presence.test.ts && bun run typecheck`
Expected: PASS;typecheck 无错(若 `bun run typecheck` 报有别的测试文件用 `as unknown as InternalApiLifecycle` 造假对象缺 `getPresence`,给那些假对象补 `getPresence: async () => null`)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/routes-presence.ts src/daemon/internal-api/routes-presence.test.ts src/daemon/internal-api/index.ts src/daemon/internal-api/lifecycle.ts src/daemon/internal-api/types.ts
git commit -m "presence 组装抽成 computePresence 经 lifecycle.getPresence 共用——手机页不再第二次拼输入"
```

---

### Task 3: `mobile-feed.ts` 纯函数

**Files:**
- Create: `src/daemon/mobile-feed.ts`
- Test: `src/daemon/mobile-feed.test.ts`

**Interfaces:**
- Consumes: `CatchRow`(`src/core/journal-store.ts:19`)、`PlanLogEntry`
- Produces:

```ts
export type FeedKind = 'hunt' | 'visit' | 'postcard' | 'thought' | 'chat_day'
export type FeedSource = 'journal' | 'thought' | 'chat_day'
export interface FeedEvent {
  id: string; ts: string; kind: FeedKind; title: string; note: string | null
  /** 伙伴时区下的 YYYY-MM-DD,页面按它分组 */
  day: string
  ref?: { url: string | null; image_svg: string | null; status: string }
}
export interface TurnLite { chatId: string; endedAt: number; outcome: string }
export interface FeedSources {
  journal: readonly CatchRow[] | null      // null = 这次没读到
  thoughts: readonly PlanLogEntry[] | null
  turns: readonly TurnLite[] | null
}
export interface FeedOpts {
  ownerChatId: string | null; timezone: string
  cursor?: string | null; limit?: number; seenUntil?: string | null
}
export interface FeedResult { events: FeedEvent[]; next_cursor: string | null; unread: number; sources_degraded: FeedSource[] }
export const FEED_DEFAULT_LIMIT = 30
export const FEED_MAX_LIMIT = 100
export function dayKey(ms: number, timezone: string): string
export function thoughtEvent(e: PlanLogEntry, timezone: string): FeedEvent
export function chatDayEvents(turns: readonly TurnLite[], ownerChatId: string | null, timezone: string): FeedEvent[]
export function encodeCursor(ts: string, id: string): string
export function decodeCursor(s: string): { ts: string; id: string } | null
export function buildFeed(src: FeedSources, opts: FeedOpts): FeedResult
```

- [ ] **Step 1: 写测试**

`src/daemon/mobile-feed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFeed, chatDayEvents, dayKey, decodeCursor, encodeCursor, thoughtEvent, FEED_MAX_LIMIT, type TurnLite } from './mobile-feed'
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'

const TZ = 'Asia/Shanghai'
const row = (over: Partial<CatchRow> = {}): CatchRow => ({
  id: 'j1', ts: '2026-09-06T02:43:36.412Z', chat_id: 'o', title: '一个好玩的东西', url: 'https://x', note: '', status: 'new', kind: 'hunt', image_svg: null, ...over,
})
const plan = (over: Partial<PlanLogEntry> = {}): PlanLogEntry => ({
  at: '2026-09-06T03:03:55.347Z', chatId: 'o', candidates: ['visit'], decision: 'none', why: '通讯录里没朋友,先在家歇着。', source: 'model', ...over,
})
const ms = (iso: string) => Date.parse(iso)

describe('dayKey', () => {
  it('按伙伴时区分桶:UTC 16:20 在上海是次日', () => {
    expect(dayKey(ms('2026-09-03T16:20:01.418Z'), TZ)).toBe('2026-09-04')
    expect(dayKey(ms('2026-09-03T15:59:59.000Z'), TZ)).toBe('2026-09-03')
    expect(dayKey(ms('2026-09-03T16:20:01.418Z'), 'UTC')).toBe('2026-09-03')
  })
})

describe('thoughtEvent', () => {
  it('model 的 why 是想法;title 随 decision', () => {
    expect(thoughtEvent(plan(), TZ)).toMatchObject({ id: 'thought:2026-09-06T03:03:55.347Z', kind: 'thought', title: '在家待着', note: '通讯录里没朋友,先在家歇着。', day: '2026-09-06' })
    expect(thoughtEvent(plan({ decision: 'hunt' }), TZ).title).toBe('出门打猎去了')
    expect(thoughtEvent(plan({ decision: 'visit' }), TZ).title).toBe('去串门了')
    expect(thoughtEvent(plan({ decision: 'gap' }), TZ).title).toBe('gap')
  })
  it('fallback / downgraded 不显示理由', () => {
    expect(thoughtEvent(plan({ decision: 'visit', why: 'fallback:timeout', source: 'fallback' }), TZ)).toMatchObject({ title: '去串门了', note: null })
    expect(thoughtEvent(plan({ source: 'downgraded' }), TZ).note).toBeNull()
  })
  it('(failed) / (skipped) → 想出门没走成,不给理由', () => {
    expect(thoughtEvent(plan({ decision: 'hunt', why: '(failed) 网断了' }), TZ)).toMatchObject({ title: '想出门,没走成', note: null })
    expect(thoughtEvent(plan({ decision: 'visit', why: '(skipped) 在忙' }), TZ)).toMatchObject({ title: '想出门,没走成', note: null })
  })
})

describe('chatDayEvents', () => {
  const t = (chatId: string, iso: string, outcome = 'completed'): TurnLite => ({ chatId, endedAt: ms(iso), outcome })
  it('一天一条,只算 completed,ts 取当天最后一回合', () => {
    const ev = chatDayEvents([
      t('o', '2026-09-05T01:00:00.000Z'), t('o', '2026-09-05T02:00:00.000Z'), t('o', '2026-09-05T03:00:00.000Z', 'error'),
    ], 'o', TZ)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ id: 'chat_day:2026-09-05', kind: 'chat_day', title: '和主人聊了 2 回', ts: '2026-09-05T02:00:00.000Z', day: '2026-09-05', note: null })
  })
  it('三种 title:只主人 / 主人+客人 / 只客人;主人未知时全算客人', () => {
    const turns = [t('o', '2026-09-05T01:00:00.000Z'), t('g1', '2026-09-05T01:10:00.000Z'), t('g2', '2026-09-05T01:20:00.000Z'), t('g2', '2026-09-05T01:30:00.000Z')]
    expect(chatDayEvents(turns, 'o', TZ)[0]!.title).toBe('和主人聊了 1 回,还和 2 位客人聊了 3 回')
    expect(chatDayEvents(turns.slice(1), 'o', TZ)[0]!.title).toBe('和 2 位客人聊了 3 回')
    expect(chatDayEvents(turns, null, TZ)[0]!.title).toBe('和 3 位客人聊了 4 回')
  })
  it('跨 UTC 日界按伙伴时区分开', () => {
    const ev = chatDayEvents([t('o', '2026-09-05T15:00:00.000Z'), t('o', '2026-09-05T17:00:00.000Z')], 'o', TZ)
    expect(ev.map(e => e.day).sort()).toEqual(['2026-09-05', '2026-09-06'])
  })
  it('没有 completed 的天不出条目', () => {
    expect(chatDayEvents([t('o', '2026-09-05T01:00:00.000Z', 'timeout')], 'o', TZ)).toEqual([])
  })
})

describe('cursor', () => {
  it('往返;坏串 → null', () => {
    const c = encodeCursor('2026-09-06T02:43:36.412Z', 'journal:j1')
    expect(decodeCursor(c)).toEqual({ ts: '2026-09-06T02:43:36.412Z', id: 'journal:j1' })
    expect(decodeCursor('not-base64!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull()
  })
})

describe('buildFeed', () => {
  const src = () => ({
    journal: [row(), row({ id: 'j2', ts: '2026-09-03T16:20:01.418Z', kind: 'visit', title: '去了小飞家', note: '见闻一段', url: null, image_svg: '<svg/>' })],
    thoughts: [plan(), plan({ at: '2026-09-06T02:43:36.412Z', decision: 'hunt', why: '去转转' })],
    turns: [{ chatId: 'o', endedAt: ms('2026-09-05T01:00:00.000Z'), outcome: 'completed' }],
  })
  it('三源合并、ts 降序、同 ts 按 id 升序;journal 带 ref', () => {
    const r = buildFeed(src(), { ownerChatId: 'o', timezone: TZ })
    expect(r.events.map(e => e.id)).toEqual([
      'thought:2026-09-06T03:03:55.347Z', 'journal:j1', 'thought:2026-09-06T02:43:36.412Z', 'chat_day:2026-09-05', 'journal:j2',
    ])
    expect(r.events[1]).toMatchObject({ kind: 'hunt', ref: { url: 'https://x', image_svg: null, status: 'new' }, day: '2026-09-06' })
    expect(r.events[4]!.ref).toEqual({ url: null, image_svg: '<svg/>', status: 'new' })
    expect(r.sources_degraded).toEqual([])
    expect(r.next_cursor).toBeNull()
  })
  it('分页:limit 切、next_cursor 接得上、同 ts 不丢不重', () => {
    const s = { journal: [row({ id: 'a', ts: '2026-09-06T02:43:36.412Z' }), row({ id: 'b', ts: '2026-09-06T02:43:36.412Z' }), row({ id: 'c', ts: '2026-09-06T02:43:36.412Z' })], thoughts: [], turns: [] }
    const p1 = buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 2 })
    expect(p1.events.map(e => e.id)).toEqual(['journal:a', 'journal:b'])
    expect(p1.next_cursor).not.toBeNull()
    const p2 = buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 2, cursor: p1.next_cursor })
    expect(p2.events.map(e => e.id)).toEqual(['journal:c'])
    expect(p2.next_cursor).toBeNull()
  })
  it('limit 夹到 [1, FEED_MAX_LIMIT]', () => {
    const s = { journal: Array.from({ length: 120 }, (_, i) => row({ id: `r${String(i).padStart(3, '0')}` })), thoughts: [], turns: [] }
    expect(buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 999 }).events).toHaveLength(FEED_MAX_LIMIT)
    expect(buildFeed(s, { ownerChatId: 'o', timezone: TZ, limit: 0 }).events).toHaveLength(1)
  })
  it('unread 三源都算,按整个窗口而不是当前页', () => {
    const r = buildFeed(src(), { ownerChatId: 'o', timezone: TZ, limit: 1, seenUntil: '2026-09-05T12:00:00.000Z' })
    expect(r.unread).toBe(3)
    expect(buildFeed(src(), { ownerChatId: 'o', timezone: TZ, seenUntil: null }).unread).toBe(5)
  })
  it('某源为 null → 记 degraded,其余照给', () => {
    const r = buildFeed({ ...src(), thoughts: null }, { ownerChatId: 'o', timezone: TZ })
    expect(r.sources_degraded).toEqual(['thought'])
    expect(r.events.some(e => e.kind === 'thought')).toBe(false)
    expect(r.events).toHaveLength(3)
    const all = buildFeed({ journal: null, thoughts: null, turns: null }, { ownerChatId: 'o', timezone: TZ })
    expect(all.sources_degraded).toEqual(['journal', 'thought', 'chat_day'])
    expect(all.events).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/mobile-feed.test.ts`
Expected: FAIL —— 找不到 `./mobile-feed`

- [ ] **Step 3: 实现**

`src/daemon/mobile-feed.ts`:

```ts
/**
 * mobile-feed.ts — 随身 CC 首屏「伙伴的一天」(spec 2026-09-06-mobile-home-feed §3)。
 *
 * 三个已有来源读时合并成一条事件流:journal(背包)、plan-log(伙伴自己的
 * 决定 = 想法)、turn_records(聊天日摘要)。**纯函数,无 IO**:读盘/读库在
 * settings-panel 的 deps 注入里。不把想法/聊天写进 journal —— journal 是
 * 背包,条目有 tried/using/dropped 语义,硬塞会污染那套状态。
 *
 * 分页范围是「合并后的有界窗口」(journal 200 条 + plan-log 14 天 + 聊天 14
 * 天),不是无限历史;v1 在内存里合并排序,不做 SQL 级多源游标。
 */
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'

export type FeedKind = 'hunt' | 'visit' | 'postcard' | 'thought' | 'chat_day'
export type FeedSource = 'journal' | 'thought' | 'chat_day'

export interface FeedEvent {
  id: string
  ts: string
  kind: FeedKind
  title: string
  note: string | null
  /** 伙伴时区下的 YYYY-MM-DD,页面按它分组(不让页面自己算时区)。 */
  day: string
  ref?: { url: string | null; image_svg: string | null; status: string }
}

export interface TurnLite { chatId: string; endedAt: number; outcome: string }

export interface FeedSources {
  journal: readonly CatchRow[] | null
  thoughts: readonly PlanLogEntry[] | null
  turns: readonly TurnLite[] | null
}

export interface FeedOpts {
  ownerChatId: string | null
  timezone: string
  cursor?: string | null
  limit?: number
  seenUntil?: string | null
}

export interface FeedResult {
  events: FeedEvent[]
  next_cursor: string | null
  unread: number
  sources_degraded: FeedSource[]
}

export const FEED_DEFAULT_LIMIT = 30
export const FEED_MAX_LIMIT = 100

const dayFmtCache = new Map<string, Intl.DateTimeFormat>()
function dayFmt(timezone: string): Intl.DateTimeFormat {
  let f = dayFmtCache.get(timezone)
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
    catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }) }
    dayFmtCache.set(timezone, f)
  }
  return f
}

/** en-CA 的 short date 恰好是 YYYY-MM-DD。 */
export function dayKey(ms: number, timezone: string): string {
  return dayFmt(timezone).format(new Date(ms))
}

const THOUGHT_TITLE: Record<string, string> = { hunt: '出门打猎去了', visit: '去串门了', none: '在家待着' }

export function thoughtEvent(e: PlanLogEntry, timezone: string): FeedEvent {
  const aborted = e.why.startsWith('(failed) ') || e.why.startsWith('(skipped) ')
  return {
    id: `thought:${e.at}`,
    ts: e.at,
    kind: 'thought',
    title: aborted ? '想出门,没走成' : (THOUGHT_TITLE[e.decision] ?? e.decision),
    // 只有模型自己说的话才是想法;fallback 的 why 是机器原因,downgraded 的
    // why 说的是另一件事(想做的没在候选里)。都不给它编理由。
    note: !aborted && e.source === 'model' ? e.why : null,
    day: dayKey(Date.parse(e.at), timezone),
  }
}

export function chatDayEvents(turns: readonly TurnLite[], ownerChatId: string | null, timezone: string): FeedEvent[] {
  const byDay = new Map<string, { owner: number; guestTurns: number; guests: Set<string>; lastMs: number }>()
  for (const t of turns) {
    if (t.outcome !== 'completed') continue
    const day = dayKey(t.endedAt, timezone)
    let b = byDay.get(day)
    if (!b) { b = { owner: 0, guestTurns: 0, guests: new Set(), lastMs: 0 }; byDay.set(day, b) }
    if (ownerChatId !== null && t.chatId === ownerChatId) b.owner++
    else { b.guestTurns++; b.guests.add(t.chatId) }
    if (t.endedAt > b.lastMs) b.lastMs = t.endedAt
  }
  const out: FeedEvent[] = []
  for (const [day, b] of byDay) {
    const guest = b.guestTurns > 0 ? `和 ${b.guests.size} 位客人聊了 ${b.guestTurns} 回` : ''
    const title = b.owner > 0
      ? (guest ? `和主人聊了 ${b.owner} 回,还${guest}` : `和主人聊了 ${b.owner} 回`)
      : guest
    out.push({ id: `chat_day:${day}`, ts: new Date(b.lastMs).toISOString(), kind: 'chat_day', title, note: null, day })
  }
  return out
}

function journalEvent(r: CatchRow, timezone: string): FeedEvent {
  return {
    id: `journal:${r.id}`, ts: r.ts, kind: r.kind, title: r.title, note: r.note || null,
    day: dayKey(Date.parse(r.ts), timezone),
    ref: { url: r.url, image_svg: r.image_svg, status: r.status },
  }
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(s: string): { ts: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const raw = Buffer.from(s, 'base64url').toString('utf8')
  const i = raw.indexOf('|')
  if (i <= 0 || i === raw.length - 1) return null
  const ts = raw.slice(0, i)
  if (Number.isNaN(Date.parse(ts))) return null
  return { ts, id: raw.slice(i + 1) }
}

/** ts 降序;同 ts 按 id 升序(稳定,游标才接得上)。 */
function cmp(a: FeedEvent, b: FeedEvent): number {
  return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function buildFeed(src: FeedSources, opts: FeedOpts): FeedResult {
  const degraded: FeedSource[] = []
  const all: FeedEvent[] = []
  if (src.journal) for (const r of src.journal) all.push(journalEvent(r, opts.timezone)); else degraded.push('journal')
  if (src.thoughts) for (const e of src.thoughts) all.push(thoughtEvent(e, opts.timezone)); else degraded.push('thought')
  if (src.turns) all.push(...chatDayEvents(src.turns, opts.ownerChatId, opts.timezone)); else degraded.push('chat_day')
  all.sort(cmp)

  const seen = opts.seenUntil ?? null
  const unread = seen === null ? all.length : all.filter(e => e.ts > seen).length

  const limit = Math.min(FEED_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? FEED_DEFAULT_LIMIT)))
  const c = opts.cursor ? decodeCursor(opts.cursor) : null
  const after = c ? all.filter(e => e.ts < c.ts || (e.ts === c.ts && e.id > c.id)) : all
  const page = after.slice(0, limit)
  const last = page.at(-1)
  const next_cursor = after.length > limit && last ? encodeCursor(last.ts, last.id) : null
  return { events: page, next_cursor, unread, sources_degraded: degraded }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/mobile-feed.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mobile-feed.ts src/daemon/mobile-feed.test.ts
git commit -m "mobile-feed:三源读时合并成伙伴的一天(想法/背包/聊天日摘要),纯函数带游标与未读"
```

---

### Task 4: settings-panel 三个路由 + deps

**Files:**
- Modify: `src/daemon/settings-panel.ts:43-76`(`SettingsPanelDeps`)、`:378-380`(`/m/api/state` 旁)
- Test: `src/daemon/settings-panel.test.ts`

**Interfaces:**
- Consumes: `buildFeed`、`FeedSources`、`TurnLite`、`decodeCursor`、`FEED_DEFAULT_LIMIT`(Task 3);`Presence`;`CatchRow`;`PlanLogEntry`
- Produces:`SettingsPanelDeps` 新字段

```ts
feed?: {
  journal: { list(limit?: number): readonly CatchRow[] }
  planLogDays: (days: number) => readonly PlanLogEntry[]
  turnsRecent: (limit: number) => readonly TurnLite[]
  timezone: () => string
}
presence?: () => Promise<Presence | null>
seen?: { read: () => string | null; write: (iso: string) => void }
```

及路由 `GET /m/api/home`、`GET /m/api/feed`、`POST /m/api/seen`(响应形状见 spec §4)

- [ ] **Step 1: 写测试**

在 `src/daemon/settings-panel.test.ts` 文件末尾追加一个独立 describe(自己造 panel,不动上面的 `beforeEach`):

```ts
describe('随身 CC 首屏:伙伴的一天', () => {
  const OWNER2 = 'owner2@im.wechat'
  const NOW = Date.parse('2026-09-06T08:00:00.000Z')
  let dir: string
  let seenUntil: string | null
  let presenceImpl: () => Promise<import('../core/companion-presence').Presence | null>
  let planThrows: boolean
  const rows = () => [
    { id: 'j1', ts: '2026-09-06T02:43:36.412Z', chat_id: OWNER2, title: '好玩的东西', url: 'https://x', note: '', status: 'new', kind: 'hunt', image_svg: null },
  ] as import('../core/journal-store').CatchRow[]
  const plans = () => [
    { at: '2026-09-06T03:03:55.347Z', chatId: OWNER2, candidates: ['visit'], decision: 'none', why: '没朋友,在家歇着。', source: 'model' },
  ] as import('../core/companion-plan').PlanLogEntry[]
  const mk = (over: Partial<Parameters<typeof makeSettingsPanel>[0]> = {}) => makeSettingsPanel({
    stateDir: dir,
    ownerChatId: () => OWNER2,
    chatPrefs: { get: () => ({}), set: () => ({}) },
    getUserName: () => '大人',
    setUserName: async () => {},
    feed: {
      journal: { list: () => rows() },
      planLogDays: () => { if (planThrows) throw new Error('boom'); return plans() },
      turnsRecent: () => [{ chatId: OWNER2, endedAt: Date.parse('2026-09-05T01:00:00.000Z'), outcome: 'completed' }],
      timezone: () => 'Asia/Shanghai',
    },
    presence: () => presenceImpl(),
    seen: { read: () => seenUntil, write: (iso) => { seenUntil = iso } },
    log: () => {},
    now: () => NOW,
    ...over,
  })
  const okPresence = async () => ({ presence: 'ok' as const, activity: { kind: 'idle' as const, label: '在家', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-feed-'))
    seenUntil = null
    presenceImpl = okPresence
    planThrows = false
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function withPanel(p: ReturnType<typeof makeSettingsPanel>, fn: (base: string, t: string) => Promise<void>) {
    const { port } = await p.start(0)
    try { await fn(`http://127.0.0.1:${port}`, p.issueToken()) } finally { await p.stop() }
  }

  it('home:三源合并、presence、unread、synced_at、today', async () => {
    await withPanel(mk(), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as Record<string, unknown>
      expect(r.ok).toBe(true)
      expect(r.synced_at).toBe('2026-09-06T08:00:00.000Z')
      expect(r.today).toBe('2026-09-06')
      expect(r.presence).toMatchObject({ presence: 'ok' })
      expect(r.unread).toBe(3)
      expect(r.seen_until).toBeNull()
      expect((r.events as Array<{ id: string }>).map(e => e.id)).toEqual(['thought:2026-09-06T03:03:55.347Z', 'journal:j1', 'chat_day:2026-09-05'])
      expect(r.sources_degraded).toEqual([])
      expect(r.next_cursor).toBeNull()
    })
  })
  it('home:presence 抛 → null + presence_error;单源抛 → degraded 仍 200', async () => {
    presenceImpl = async () => { throw new Error('nope') }
    planThrows = true
    await withPanel(mk(), async (base, t) => {
      const res = await fetch(`${base}/m/api/home?t=${t}`)
      expect(res.status).toBe(200)
      const r = await res.json() as Record<string, unknown>
      expect(r.presence).toBeNull()
      expect(r.presence_error).toBe('unavailable')
      expect(r.sources_degraded).toEqual(['thought'])
      expect((r.events as unknown[]).length).toBe(2)
    })
  })
  it('home:feed dep 缺 → 三项 degraded、空 events,仍 200', async () => {
    await withPanel(mk({ feed: undefined }), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as Record<string, unknown>
      expect(r.ok).toBe(true)
      expect(r.sources_degraded).toEqual(['journal', 'thought', 'chat_day'])
      expect(r.events).toEqual([])
    })
  })
  it('feed:分页接得上;坏游标 400', async () => {
    await withPanel(mk(), async (base, t) => {
      const p1 = await (await fetch(`${base}/m/api/feed?limit=2&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null }
      expect(p1.events).toHaveLength(2)
      expect(p1.next_cursor).not.toBeNull()
      const p2 = await (await fetch(`${base}/m/api/feed?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null }
      expect(p2.events.map(e => e.id)).toEqual(['chat_day:2026-09-05'])
      expect(p2.next_cursor).toBeNull()
      const bad = await fetch(`${base}/m/api/feed?cursor=%25%25&t=${t}`)
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_cursor' })
    })
  })
  it('seen:写入、夹到 now、单调不后退、非法 400、没接 503', async () => {
    await withPanel(mk(), async (base, t) => {
      const post = (until: unknown) => fetch(`${base}/m/api/seen?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }) })
      expect(await (await post('2026-09-06T07:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T07:00:00.000Z' })
      expect(await (await post('2099-01-01T00:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T08:00:00.000Z' })
      expect(await (await post('2026-09-06T06:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T08:00:00.000Z' })
      const bad = await post('yesterday')
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_until' })
      const home = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as { unread: number; seen_until: string }
      expect(home.unread).toBe(0)
      expect(home.seen_until).toBe('2026-09-06T08:00:00.000Z')
    })
    await withPanel(mk({ seen: undefined }), async (base, t) => {
      const r = await fetch(`${base}/m/api/seen?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until: '2026-09-06T07:00:00.000Z' }) })
      expect(r.status).toBe(503)
    })
  })
  it('三个路由都要令牌', async () => {
    await withPanel(mk(), async (base) => {
      expect((await fetch(`${base}/m/api/home`)).status).toBe(401)
      expect((await fetch(`${base}/m/api/feed`)).status).toBe(401)
      expect((await fetch(`${base}/m/api/seen`, { method: 'POST' })).status).toBe(401)
    })
  })
})
```

(测试文件顶部若尚未 import `mkdtempSync`/`rmSync`/`tmpdir`/`join`,补上;`makeSettingsPanel` 已在文件里 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts -t "伙伴的一天"`
Expected: FAIL —— 类型错误(`feed` 不在 deps 上)或 404

- [ ] **Step 3: deps 与 import**

`src/daemon/settings-panel.ts` import 区加:

```ts
import { buildFeed, decodeCursor, FEED_DEFAULT_LIMIT, dayKey, type FeedSources, type TurnLite } from './mobile-feed'
import type { Presence } from '../core/companion-presence'
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'
```

`SettingsPanelDeps` 里 `stickers?:` 之后加:

```ts
  /**
   * 随身 CC 首屏「伙伴的一天」的三个来源(spec 2026-09-06-mobile-home-feed §5.4)。
   * 缺省 ⇒ /m/api/home 三项 sources_degraded。IO 全在这里,mobile-feed.ts 是纯函数。
   */
  feed?: {
    journal: { list(limit?: number): readonly CatchRow[] }
    planLogDays: (days: number) => readonly PlanLogEntry[]
    turnsRecent: (limit: number) => readonly TurnLite[]
    timezone: () => string
  }
  /** 三轴 presence,经 internal-api lifecycle.getPresence 共用。缺省/抛 ⇒ 手机页显示「不知道」。 */
  presence?: () => Promise<Presence | null>
  /** 主人「看到哪了」的水位,与桌面觅食台同一个文件(一个主人一个水位)。缺省 ⇒ POST /m/api/seen 503。 */
  seen?: { read: () => string | null; write: (iso: string) => void }
```

- [ ] **Step 4: 路由**

在 `makeSettingsPanel` 内、`const phoneState = ...` 定义之前加:

```ts
  const FEED_WINDOW_DAYS = 14
  const FEED_JOURNAL_LIMIT = 200
  const FEED_TURNS_LIMIT = 2000

  /** 三源各自 try;哪个抛就记 null(buildFeed 会翻译成 sources_degraded)。 */
  const collectSources = (): FeedSources => {
    const f = deps.feed
    if (!f) return { journal: null, thoughts: null, turns: null }
    const since = now() - FEED_WINDOW_DAYS * 86_400_000
    let journal: FeedSources['journal'] = null
    let thoughts: FeedSources['thoughts'] = null
    let turns: FeedSources['turns'] = null
    try { journal = f.journal.list(FEED_JOURNAL_LIMIT) } catch (e) { deps.log('SETTINGS', `feed journal 读不到: ${e instanceof Error ? e.message : e}`) }
    try { thoughts = f.planLogDays(FEED_WINDOW_DAYS) } catch (e) { deps.log('SETTINGS', `feed plan-log 读不到: ${e instanceof Error ? e.message : e}`) }
    try { turns = f.turnsRecent(FEED_TURNS_LIMIT).filter(t => t.endedAt >= since) } catch (e) { deps.log('SETTINGS', `feed turns 读不到: ${e instanceof Error ? e.message : e}`) }
    return { journal, thoughts, turns }
  }
  const feedTimezone = (): string => { try { return deps.feed?.timezone() || 'UTC' } catch { return 'UTC' } }
  const readSeen = (): string | null => { try { return deps.seen?.read() ?? null } catch { return null } }
  const parseLimit = (url: URL): number => {
    const n = Number(url.searchParams.get('limit'))
    return Number.isFinite(n) && n > 0 ? n : FEED_DEFAULT_LIMIT
  }
```

在 `routeRequest` 里 `/m/api/state` 那个 `if` 之后加三个路由:

```ts
          if (url.pathname === '/m/api/home' && req.method === 'GET') {
            let presence: Presence | null = null
            let presenceFailed = false
            try { presence = (await deps.presence?.()) ?? null } catch { presenceFailed = true }
            const tz = feedTimezone()
            const seenUntil = readSeen()
            const r = buildFeed(collectSources(), { ownerChatId: deps.ownerChatId(), timezone: tz, limit: parseLimit(url), seenUntil })
            return json({
              ok: true,
              synced_at: new Date(now()).toISOString(),
              today: dayKey(now(), tz),
              presence,
              ...(presenceFailed ? { presence_error: 'unavailable' } : {}),
              unread: r.unread,
              seen_until: seenUntil,
              events: r.events,
              next_cursor: r.next_cursor,
              sources_degraded: r.sources_degraded,
            })
          }
          if (url.pathname === '/m/api/feed' && req.method === 'GET') {
            const cursor = url.searchParams.get('cursor')
            if (cursor !== null && !decodeCursor(cursor)) return json({ ok: false, error: 'invalid_cursor' }, 400)
            const r = buildFeed(collectSources(), { ownerChatId: deps.ownerChatId(), timezone: feedTimezone(), limit: parseLimit(url), cursor, seenUntil: readSeen() })
            return json({ ok: true, events: r.events, next_cursor: r.next_cursor })
          }
          if (url.pathname === '/m/api/seen' && req.method === 'POST') {
            if (!deps.seen) return json({ ok: false, error: 'seen_not_wired' }, 503)
            let body: unknown
            try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
            const until = (body as { until?: unknown } | null)?.until
            const ms = typeof until === 'string' ? Date.parse(until) : NaN
            if (!Number.isFinite(ms)) return json({ ok: false, error: 'invalid_until' }, 400)
            // 夹到 now(不许推到未来);单调(桌面与手机两边推,谁靠后算谁)。
            const clamped = new Date(Math.min(ms, now())).toISOString()
            const cur = readSeen()
            if (cur !== null && clamped <= cur) return json({ ok: true, seen_until: cur })
            deps.seen.write(clamped)
            return json({ ok: true, seen_until: clamped })
          }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts && bun run typecheck`
Expected: PASS(含旧用例);typecheck 无错

- [ ] **Step 6: Commit**

```bash
git add src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts
git commit -m "/m/api/home|feed|seen:手机首屏一次拿全、翻页、推水位;单源失败不 500,presence 拿不到就说不知道"
```

---

### Task 5: 注入(pipeline-deps / wiring / main.ts)

**Files:**
- Modify: `src/daemon/wiring/pipeline-deps.ts:115-160`(`PipelineDepsOpts`)、`:447-490`(`makeSettingsPanel({...})`)
- Modify: `src/daemon/wiring/index.ts:36-100`(`WireMainOpts`)
- Modify: `src/daemon/main.ts:518-530`(`wireMain({...})`)

**Interfaces:**
- Consumes: `readPlanLogDays`(Task 1)、`internalApi.getPresence`(Task 2)、`TurnLite`(Task 3)、`readJournalSeen`/`writeJournalSeen`(`src/core/journal-seen.ts`)、`TurnRecordStore.recent(limit)`(`src/core/turn-record-store.ts:40`,返回 `StoredTurnRecord[]`,字段 `chatId`/`endedAt`/`outcome`)
- Produces: `PipelineDepsOpts.turns?`、`PipelineDepsOpts.presence?`;`WireMainOpts` 同名两字段;`huntStore.list` 的返回类型放宽为 `readonly CatchRow[]`

- [ ] **Step 1: 放宽 huntStore 类型、加两个 opts 字段**

`src/daemon/wiring/pipeline-deps.ts` `PipelineDepsOpts`:

- `huntStore?: { list(limit?: number): readonly { title: string; url: string | null; ts: string; status: string }[] }` 改为
  `huntStore?: { list(limit?: number): readonly import('../../core/journal-store').CatchRow[] }`
- `requestRestart?:` 之后加:

```ts
  /** 对话回合(turn_records)—— 随身 CC 首屏的「聊天日摘要」来源。main.ts 传 turnRecordStore。 */
  turns?: { recent(limit: number): readonly { chatId: string; endedAt: number; outcome: string }[] }
  /** 三轴 presence 共用入口(internal-api lifecycle.getPresence)。main.ts 传入。 */
  presence?: () => Promise<import('../../core/companion-presence').Presence | null>
```

`src/daemon/wiring/index.ts` `WireMainOpts`:

- `huntStore?.list` 的返回类型同样改为 `readonly import('../../core/journal-store').CatchRow[]`(`recordHunt`/`summary` 不动)
- 加同样的 `turns?` 与 `presence?` 两字段(注释照抄)

- [ ] **Step 2: 注入 settings panel**

`src/daemon/wiring/pipeline-deps.ts` import 区加:

```ts
import { readPlanLogDays } from '../companion/plan-memory'
import { readJournalSeen, writeJournalSeen } from '../../core/journal-seen'
```

`makeSettingsPanel({ ... })` 调用里,`...(opts.stickers ? {...} : {}),` 之后加:

```ts
    // 随身 CC 首屏「伙伴的一天」三源(spec 2026-09-06-mobile-home-feed §5.4)。
    // journal 缺 ⇒ 整个 feed 不接(三项 degraded),不半接。
    ...(opts.huntStore ? {
      feed: {
        journal: { list: (n?: number) => opts.huntStore!.list(n) },
        planLogDays: (d: number) => readPlanLogDays(stateDir, d),
        turnsRecent: (n: number) => opts.turns?.recent(n) ?? [],
        timezone: () => loadCompanionConfig(stateDir).timezone,
      },
    } : {}),
    ...(opts.presence ? { presence: opts.presence } : {}),
    seen: { read: () => readJournalSeen(stateDir), write: (iso: string) => writeJournalSeen(stateDir, iso) },
```

- [ ] **Step 3: main.ts 传入**

`src/daemon/main.ts` 的 `wireMain({ ... })` 调用里,`outboundTaps, huntStore, petSignals,` 那行改为:

```ts
      outboundTaps, huntStore, petSignals,
      // 随身 CC 首屏:聊天日摘要读 turn_records;presence 走 internal-api 的共用入口。
      turns: turnRecordStore,
      presence: () => internalApi.getPresence(),
```

- [ ] **Step 4: 类型 + 相关测试**

Run: `bun run typecheck && bun --bun vitest run src/daemon/wiring src/daemon/settings-panel.test.ts`
Expected: 无类型错;PASS。若 `wiring` 下有测试用 `as unknown as WireMainOpts` 造假 opts,不需要改(两字段可选)。

- [ ] **Step 5: 本机冒烟**

Run(daemon 正在跑的前提下;若没跑先 `bun run src/cli/index.ts daemon restart` 或按仓库 README 起 daemon):

```bash
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.claude/channels/wechat/internal-api-info.json'))['baseUrl'])")
# 拿手机页链接(含短令牌),再打 /m/api/home
LINK=$(bun run src/cli/index.ts settings link 2>/dev/null | grep -o 'http[^ ]*' | head -1); echo "$LINK"
```

如果 `settings link` 不是现有子命令,改用:daemon 日志里找 `SETTINGS` 打印的链接,或在微信里对 CC 说「设置」拿链接。然后:

```bash
curl -s "$(echo "$LINK" | sed 's#/set?t=#/m/api/home?t=#')" | python3 -m json.tool | head -40
```

Expected: `ok: true`,`events` 里能看到真机的 1 条 hunt、2 条 visit、今天的 4 条 thought(其中 fallback 那条 `note: null`)、几条 `chat_day`;`presence` 非 null。

- [ ] **Step 6: Commit**

```bash
git add src/daemon/wiring/pipeline-deps.ts src/daemon/wiring/index.ts src/daemon/main.ts
git commit -m "把 journal / plan-log / turn_records / presence / 水位注进手机页——feed 三源齐了"
```

---

### Task 6: 手机页「今天」tab

**Files:**
- Modify: `src/daemon/settings-panel-html.ts:355-496`(`phoneHtml`)
- Test: `src/daemon/settings-panel.test.ts`

**Interfaces:**
- Consumes: `/m/api/home`、`/m/api/feed`、`/m/api/seen`(Task 4);页面内已有 `api(path, opts)`(隧道感知 fetch,返回 `Response`)、`q(path)`、`esc(s)`、`toast(m)`、`ccNav(path)`
- Produces: 无(页面)

- [ ] **Step 1: 加页面结构测试**

在 `src/daemon/settings-panel.test.ts` 顶层(现有 `describe` 里已有 `/m` 相关用例的那个 describe)追加:

```ts
  it('/m 首屏是「今天」,口袋里还有原来三块', async () => {
    const { port } = await panel.start(0)
    const t = panel.issueToken()
    const html = await (await fetch(`http://127.0.0.1:${port}/m?t=${t}`)).text()
    expect(html).toContain('id="p-today"')
    expect(html).toContain('id="p-pocket"')
    expect(html).toContain('/m/api/home')
    expect(html).toContain('cc.home.v1')
    for (const id of ['id="todos"', 'id="portrait"', 'id="stickers"']) expect(html).toContain(id)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts -t "首屏是"`
Expected: FAIL —— 没有 `p-today`

- [ ] **Step 3: 改 phoneHtml**

在 `src/daemon/settings-panel-html.ts` 的 `phoneHtml` 里做以下替换(其余原样):

(a) `<style>` 里 `#toast.show { opacity:1 }` 之后追加:

```css
  .pres { display:flex; align-items:center; gap:8px; padding:0 16px 6px; color:var(--soft); font-size:13px }
  .pres b { color:var(--ink); font-weight:600 }
  .pres button { margin-left:auto; font:inherit; font-size:12px; padding:3px 10px; border:1.5px solid var(--line); border-radius:999px; background:var(--card); color:var(--soft) }
  #banner { margin:6px 14px; padding:8px 12px; background:rgba(176,86,58,.10); border-radius:10px; font-size:12.5px; color:var(--accent) }
  .ev { display:flex; gap:10px } .ev .k { font-size:18px; width:26px; text-align:center; flex:none }
  .ev .tx { flex:1; min-width:0 } .ev .tx b { display:block; font-size:14px; font-weight:600 }
  .ev .tx p { margin:3px 0 0; font-size:13px; color:var(--soft); white-space:pre-wrap; word-break:break-word }
  .ev .tx small { color:var(--soft); font-size:11.5px }
  .ev .tx a { color:var(--accent) }
  .ev .pc { margin-top:6px } .ev .pc svg { width:100%; height:auto; border:1.5px solid var(--line); border-radius:10px }
  .more { display:block; margin:6px auto 0; font:inherit; font-size:13px; padding:7px 18px; border:1.5px solid var(--line); border-radius:999px; background:var(--card); color:var(--soft) }
  .sec { margin-top:18px }
```

(b) 把

```html
<div class="pane on" id="p-todos"><div id="todos"></div></div>
<div class="pane" id="p-portrait"><div class="portrait" id="portrait"></div></div>
<div class="pane" id="p-stickers"><div class="stgrid" id="stickers"></div></div>
<nav>
  <button data-p="todos" class="on"><span class="i">📋</span>待办</button>
  <button data-p="portrait"><span class="i">🖼</span>CC画的你</button>
  <button data-p="stickers"><span class="i">🐻</span>表情</button>
  <button id="nav-set"><span class="i">⚙️</span>设置</button>
</nav>
```

替换为

```html
<div class="pane on" id="p-today">
  <div class="pres" id="pres"><span>现在:</span><b id="pres-txt">不知道</b><button id="refresh">刷新</button></div>
  <div id="banner" hidden></div>
  <div id="feed"></div>
</div>
<div class="pane" id="p-pocket">
  <div class="grp">待办</div><div id="todos"></div>
  <div class="sec"><div class="grp">CC 画的你</div><div class="portrait" id="portrait"></div></div>
  <div class="sec"><div class="grp">表情</div><div class="stgrid" id="stickers"></div></div>
</div>
<nav>
  <button data-p="today" class="on"><span class="i">🌤</span>今天</button>
  <button data-p="pocket"><span class="i">🎒</span>口袋</button>
  <button id="nav-set"><span class="i">⚙️</span>设置</button>
</nav>
```

(c) 在 `load()` 定义之前加首屏逻辑:

```js
var HOME_KEY = "cc.home.v1"
var KIND_ICON = { hunt: "🎯", visit: "🏡", postcard: "💌", thought: "💭", chat_day: "💬" }
var homeState = null
function ago(iso) {
  var d = Math.max(0, Date.now() - Date.parse(iso)) / 1000
  if (d < 60) return "刚刚"
  if (d < 3600) return Math.floor(d / 60) + " 分钟前"
  if (d < 86400) return Math.floor(d / 3600) + " 小时前"
  return Math.floor(d / 86400) + " 天前"
}
function hm(iso) { var t = new Date(iso); return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") }
function readCache() { try { var s = localStorage.getItem(HOME_KEY); return s ? JSON.parse(s) : null } catch (e) { return null } }
function writeCache(s) { try { localStorage.setItem(HOME_KEY, JSON.stringify(s)) } catch (e) {} }
function evHtml(e) {
  var h = '<div class="card ev"><div class="k">' + (KIND_ICON[e.kind] || "•") + '</div><div class="tx"><b>' + esc(e.title) + '</b>'
  if (e.note) h += '<p>' + esc(e.note) + '</p>'
  if (e.ref && e.ref.url) h += '<p><a href="' + esc(e.ref.url) + '" target="_blank" rel="noopener">打开链接</a></p>'
  if (e.ref && e.ref.image_svg) h += '<div class="pc">' + e.ref.image_svg + '</div>'
  h += '<small>' + hm(e.ts) + '</small></div></div>'
  return h
}
function renderFeed(s, stale) {
  var f = document.getElementById("feed")
  // presence:只有这次真拉到的才显示;缓存里的永远不渲染 —— 它说的是「现在」。
  var pt = document.getElementById("pres-txt")
  if (!stale && s.presence) pt.textContent = s.presence.activity.label + (s.presence.presence === "ok" ? "" : "(" + (s.presence.presence === "offline" ? "断线" : "有点不对劲") + ")")
  else pt.textContent = "不知道"
  var h = ""
  var evs = s.events || []
  var degradedAll = s.sources_degraded && s.sources_degraded.length === 3
  if (degradedAll) h = '<div class="empty">今天读不到它的日记</div>'
  else if (!evs.length) h = '<div class="empty">还什么都没发生——它刚醒</div>'
  else {
    var day = null
    if (s.today && evs[0].day !== s.today) { h += '<div class="grp">今天</div><div class="empty" style="padding:14px">它今天还没出门</div>' }
    evs.forEach(function(e) {
      if (e.day !== day) { day = e.day; h += '<div class="grp">' + (day === s.today ? "今天" : esc(day)) + '</div>' }
      h += evHtml(e)
    })
    if (s.next_cursor) h += '<button class="more" data-cursor="' + esc(s.next_cursor) + '">再往前</button>'
  }
  f.innerHTML = h
}
function showBanner(txt) { var b = document.getElementById("banner"); b.hidden = !txt; b.textContent = txt || "" }
function loadHome() {
  var cached = readCache()
  if (cached) { homeState = cached; renderFeed(cached, true); showBanner("上次同步 " + ago(cached.synced_at)) }
  api("/m/api/home").then(function(r) {
    if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }
    return r.json()
  }).then(function(s) {
    if (!s || !s.ok) return
    homeState = s; renderFeed(s, false); showBanner(""); writeCache(s)
    if (document.visibilityState === "visible") {
      api("/m/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ until: s.synced_at }) }).catch(function(){})
    }
  }).catch(function() {
    if (cached) showBanner("连不上家里的 CC · 显示的是 " + ago(cached.synced_at) + "的")
    else { document.getElementById("feed").innerHTML = '<div class="empty">连不上家里的 CC<br><small>看看电脑开着没</small></div>'; document.getElementById("pres-txt").textContent = "不知道" }
  })
}
document.getElementById("feed").addEventListener("click", function(ev) {
  var b = ev.target.closest("button.more")
  if (!b || !homeState) return
  b.disabled = true
  api("/m/api/feed?cursor=" + encodeURIComponent(b.dataset.cursor)).then(function(r){ return r.json() }).then(function(r) {
    if (!r || !r.ok) { b.disabled = false; return }
    homeState.events = homeState.events.concat(r.events); homeState.next_cursor = r.next_cursor
    renderFeed(homeState, !!document.getElementById("banner").textContent)
  }).catch(function(){ b.disabled = false; toast("网络不通") })
})
document.getElementById("refresh").addEventListener("click", loadHome)
document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") loadHome() })
```

(d) 文件末尾 `load()` 那一行改为:

```js
loadHome()
load()
```

注意:`render(s)` 里那三个 `getElementById("todos"/"portrait"/"stickers")` 不用动——容器 id 没变,只是搬进了口袋 pane。

- [ ] **Step 4: 跑测试**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts && bun run typecheck`
Expected: PASS(含「/m without token」「phone state」旧用例)

- [ ] **Step 5: 真机走查(spec §8)**

1. daemon 重启使新页生效;微信里对 CC 说「设置」拿链接,或用 Task 5 Step 5 的方式取得 `/m?t=…`
2. 手机浏览器打开 → 首屏是「今天」:presence 一行、按天分组的事件、thought 条目中 fallback 那条无 note
3. 点「口袋」→ 待办 / CC 画的你 / 表情 三块都在
4. Mac 合盖(或 `pkill -f 'wechat-cc daemon'` 停掉 daemon)→ 手机页刷新:横幅「连不上家里的 CC · 显示的是 N 分钟前的」,事件仍在,「现在:不知道」
5. 恢复 daemon → 刷新 → 横幅消失,presence 回来
6. 桌面觅食台打开一次 → 手机 `/m/api/home` 的 `seen_until` 跟着变(共用水位)

把 4、5 两步的截图或文字结果写进 commit message 正文。

- [ ] **Step 6: Commit**

```bash
git add src/daemon/settings-panel-html.ts src/daemon/settings-panel.test.ts
git commit -m "手机页首屏换成「今天」:伙伴的一天事件流 + 缓存带同步时间横幅;presence 永不缓存;原三块进口袋"
```

---

### Task 7: 隧道链路往返 + 文档

**Files:**
- Test: `src/daemon/tunnel-client.test.ts`
- Modify: `docs/architecture.md`(随身 CC 段落)

**Interfaces:**
- Consumes: `makeSettingsPanel`(Task 4 之后带 feed 路由)、`makeTunnelClient`、测试文件里已有的 `fakeSocket`/`DTOK`/`deriveSharedKey`/`importDaemonPub`/`sealFrame`/`openFrame`/`handshakePlaintext`

- [ ] **Step 1: 加隧道往返测试**

在 `src/daemon/tunnel-client.test.ts` 里、「decrypts a phone request…」那条测试之后追加(复用同一套握手步骤):

```ts
  it('/m/api/home 经隧道往返:真 settings-panel 处理,设备 token 生效', async () => {
    const { makeSettingsPanel } = await import('./settings-panel')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const stateDir = mkdtempSync(join(tmpdir(), 'tunnel-home-'))
    // 隧道用 knownDeviceTokens 认证流;panel 用 settings-devices.json 认 ?d= —— 两边写同一枚。
    writeFileSync(join(stateDir, 'settings-devices.json'), JSON.stringify({ [DTOK]: { created_at: '2026-09-06T00:00:00.000Z' } }))
    const panel = makeSettingsPanel({
      stateDir, ownerChatId: () => 'o', chatPrefs: { get: () => ({}), set: () => ({}) },
      getUserName: () => null, setUserName: async () => {},
      feed: { journal: { list: () => [] }, planLogDays: () => [], turnsRecent: () => [], timezone: () => 'UTC' },
      seen: { read: () => null, write: () => {} },
      log: () => {},
    })
    try {
      const phone = await generateTunnelKeypair()
      const sock = fakeSocket()
      const client = makeTunnelClient({
        daemonId: 'cc-1', knownDeviceTokens: () => [DTOK],
        handleRequest: (req) => panel.handleRequest(req),
        connect: () => sock.ws as never, log: () => {},
      })
      client.start()
      sock.emitMessage(JSON.stringify({ stream: 'sH', frame: { hs: await exportPublicKeyB64(phone.publicKey) } }))
      for (let i = 0; i < 20 && sock.sent.length < 1; i++) await new Promise(r => setTimeout(r, 5))
      const daemonPub = handshakePlaintext(JSON.parse(sock.sent.at(-1)!).frame)
      const key = await deriveSharedKey(phone.privateKey, await importDaemonPub(daemonPub!), new TextEncoder().encode(DTOK))
      const reqBytes = new TextEncoder().encode(JSON.stringify({ path: `/m/api/home?d=${DTOK}`, method: 'GET' }))
      sock.emitMessage(JSON.stringify({ stream: 'sH', frame: await sealFrame(key, reqBytes) }))
      for (let i = 0; i < 20 && sock.sent.length < 2; i++) await new Promise(r => setTimeout(r, 5))
      const opened = JSON.parse(new TextDecoder().decode(await openFrame(key, JSON.parse(sock.sent.at(-1)!).frame)))
      expect(opened.status).toBe(200)
      const body = JSON.parse(opened.body)
      expect(body.ok).toBe(true)
      expect(body.events).toEqual([])
      expect(body.sources_degraded).toEqual([])
      expect(body.presence).toBeNull()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
```

若该测试文件里请求帧的字段名/顺序与「decrypts a phone request」那条不同(例如带 `rid`),照那条已有测试的写法改这条,不改产品代码。

- [ ] **Step 2: 跑测试**

Run: `bun --bun vitest run src/daemon/tunnel-client.test.ts`
Expected: PASS

- [ ] **Step 3: 文档**

`docs/architecture.md` 里描述随身 CC / `/m` 手机页的段落(搜 `随身` 或 `/m/`)末尾加一句:

> 首屏「今天」是伙伴的一天:`GET /m/api/home` 把 journal(背包)、plan-log(想法)、turn_records(聊天日摘要)读时合并成一条事件流,外加 presence;`/m/api/feed` 翻页、`/m/api/seen` 推水位(与桌面觅食台共用 `companion/journal-seen.json`)。事件可在手机缓存并标注同步时间,presence 永不缓存。见 `docs/superpowers/specs/2026-09-06-mobile-home-feed-design.md`。

- [ ] **Step 4: 全量测试**

Run: `bun --bun vitest run && bun run typecheck`
Expected: 全绿;typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add src/daemon/tunnel-client.test.ts docs/architecture.md
git commit -m "隧道往返测 /m/api/home;architecture 补随身 CC 首屏一句"
```

---

## 自查记录(写完计划后对照 spec)

- §3.1 信封 → Task 3(多了 `day`,spec §6 分组需要;页面不自算时区)
- §3.2 三源映射(含 fallback/failed/skipped、客人不列名、只算 completed)→ Task 3 测试逐条覆盖
- §3.3 合并/游标/有界窗口 → Task 3 + Task 4 的 `collectSources`(200 / 14 天 / 14 天)
- §3.4 未读三源都算、与 `presence.news.unread` 分开、共用水位 → Task 3(unread)+ Task 5(`seen` 用 journal-seen)
- §4 三个接口、单源不 500、`invalid_cursor`、seen 夹取/单调/503 → Task 4
- §5.1 plan-log 留 14 天、旧形状兼容 → Task 1
- §5.2 `computePresence` + `getPresence` → Task 2
- §5.3 `mobile-feed.ts` 无 IO → Task 3
- §5.4 deps 与注入 → Task 4 + Task 5
- §6 两 tab、presence 行、分组、再往前、刷新、visibilitychange、缓存/横幅/三种空态、推水位用 `synced_at` → Task 6
- §7 诚实规则 → Task 3(note 规则)、Task 4(presence null / degraded)、Task 6(缓存 presence 不渲染)
- §8 测试清单 → Task 1–4、6、7;真机走查 → Task 6 Step 5
- §9 文件清单 → 与 File Structure 一致;`docs/architecture.md` → Task 7
