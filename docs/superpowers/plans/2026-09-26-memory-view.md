# 「CC 眼中的你」记忆界面改版 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记忆内容「一条一件事」;手机上点「此刻」的 CC 进入会呼吸眨眼的「CC 眼中的你」页(一封信的样子);微信「查看记忆」排成分段的信。

**Architecture:** 显示用的派生信息(期限标签、身边的人拆两列、口语时间、昨晚变化排序与标签、页面情绪)全部在 daemon 侧一个纯模块 `memory-text.ts` 算好、测好;`curatedView()` 与微信文案都用它;手机经典脚本只负责渲染。眨眼帧以 256px 全彩 PNG 提交在 `apps/mobile/art/`,构建成 daemon 侧 JSON,经 `GET /m/api/art/blink` 懒加载,不进页面。

**Tech Stack:** TypeScript(Bun + Node 双跑)、vitest、手机经典脚本(`apps/mobile/src`,`bun run build:mobile`)、Python PIL(一次性缩图)。

**Spec:** `docs/superpowers/specs/2026-09-26-memory-view-design.md`

## Global Constraints

- 只在 `dev` 上干活;不推送、不部署(部署由 controller 问过 owner 再做)。标准回路:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`。
- 显示顺序固定:`承诺` → `关于你` → `偏好` → `身边的人` → `近况`;空栏不显示。
- 「昨晚」= 最近一次整理日志,且距今 36 小时内;不列到期归档(`expire`);最多列 3 条,多出的写「还有 N 处」。
- 变化标签:add 进承诺 =「新记下」;其余 add =「记下」;update =「改了」(附「原来是:…」);remove =「删了」(附原因)。排序:新记下、改了(reversal 且在偏好/关于你)、删了 在前,其余 add / update 在后,各自保持日志顺序。
- 手写一句:最近变化 →「昨晚又认识了你一点。」;有记忆无变化 →「这是我眼中的你。」;还没有 memory.md →「今晚我会第一次整理。」。连续失败 ≥3:「最近几次整理都没成功,下面可能是旧的」(手机小字)/ 沿用「⚠️ 最近 N 次整理都没成功,下面可能是旧的。」(微信首行)。
- 期限标签:同日「今天」、+1「明天」、+2..+6「周X」(按期限那天)、其余「M月D日」。
- 口语时间(主人时区):同日「今天」、前一日「昨天」、其余「M月D日」,接时段:0–5 凌晨、6–10 早上、11–12 中午、13–17 下午、18–23 晚上,再接「H 点」(凌晨用 0–5,其余 12 小时制),如「今天凌晨 4 点」「昨天晚上 9 点」。
- 身边的人拆分:含「——」按第一个「——」拆;否则按第一个「:」或「:」拆;名字去空白后 1–12 字才拆,否则整句。
- 手机页:所有动态文字经 `esc()`;脚本行首不许 `(`/`[`;改完 `bun run build:mobile`;daemon 不 import `apps/mobile`;`prefers-reduced-motion: reduce` 时不呼吸不眨眼。
- 眨眼:帧序 half → closed → half → front,每帧 70ms,间隔 3000–7000ms 随机;只在「CC 眼中的你」可见且页面在前台时眨;帧没取到就只呼吸。
- 提交信息结尾带实际模型的 `Co-Authored-By` 行。

## Review Focus

1. **还没整理过(没有 memory.md)时点 CC** → 页面显示「今晚我会第一次整理。」,不显示空栏标题,不报错。→ Task 5 渲染测试 `first`。
2. **断网 / 隧道失败时点 CC** → 页面显示「暂时读不到」,CC 照样在;不留一片空白、不弹未捕获错误。→ Task 5 测试 `load failure`。
3. **记忆里有 `<img onerror>` 之类文字(模型或主人写的)** → 在手机页原样显示为文字,不生成元素。→ Task 5 测试 `escapes`。
4. **眨眼帧接口 401 / 失败** → 不显示破图、不抛错,只呼吸。→ Task 5 测试 `no frames`。
5. **期限是今天 / 明天 / 已过期 / 格式怪(全角括号)** → 标签正确;没识别出期限就原文照显,不吞字。→ Task 2 测试。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `src/daemon/memory/nightly.ts` | 提示词加两条规矩 + 拆分说明 |
| `src/daemon/memory/memory-text.ts`(新) | 纯函数:显示顺序、期限标签、去期限、身边的人拆分、口语时间、昨晚变化、微信文案 |
| `src/daemon/memory/nightly-runtime.ts` | `curatedView()` 返回富视图;`readCurated()` 用微信文案 |
| `src/daemon/admin-commands.ts` | 去掉「🧠 我记得的你:」前缀 |
| `src/daemon/settings-panel.ts` | `/m/api/memory` 透传富视图;新 `/m/api/art/blink` |
| `apps/mobile/art/blink-{half,closed}-256.png`(新) | 眨眼帧(一次性由脚本生成后提交) |
| `scripts/build-mobile-blink-art.ts`(新) + `src/daemon/mobile-blink-art.json`(新,生成物) | 帧 → daemon 侧 JSON |
| `apps/mobile/src/you.js`、`you.css`(新);`phone.html`、`presence.html`、`presence.js`、`home.js` | 新页面、入口、删除旧折叠区 |

---

### Task 1: 一条一件事(提示词)

**Files:**
- Modify: `src/daemon/memory/nightly.ts`(`buildNightlyPrompt` 的规则段)
- Test: `src/daemon/memory/nightly.test.ts`、`src/daemon/memory/nightly-ops.test.ts`

**Interfaces:**
- Produces: 提示词新增三行(下文逐字);无签名变化。

- [ ] **Step 1: 写失败测试**

`src/daemon/memory/nightly.test.ts` 末尾追加(文件已 import `buildNightlyPrompt`?没有就加进 import 列表):

```ts
describe('buildNightlyPrompt granularity rules', () => {
  it('asks for one fact per entry, commitments in 承诺, and splitting via update + add', () => {
    const p = buildNightlyPrompt({ today: '2026-09-26', current: '', material: '' })
    expect(p).toContain('- 每条只写一件事:一个人一条,一个偏好一条。')
    expect(p).toContain('- 欠别人的、别人欠主人的、约好的事放进「承诺」,有日期就在正文写「(期限 YYYY-MM-DD)」。')
    expect(p).toContain('- 当前记忆里一条写了好几件事时,把它拆开:用 update 把原条目改成其中一件(reversal=false),其余用 add。')
  })
})
```

`src/daemon/memory/nightly-ops.test.ts` 的 `describe('applyNightly')` 里追加:

```ts
  it('splitting one crowded entry via update + adds is accepted and removes nothing', () => {
    const d = emptyDoc()
    d.sections['身边的人'] = [{ id: 'd77a', text: '猪大哥:女友;莫秀文:视觉;黄灵希:搭档', seen: '2026-09-26' }]
    const r = applyNightly(d, {
      add: [{ section: '身边的人', text: '莫秀文 —— 帮 app 把视觉关' }, { section: '身边的人', text: '黄灵希 —— 事务上的搭档' }],
      update: [{ id: 'd77a', text: '猪大哥 —— 女友,最亲', reversal: false }],
      confirm: [], remove: [],
    }, opts)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.sections['身边的人'].map(e => e.text)).toEqual(['猪大哥 —— 女友,最亲', '莫秀文 —— 帮 app 把视觉关', '黄灵希 —— 事务上的搭档'])
    expect(r.applied.some(a => a.kind === 'remove')).toBe(false)
  })
```

(`emptyDoc` 已在该文件 import;若没有,从 `./curated-doc` 加。)

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly.test.ts src/daemon/memory/nightly-ops.test.ts`
Expected: prompt 测试 FAIL(缺三行);拆分测试 PASS(`applyNightly` 本来就支持 —— 它是回归钉子,说明拆分不会触发删除保护)。

- [ ] **Step 3: 实现**

`buildNightlyPrompt` 规则段里,在 `'- 删除必须写原因;只有确定不再成立才删。',` 之后插入三行:

```ts
    '- 每条只写一件事:一个人一条,一个偏好一条。',
    '- 欠别人的、别人欠主人的、约好的事放进「承诺」,有日期就在正文写「(期限 YYYY-MM-DD)」。',
    '- 当前记忆里一条写了好几件事时,把它拆开:用 update 把原条目改成其中一件(reversal=false),其余用 add。',
```

- [ ] **Step 4: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory && npx vitest run -c vitest.node.config.ts src/daemon/memory`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/nightly.ts src/daemon/memory/nightly.test.ts src/daemon/memory/nightly-ops.test.ts
git commit -m "记忆整理:一条一件事、欠的事进承诺、大杂烩用 update+add 拆开"
```

---

### Task 2: 显示用的纯函数 `memory-text.ts`

**Files:**
- Create: `src/daemon/memory/memory-text.ts`
- Test: `src/daemon/memory/memory-text.test.ts`

**Interfaces:**
- Consumes: `Section`、`SECTIONS`、`MemoryDoc`、`parseDue`(curated-doc);`AppliedOp`、`daysBetween`(nightly-ops);`localParts`(nightly-schedule)
- Produces:
  - `DISPLAY_ORDER: readonly Section[]` = `['承诺','关于你','偏好','身边的人','近况']`
  - `stripDue(text: string): string`
  - `dueLabel(due: string, today: string): string`
  - `splitPerson(text: string): { name: string; rel: string } | null`
  - `spokenTime(ms: number, tz: string, nowMs: number): string`
  - `type ChangeLabel = '新记下' | '记下' | '改了' | '删了'`
  - `interface ViewChange { kind: 'add' | 'update' | 'remove'; label: ChangeLabel; section: Section; text: string; before?: string; reason?: string }`
  - `viewChanges(applied: readonly AppliedOp[]): ViewChange[]`
  - `formatWeChatMemory(o: { doc: MemoryDoc; whenLabel: string | null; changes: readonly ViewChange[]; failures: number; today: string }): string`

- [ ] **Step 1: 写失败测试**

`src/daemon/memory/memory-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DISPLAY_ORDER, stripDue, dueLabel, splitPerson, spokenTime, viewChanges, formatWeChatMemory } from './memory-text'
import { emptyDoc } from './curated-doc'
import type { AppliedOp } from './nightly-ops'

describe('memory-text', () => {
  it('orders sections for display with 承诺 first', () => {
    expect(DISPLAY_ORDER).toEqual(['承诺', '关于你', '偏好', '身边的人', '近况'])
  })
  it('strips the due marker (ASCII or full-width parens) and keeps everything else', () => {
    expect(stripDue('给 X 回话(期限 2026-09-27)')).toBe('给 X 回话')
    expect(stripDue('给 X 回话(期限 2026-09-27)')).toBe('给 X 回话')
    expect(stripDue('没有期限的事')).toBe('没有期限的事')
  })
  it('labels dues relative to today', () => {
    expect(dueLabel('2026-09-26', '2026-09-26')).toBe('今天')
    expect(dueLabel('2026-09-27', '2026-09-26')).toBe('明天')
    expect(dueLabel('2026-10-02', '2026-09-26')).toBe('周五')
    expect(dueLabel('2026-10-20', '2026-09-26')).toBe('10月20日')
    expect(dueLabel('2026-09-20', '2026-09-26')).toBe('9月20日')
  })
  it('splits people on —— or the first colon, only when the name is short', () => {
    expect(splitPerson('猪大哥 —— 女友,最亲')).toEqual({ name: '猪大哥', rel: '女友,最亲' })
    expect(splitPerson('莫秀文:帮 app 把视觉关')).toEqual({ name: '莫秀文', rel: '帮 app 把视觉关' })
    expect(splitPerson('黄灵希: 事务搭档')).toEqual({ name: '黄灵希', rel: '事务搭档' })
    expect(splitPerson('一个很长很长很长很长的名字的人:说明')).toBeNull()
    expect(splitPerson('没有分隔的一句话')).toBeNull()
  })
  it('speaks times in the owner timezone', () => {
    const now = Date.parse('2026-09-26T02:00:00Z')   // 上海 10:00
    expect(spokenTime(Date.parse('2026-09-25T20:05:00Z'), 'Asia/Shanghai', now)).toBe('今天凌晨 4 点')
    expect(spokenTime(Date.parse('2026-09-25T13:00:00Z'), 'Asia/Shanghai', now)).toBe('昨天晚上 9 点')
    expect(spokenTime(Date.parse('2026-09-20T07:00:00Z'), 'Asia/Shanghai', now)).toBe('9月20日下午 3 点')
  })
  it('labels and orders changes: notable first, expire dropped', () => {
    const ops: AppliedOp[] = [
      { kind: 'add', id: 'a1', section: '关于你', text: '养了只猫' },
      { kind: 'update', id: 'b1', section: '偏好', text: '回复更直接', before: '回复直接', reversal: false },
      { kind: 'expire', id: 'c0', section: '近况', text: '旧近况', reason: 'recent_stale' },
      { kind: 'remove', id: 'd1', section: '近况', text: '在搬家', reason: '之后没再提' },
      { kind: 'add', id: 'a2', section: '承诺', text: '周五回话' },
      { kind: 'update', id: 'b2', section: '偏好', text: '先上线', before: '先打磨', reversal: true },
    ]
    expect(viewChanges(ops)).toEqual([
      { kind: 'add', label: '新记下', section: '承诺', text: '周五回话' },
      { kind: 'update', label: '改了', section: '偏好', text: '先上线', before: '先打磨' },
      { kind: 'remove', label: '删了', section: '近况', text: '在搬家', reason: '之后没再提' },
      { kind: 'add', label: '记下', section: '关于你', text: '养了只猫' },
      { kind: 'update', label: '改了', section: '偏好', text: '回复更直接', before: '回复直接' },
    ])
  })
  it('formats the WeChat letter', () => {
    const d = emptyDoc()
    d.sections['承诺'] = [{ id: 'a1', text: '周五回话(期限 2026-09-27)', seen: '2026-09-26' }]
    d.sections['关于你'] = [{ id: 'a2', text: '全栈 / 产品型开发者', seen: '2026-09-26' }]
    d.sections['身边的人'] = [{ id: 'a3', text: '猪大哥 —— 女友,最亲', seen: '2026-09-26' }]
    const changes = viewChanges([{ kind: 'add', id: 'a1', section: '承诺', text: '周五回话(期限 2026-09-27)' }])
    expect(formatWeChatMemory({ doc: d, whenLabel: '今天凌晨 4 点', changes, failures: 0, today: '2026-09-26' })).toBe([
      '这是我眼中的你 🌙',
      '今天凌晨 4 点整理的,改了 1 处。',
      '',
      '【昨晚】',
      '· 新记下:周五回话',
      '',
      '【承诺】',
      '· 周五回话(明天)',
      '',
      '【关于你】',
      '· 全栈 / 产品型开发者',
      '',
      '【身边的人】',
      '· 猪大哥 —— 女友,最亲',
      '',
      '不对的地方直接跟我说。在「随身 CC」点一下我,能看到更好看的版本。',
    ].join('\n'))
  })
  it('says there is nothing new, caps 昨晚 at 3, and puts the failure warning first', () => {
    const d = emptyDoc()
    d.sections['偏好'] = [{ id: 'b1', text: '回复直接', seen: '2026-09-26' }]
    const quiet = formatWeChatMemory({ doc: d, whenLabel: '昨天凌晨 4 点', changes: [], failures: 0, today: '2026-09-26' })
    expect(quiet.split('\n').slice(0, 3)).toEqual(['这是我眼中的你 🌙', '昨天凌晨 4 点整理的,最近没有新变化。', ''])
    expect(quiet).not.toContain('【昨晚】')
    const many = viewChanges(['一', '二', '三', '四'].map((t, i) => ({ kind: 'add' as const, id: `x${i}`, section: '偏好' as const, text: t })))
    const busy = formatWeChatMemory({ doc: d, whenLabel: null, changes: many, failures: 0, today: '2026-09-26' })
    expect(busy).toContain('· 记下:三\n· 还有 1 处')
    expect(busy.split('\n')[1]).toBe('改了 4 处。')
    expect(formatWeChatMemory({ doc: d, whenLabel: null, changes: [], failures: 3, today: '2026-09-26' }).split('\n')[0])
      .toBe('⚠️ 最近 3 次整理都没成功,下面可能是旧的。')
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/memory-text.test.ts`
Expected: FAIL,`Cannot find module './memory-text'`

- [ ] **Step 3: 实现**

```ts
/**
 * 记忆的「给人看」派生(spec 2026-09-26-memory-view-design):显示顺序、期限标签、身边的人两列、
 * 口语时间、昨晚变化、微信文案。纯函数;手机页与微信共用,手机脚本只渲染这里算好的结果。
 */
import { SECTIONS, parseDue, type MemoryDoc, type Section } from './curated-doc'
import { daysBetween, type AppliedOp } from './nightly-ops'
import { localParts } from './nightly-schedule'

export const DISPLAY_ORDER: readonly Section[] = ['承诺', '关于你', '偏好', '身边的人', '近况']
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function stripDue(text: string): string {
  return text.replace(/\s*[((]期限 \d{4}-\d{2}-\d{2}[))]/, '').trim()
}

export function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due)
  if (d === 0) return '今天'
  if (d === 1) return '明天'
  if (d >= 2 && d <= 6) return WEEK[new Date(`${due}T00:00:00Z`).getUTCDay()]!
  const [, m, day] = due.split('-')
  return `${Number(m)}月${Number(day)}日`
}

export function splitPerson(text: string): { name: string; rel: string } | null {
  const i = text.indexOf('——')
  let name: string, rel: string
  if (i >= 0) { name = text.slice(0, i); rel = text.slice(i + 2) }
  else {
    const m = /[::]/.exec(text)
    if (!m) return null
    name = text.slice(0, m.index); rel = text.slice(m.index + 1)
  }
  name = name.trim(); rel = rel.trim()
  if (!name || name.length > 12 || !rel) return null
  return { name, rel }
}

export function spokenTime(ms: number, tz: string, nowMs: number): string {
  const at = localParts(ms, tz), now = localParts(nowMs, tz)
  const gap = daysBetween(at.day, now.day)
  const [, m, d] = at.day.split('-')
  const dayWord = gap === 0 ? '今天' : gap === 1 ? '昨天' : `${Number(m)}月${Number(d)}日`
  const h = Number(at.hhmm.slice(0, 2))
  const period = h <= 5 ? '凌晨' : h <= 10 ? '早上' : h <= 12 ? '中午' : h <= 17 ? '下午' : '晚上'
  const hh = period === '凌晨' || h <= 12 ? h : h - 12
  return `${dayWord}${period} ${hh} 点`
}

export type ChangeLabel = '新记下' | '记下' | '改了' | '删了'
export interface ViewChange { kind: 'add' | 'update' | 'remove'; label: ChangeLabel; section: Section; text: string; before?: string; reason?: string }

export function viewChanges(applied: readonly AppliedOp[]): ViewChange[] {
  const notable: ViewChange[] = [], rest: ViewChange[] = []
  for (const op of applied) {
    if (op.kind === 'add') (op.section === '承诺' ? notable : rest).push({ kind: 'add', label: op.section === '承诺' ? '新记下' : '记下', section: op.section, text: op.text })
    else if (op.kind === 'update') {
      const v: ViewChange = { kind: 'update', label: '改了', section: op.section, text: op.text, before: op.before }
      ;(op.reversal && (op.section === '偏好' || op.section === '关于你') ? notable : rest).push(v)
    } else if (op.kind === 'remove') notable.push({ kind: 'remove', label: '删了', section: op.section, text: op.text, reason: op.reason })
  }
  return [...notable, ...rest]
}

function changeLine(c: ViewChange): string {
  const text = stripDue(c.text)
  if (c.kind === 'update') return `· 改了:${text}${c.before ? `(原来是${stripDue(c.before)})` : ''}`
  if (c.kind === 'remove') return `· 删了:${text}${c.reason ? `(${c.reason})` : ''}`
  return `· ${c.label}:${text}`
}

function itemLine(section: Section, text: string, today: string): string {
  if (section === '承诺') {
    const due = parseDue(text.replace(/[((]/, '(').replace(/[))]/, ')'))
    return `· ${stripDue(text)}${due ? `(${dueLabel(due, today)})` : ''}`
  }
  if (section === '身边的人') {
    const p = splitPerson(text)
    if (p) return `· ${p.name} —— ${p.rel}`
  }
  return `· ${text}`
}

export function formatWeChatMemory(o: { doc: MemoryDoc; whenLabel: string | null; changes: readonly ViewChange[]; failures: number; today: string }): string {
  const out: string[] = []
  if (o.failures >= 3) out.push(`⚠️ 最近 ${o.failures} 次整理都没成功,下面可能是旧的。`)
  else {
    out.push('这是我眼中的你 🌙')
    const tail = o.changes.length ? `改了 ${o.changes.length} 处。` : '最近没有新变化。'
    out.push(o.whenLabel ? `${o.whenLabel}整理的,${tail}` : tail)
  }
  if (o.failures < 3 && o.changes.length) {
    out.push('', '【昨晚】', ...o.changes.slice(0, 3).map(changeLine))
    if (o.changes.length > 3) out.push(`· 还有 ${o.changes.length - 3} 处`)
  }
  for (const s of DISPLAY_ORDER) {
    const items = o.doc.sections[s]
    if (!items.length) continue
    out.push('', `【${s}】`, ...items.map(e => itemLine(s, e.text, o.today)))
  }
  if (o.doc.extra.length) out.push('', '【其它】', ...o.doc.extra)
  out.push('', '不对的地方直接跟我说。在「随身 CC」点一下我,能看到更好看的版本。')
  return out.join('\n')
}

export { SECTIONS }
```

- [ ] **Step 4: 跑,确认绿(两个运行器)+ typecheck**

Run: `bun --bun vitest run src/daemon/memory/memory-text.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/memory-text.test.ts && bun run typecheck`
Expected: 8 passed ×2;typecheck 0

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/memory-text.ts src/daemon/memory/memory-text.test.ts
git commit -m "记忆显示派生:期限标签、身边的人两列、口语时间、昨晚变化、微信文案"
```

---

### Task 3: 富视图、微信文案、手机接口

**Files:**
- Modify: `src/daemon/memory/nightly-runtime.ts`(`CuratedView` 类型、`curatedView()`、`readCurated()`)
- Modify: `src/daemon/admin-commands.ts:694`(去前缀)
- Modify: `src/daemon/settings-panel.ts:538-542`(透传)
- Test: `src/daemon/memory/nightly-runtime.test.ts`、`src/daemon/admin-commands.test.ts`、`src/daemon/settings-panel.test.ts`

**Interfaces:**
- Consumes: Task 2 全部
- Produces:
  - `interface CuratedItem { id: string | null; text: string; display: string; due: string | null; due_label: string | null; person: { name: string; rel: string } | null; changed: boolean }`
  - `interface CuratedView { updated_at: string | null; when_label: string | null; mood: 'changed' | 'steady' | 'first'; failures: number; changes: ViewChange[]; sections: Array<{ name: Section; items: CuratedItem[] }> }`
  - `curatedView()` 在没有 memory.md 时返回 `{ updated_at: null, when_label: null, mood: 'first', failures, changes: [], sections: [] }`(不再返回 null);有 memory.md 时 `sections` 按 `DISPLAY_ORDER`、只含非空栏。
  - `/m/api/memory` 响应 = `{ ok: true, ...curatedView() }`。

- [ ] **Step 1: 写失败测试**

在 `src/daemon/memory/nightly-runtime.test.ts` 追加(沿用文件里的 `deps()` 与 `beforeEach`;时区是 'UTC'):

```ts
describe('rich view + WeChat letter', () => {
  it('first: no memory.md yet', () => {
    const v = makeMemoryNightlyRuntime(deps()).curatedView()!
    expect(v).toMatchObject({ mood: 'first', updated_at: null, when_label: null, changes: [], sections: [] })
  })
  it('changed: derived display fields, order, labels', async () => {
    const rt = makeMemoryNightlyRuntime(deps({
      cheapEval: () => async () => JSON.stringify({ add: [
        { section: '承诺', text: '周五回话(期限 2026-09-26)' },
        { section: '身边的人', text: '猪大哥 —— 女友,最亲' },
      ], update: [], confirm: [], remove: [] }),
    }))
    await rt.runNow()
    const v = rt.curatedView()!
    expect(v.mood).toBe('changed')
    expect(v.when_label).toBe('今天凌晨 4 点')
    expect(v.sections.map(s => s.name)).toEqual(['承诺', '身边的人'])
    expect(v.sections[0]!.items[0]).toMatchObject({ display: '周五回话', due: '2026-09-26', due_label: '明天', person: null, changed: true })
    expect(v.sections[1]!.items[0]).toMatchObject({ person: { name: '猪大哥', rel: '女友,最亲' } })
    expect(v.changes.map(c => c.label)).toEqual(['新记下', '记下'])
  })
  it('steady after the changed window; WeChat letter uses the new format', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    now = Date.parse('2026-09-27T20:00:00Z')   // > 36h later
    expect(rt.curatedView()!.mood).toBe('steady')
    const text = rt.readCurated()!
    expect(text.split('\n')[0]).toBe('这是我眼中的你 🌙')
    expect(text).toContain('最近没有新变化。')
    expect(text).toContain('【承诺】')
  })
})
```

(若文件里现有的 `readCurated` / `curatedView` 旧断言与新格式冲突 —— 旧首行「最近整理:… · 改了 N 处」、旧 `curatedView` 返回 null —— 把它们改成新格式下的等价断言:首行 `这是我眼中的你 🌙`,第二行含「整理的,改了 1 处。」;无 memory.md 时 `mood: 'first'`;三次失败首行不变。)

`src/daemon/admin-commands.test.ts` 里 `查看记忆 shows the curated memory when there is one` 那条,把期望改为不带前缀:`expect(sentBody(0)).toBe('最近整理:2026-09-25 04:05 · 改了 1 处\n\n### 偏好\n- 回复直接')`(即原样发出 `readCuratedMemory` 的返回值)。

`src/daemon/settings-panel.test.ts` 的 `phone curated memory` 用例里,把 `view` 换成新形状并断言透传:

```ts
    const view = { updated_at: '2026-09-25T04:05:00.000Z', when_label: '今天凌晨 4 点', mood: 'changed' as const, failures: 0,
      changes: [{ kind: 'add' as const, label: '新记下' as const, section: '承诺' as const, text: '周五回话' }],
      sections: [{ name: '偏好' as const, items: [{ id: 'b1', text: '回复直接', display: '回复直接', due: null, due_label: null, person: null, changed: true }] }] }
```

断言保持 `expect(r).toEqual({ ok: true, ...view })`。

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly-runtime.test.ts src/daemon/admin-commands.test.ts src/daemon/settings-panel.test.ts`
Expected: 新用例 FAIL(字段缺失 / 旧格式 / 前缀)

- [ ] **Step 3: 实现**

`nightly-runtime.ts`:
- import `{ DISPLAY_ORDER, dueLabel, splitPerson, spokenTime, stripDue, viewChanges, formatWeChatMemory, type ViewChange }` from `./memory-text`;删掉不再用的 `renderForPrompt`、`SECTIONS` import(若别处仍用则保留)。
- 替换 `CuratedView` 类型为本任务 Produces 里的两个接口(导出 `CuratedItem`)。
- `readCurated()`:

```ts
    readCurated() {
      const got = readDoc()
      if (!got) return null
      const state = readNightlyState(deps.stateDir)
      const tz = deps.config().timezone
      const log = lastLog(got.root)
      const fresh = !!log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      return formatWeChatMemory({
        doc: got.doc,
        whenLabel: state.lastRunIso ? spokenTime(Date.parse(state.lastRunIso), tz, deps.now()) : null,
        changes: fresh ? viewChanges(log!.ops) : [],
        failures: state.failures,
        today: localParts(deps.now(), tz).day,
      })
    },
```

- `curatedView()`:

```ts
    curatedView() {
      const state = readNightlyState(deps.stateDir)
      const got = readDoc()
      if (!got) return { updated_at: null, when_label: null, mood: 'first', failures: state.failures, changes: [], sections: [] }
      const tz = deps.config().timezone
      const today = localParts(deps.now(), tz).day
      const log = lastLog(got.root)
      const fresh = !!log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      const changes: ViewChange[] = fresh ? viewChanges(log!.ops) : []
      const changed = new Set(fresh ? log!.ops.filter(o => o.kind === 'add' || o.kind === 'update').map(o => o.id) : [])
      return {
        updated_at: state.lastRunIso,
        when_label: state.lastRunIso ? spokenTime(Date.parse(state.lastRunIso), tz, deps.now()) : null,
        mood: changes.length ? 'changed' : 'steady',
        failures: state.failures,
        changes,
        sections: DISPLAY_ORDER.filter(name => got.doc.sections[name].length).map(name => ({
          name,
          items: got.doc.sections[name].map(e => {
            const due = parseDue(e.text.replace(/[((]/, '(').replace(/[))]/, ')'))
            return {
              id: e.id, text: e.text, display: stripDue(e.text), due,
              due_label: due ? dueLabel(due, today) : null,
              person: name === '身边的人' ? splitPerson(e.text) : null,
              changed: !!e.id && changed.has(e.id),
            }
          }),
        })),
      }
    },
```

  (`MemoryNightlyRuntime.curatedView` 的返回类型改为 `CuratedView`,不再 `| null`;`parseDue` 从 `./curated-doc` import。)

- `admin-commands.ts:694`:把 `` `🧠 我记得的你:\n\n${curated}` `` 改为 `curated`。
- `settings-panel.ts:538-542`:

```ts
          if (url.pathname === '/m/api/memory' && req.method === 'GET') {
            if (!deps.curatedMemory) return json({ ok: false, error: 'memory_not_wired' }, 503)
            return json({ ok: true, ...deps.curatedMemory() })
          }
```

  并把 `settings-panel.ts:106` 的 dep 类型改为 `curatedMemory?: () => import('./memory/nightly-runtime').CuratedView`。

- [ ] **Step 4: 跑,确认绿(两个运行器)+ typecheck**

Run: `bun --bun vitest run src/daemon/memory src/daemon/admin-commands.test.ts src/daemon/settings-panel.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory src/daemon/admin-commands.test.ts src/daemon/settings-panel.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/nightly-runtime.ts src/daemon/memory/nightly-runtime.test.ts src/daemon/admin-commands.ts src/daemon/admin-commands.test.ts src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts
git commit -m "记忆富视图(期限标签/两列/口语时间/昨晚变化/情绪)+ 微信信件排版 + 手机接口透传"
```

---

### Task 4: 眨眼帧(懒加载资产)

**Files:**
- Create: `apps/mobile/art/blink-half-256.png`、`apps/mobile/art/blink-closed-256.png`(一次性生成后提交)
- Create: `scripts/build-mobile-blink-art.ts`、`src/daemon/mobile-blink-art.json`(生成物)
- Modify: `src/daemon/settings-panel.ts`(新路由)
- Test: `src/daemon/mobile-blink-art.test.ts`、`src/daemon/settings-panel.test.ts`

**Interfaces:**
- Produces: `GET /m/api/art/blink` → `{ ok: true, mime: 'image/png', half: string, closed: string }`(base64);令牌门同其它 `/m/api/*`(无令牌 401)。

- [ ] **Step 1: 生成 256px 全彩帧(一次性)**

```bash
mkdir -p apps/mobile/art
python3 - <<'EOF'
from PIL import Image
for n in ['blink-half', 'blink-closed']:
    im = Image.open(f'apps/desktop/src/assets/pet/cc-v1/sprites/lit/{n}.png').convert('RGBA')
    im.resize((256, 256), Image.LANCZOS).save(f'apps/mobile/art/{n}-256.png', optimize=True)
EOF
ls -la apps/mobile/art
```

Expected: 两个文件,各约 38KB。(不要量化、不要降色 —— owner 否决过 128 色版本。)

- [ ] **Step 2: 写失败测试**

`src/daemon/mobile-blink-art.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import art from './mobile-blink-art.json'

describe('lazy blink frames', () => {
  it('embeds the committed 256px frames byte-for-byte', () => {
    for (const key of ['half', 'closed'] as const) {
      const entry = art[key]
      const source = readFileSync(new URL('../../' + entry.source, import.meta.url))
      expect(Buffer.from(entry.base64, 'base64')).toEqual(source)
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sha256)
      expect(source.byteLength).toBeGreaterThan(20_000)   // 全彩,不是量化版
    }
  })
})
```

在 `src/daemon/settings-panel.test.ts` 的 `phone curated memory` describe 里追加:

```ts
  it('serves the blink frames behind the token', async () => {
    const p = makeSettingsPanel({
      stateDir: mkdtempSync(join(tmpdir(), 'sp-art-')), ownerChatId: () => null,
      chatPrefs: { get: () => ({}), set: (_id, patch) => patch },
      getUserName: () => null, setUserName: async () => {}, log: () => {},
    })
    const { port } = await p.start(0)
    try {
      const base = `http://127.0.0.1:${port}`
      expect((await fetch(`${base}/m/api/art/blink`)).status).toBe(401)
      const r = await (await fetch(`${base}/m/api/art/blink?t=${p.issueToken()}`)).json() as { ok: boolean; mime: string; half: string; closed: string }
      expect(r.ok).toBe(true)
      expect(r.mime).toBe('image/png')
      expect(Buffer.from(r.half, 'base64').subarray(1, 4).toString()).toBe('PNG')
      expect(Buffer.from(r.closed, 'base64').subarray(1, 4).toString()).toBe('PNG')
    } finally { await p.stop() }
  })
```

Run: `bun --bun vitest run src/daemon/mobile-blink-art.test.ts src/daemon/settings-panel.test.ts`
Expected: FAIL(JSON 不存在 / 路由 404)

- [ ] **Step 3: 构建脚本 + 生成 JSON**

`scripts/build-mobile-blink-art.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// 「CC 眼中的你」的眨眼帧:256px 全彩,懒加载(不进 /m 页面,守 512KB 中继帧)。源文件在 apps/mobile/art/。
const art = Object.fromEntries((['half', 'closed'] as const).map(key => {
  const path = `apps/mobile/art/blink-${key}-256.png`
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url))
  return [key, { source: path, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }]
}))
writeFileSync(new URL('../src/daemon/mobile-blink-art.json', import.meta.url), JSON.stringify(art) + '\n')
```

Run: `bun scripts/build-mobile-blink-art.ts`

- [ ] **Step 4: 路由**

`src/daemon/settings-panel.ts` 顶部 import:`import blinkArt from './mobile-blink-art.json'`;在 `/m/api/memory` 路由之后加:

```ts
          if (url.pathname === '/m/api/art/blink' && req.method === 'GET') {
            return json({ ok: true, mime: 'image/png', half: blinkArt.half.base64, closed: blinkArt.closed.base64 })
          }
```

(放在令牌门之后 —— 与 `/m/api/memory` 同一区域即可。)在 `.gitattributes` 末尾加一行 `apps/mobile/art/** -text`(二进制原样进出,同 pet 资产的做法)。

- [ ] **Step 5: 跑,确认绿(两个运行器)+ typecheck + depcheck**

Run: `bun --bun vitest run src/daemon/mobile-blink-art.test.ts src/daemon/settings-panel.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/mobile-blink-art.test.ts src/daemon/settings-panel.test.ts && bun run typecheck && bun run depcheck`
Expected: 全绿;depcheck 0 error(daemon 只 import 自己目录下的 JSON)

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/art scripts/build-mobile-blink-art.ts src/daemon/mobile-blink-art.json src/daemon/mobile-blink-art.test.ts src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts .gitattributes
git commit -m "眨眼帧:256px 全彩、懒加载接口 /m/api/art/blink(不进页面,守 512KB)"
```

---

### Task 5: 手机「CC 眼中的你」页

**Files:**
- Create: `apps/mobile/src/you.js`、`apps/mobile/src/you.css`
- Modify: `apps/mobile/src/phone.html`(新 pane、包含 you.js / you.css、删 `mem-box` 与 `.mem-dot/.mem-at` 样式)、`apps/mobile/src/presence.html`(CC 可点、提示语)、`apps/mobile/src/presence.js`(点 CC 打开)、`apps/mobile/src/home.js`(删 `loadMemory` 与 `memBox`)、`apps/mobile/build.test.ts`(ASI 列表加 `you.js`)、`apps/mobile/README.md`(一行)
- Regenerate: `src/daemon/mobile-page.generated.json`
- Test: `apps/mobile/you.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `CuratedView` JSON 形状;Task 4 的 `/m/api/art/blink`
- Produces(经典脚本全局):`youHtml(v): string`、`openYou(): void`、`loadYou(): Promise<void>`

- [ ] **Step 1: 写失败测试**

`apps/mobile/you.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { readMobileSource } from './sources'

function el() { return { innerHTML: '', textContent: '', hidden: false, src: '', classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => true }, addEventListener: vi.fn(), setAttribute: vi.fn() } }
function load(api: (p: string) => Promise<{ json: () => Promise<unknown> }>) {
  const els: Record<string, ReturnType<typeof el>> = {}
  const get = (id: string) => (els[id] ??= el())
  const env = {
    document: { getElementById: get, querySelectorAll: () => [], querySelector: () => el(), hidden: false, addEventListener: vi.fn() },
    window: { matchMedia: () => ({ matches: true }) },   // reduced motion: 不起定时器
    api, mobilePane: vi.fn(), setTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  }
  const fns = new Function(...Object.keys(env), `${readMobileSource('you.js')}\nreturn { youHtml, loadYou }`)(...Object.values(env)) as
    { youHtml: (v: unknown) => string; loadYou: () => Promise<void> }
  return { ...fns, els }
}
const base = { updated_at: '2026-09-25T20:00:00Z', when_label: '今天凌晨 4 点', failures: 0 }

describe('CC 眼中的你', () => {
  it('first: invites the first tidy, no section titles', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'first', changes: [], sections: [] })
    expect(h).toContain('今晚我会第一次整理。')
    expect(h).not.toContain('承 诺')
  })
  it('changed: line, note with labels and 原来是, dues, people columns, new dots, footer', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'changed',
      changes: [{ kind: 'add', label: '新记下', section: '承诺', text: '周五回话' }, { kind: 'update', label: '改了', section: '偏好', text: '先上线', before: '先打磨' }],
      sections: [
        { name: '承诺', items: [{ id: 'a', text: '周五回话(期限 2026-09-26)', display: '周五回话', due: '2026-09-26', due_label: '明天', person: null, changed: true }] },
        { name: '身边的人', items: [{ id: 'b', text: '猪大哥 —— 女友', display: '猪大哥 —— 女友', due: null, due_label: null, person: { name: '猪大哥', rel: '女友' }, changed: false }] },
      ] })
    expect(h).toContain('昨晚又认识了你一点。')
    expect(h).toContain('最近整理 · 今天凌晨 4 点')
    expect(h).toContain('新记下')
    expect(h).toContain('原来是:先打磨')
    expect(h).toContain('承 诺')
    expect(h).toContain('>明天<')
    expect(h).toContain('>猪大哥<')
    expect(h).toContain('you-new')
    expect(h).toContain('不对的地方,直接跟我说。')
  })
  it('steady and failing states', () => {
    const { youHtml } = load(async () => ({ json: async () => ({}) }))
    expect(youHtml({ ...base, mood: 'steady', changes: [], sections: [] })).toContain('这是我眼中的你。')
    expect(youHtml({ ...base, failures: 3, mood: 'steady', changes: [], sections: [] })).toContain('最近几次整理都没成功,下面可能是旧的')
  })
  it('escapes every dynamic string', () => {
    const h = load(async () => ({ json: async () => ({}) })).youHtml({ ...base, mood: 'changed',
      changes: [{ kind: 'add', label: '记下', section: '偏好', text: '<img src=x onerror=alert(1)>' }],
      sections: [{ name: '偏好', items: [{ id: 'a', text: '<script>x</script>', display: '<script>x</script>', due: null, due_label: null, person: null, changed: false }] }] })
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<script>')
    expect(h).toContain('&lt;script&gt;')
  })
  it('load failure shows 暂时读不到 instead of a blank page', async () => {
    const { loadYou, els } = load(async () => { throw new Error('offline') })
    await loadYou()
    expect(els['you-body']!.innerHTML).toContain('暂时读不到')
  })
  it('no frames: a failing art fetch does not throw and leaves the image alone', async () => {
    const api = vi.fn(async (p: string) => {
      if (p === '/m/api/art/blink') throw new Error('401')
      return { json: async () => ({ ok: true, ...base, mood: 'steady', changes: [], sections: [] }) }
    })
    const { loadYou, els } = load(api)
    await expect(loadYou()).resolves.toBeUndefined()
    expect(els['you-img']!.src).toBe('')
  })
})
```

Run: `bun --bun vitest run apps/mobile/you.test.ts`
Expected: FAIL(`you.js` 不存在)

- [ ] **Step 2: 写 you.js**

`apps/mobile/src/you.js`:

```js
// 「CC 眼中的你」(spec 2026-09-26-memory-view-design):一封信的样子,只读。
// 显示用的派生(期限标签、两列、口语时间、变化标签)都由 daemon 算好;这里只渲染。
var youFrames = null, youBlinkTimer = null, youFramesAsked = false
var YOU_ORDER_NOTE = 3
function youReduced() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) }
function youLine(v) {
  if (v.mood === "first") return "今晚我会第一次整理。"
  return v.mood === "changed" ? "昨晚又认识了你一点。" : "这是我眼中的你。"
}
function youMeta(v) {
  if (v.failures >= 3) return "最近几次整理都没成功,下面可能是旧的"
  return v.when_label ? "最近整理 · " + v.when_label : ""
}
function youNote(v) {
  if (!v.changes || !v.changes.length) return ""
  var h = '<div class="you-note"><div class="you-eyebrow">昨晚</div>'
  v.changes.slice(0, YOU_ORDER_NOTE).forEach(function(c) {
    h += '<div class="you-ch"><span class="you-k">' + esc(c.label) + '</span><span>' + esc(c.text)
    if (c.kind === "update" && c.before) h += '<br><span class="you-was">原来是:' + esc(c.before) + '</span>'
    if (c.kind === "remove" && c.reason) h += '<br><span class="you-was">' + esc(c.reason) + '</span>'
    h += '</span></div>'
  })
  if (v.changes.length > YOU_ORDER_NOTE) h += '<div class="you-was">还有 ' + (v.changes.length - YOU_ORDER_NOTE) + ' 处</div>'
  return h + '</div>'
}
function youItem(section, it) {
  var dot = it.changed ? '<span class="you-new" aria-label="昨晚更新"></span>' : ""
  if (it.person) return '<div class="you-who"><b>' + esc(it.person.name) + '</b><span>' + esc(it.person.rel) + dot + '</span></div>'
  var due = it.due_label ? '<span class="you-due">' + esc(it.due_label) + '</span>' : ""
  return '<div class="you-it"><span>' + esc(it.display) + dot + '</span>' + due + '</div>'
}
function youHtml(v) {
  var h = '<p class="you-line">' + esc(youLine(v)) + '</p><p class="you-meta">' + esc(youMeta(v)) + '</p>'
  if (v.mood === "first") return h
  h += youNote(v)
  v.sections.forEach(function(s) {
    h += '<div class="you-sec">' + esc(s.name.split("").join(" ")) + '</div>'
    s.items.forEach(function(it) { h += youItem(s.name, it) })
  })
  return h + '<p class="you-foot">不对的地方,直接跟我说。</p>'
}
function youBlinkOnce() {
  var img = /** @type {HTMLImageElement} */ (document.getElementById("you-img"))
  var front = img.getAttribute("data-front") || img.src
  var seq = [youFrames.half, youFrames.closed, youFrames.half, front], i = 0
  var t = setInterval(function() { img.src = seq[i++]; if (i >= seq.length) clearInterval(t) }, 70)
}
function youBlinkLoop() {
  if (youReduced() || youBlinkTimer) return
  youBlinkTimer = setTimeout(function() {
    youBlinkTimer = null
    var pane = document.getElementById("p-you")
    if (!pane || !pane.classList.contains("on") || document.hidden) return
    if (youFrames) youBlinkOnce()
    youBlinkLoop()
  }, 3000 + Math.random() * 4000)
}
function youLoadFrames() {
  if (youFramesAsked) return Promise.resolve()
  youFramesAsked = true
  return api("/m/api/art/blink").then(function(r) { return r.json() }).then(function(f) {
    if (f && f.ok) youFrames = { half: "data:" + f.mime + ";base64," + f.half, closed: "data:" + f.mime + ";base64," + f.closed }
  }).catch(function() { youFramesAsked = false })
}
function loadYou() {
  var body = document.getElementById("you-body")
  youLoadFrames()
  return api("/m/api/memory").then(function(r) { return r.json() }).then(function(v) {
    if (!v || !v.ok) throw new Error("unavailable")
    body.innerHTML = youHtml(v)
  }).catch(function() {
    body.innerHTML = '<p class="you-line">暂时读不到。</p><p class="you-meta">看看电脑开着没,一会儿再点我。</p>'
  })
}
function openYou() {
  var light = /** @type {HTMLImageElement} */ (document.querySelector(".home-light"))
  var img = /** @type {HTMLImageElement} */ (document.getElementById("you-img"))
  if (light && !img.getAttribute("data-front")) { img.src = light.src; img.setAttribute("data-front", light.src) }
  document.querySelectorAll(".pane").forEach(function(p) { p.classList.toggle("on", p.id === "p-you") })
  document.querySelectorAll("nav button").forEach(function(b) { b.classList.remove("on") })
  loadYou()
  youBlinkLoop()
}
document.getElementById("you-back").addEventListener("click", function() { mobilePane("today") })
document.addEventListener("visibilitychange", function() { if (!document.hidden) youBlinkLoop() })
```

注意:测试里 `document.querySelector` 返回一个没有 `src` 的假元素、`you-img` 的 `src` 初始为 ''、`youLoadFrames` 失败时不碰 `you-img` —— 与测试 `no frames` 对应。行首没有 `(` / `[`。

- [ ] **Step 3: 样式与结构**

`apps/mobile/src/you.css`:

```css
#p-you{padding:8px 22px 40px}
.you-back{border:0;background:none;color:var(--soft);font:inherit;font-size:12px;min-height:44px;padding:8px 0}
.you-hero{position:relative;height:190px;display:flex;align-items:flex-end;justify-content:center}
.you-halo{position:absolute;top:0;left:calc(50% - 85px);width:170px;height:170px;border-radius:50%;background:radial-gradient(circle,rgba(255,236,205,.95) 0%,rgba(255,236,205,0) 68%);animation:you-glow 4.2s ease-in-out infinite}
.you-cc{width:128px;height:128px;position:relative;animation:you-breathe 4.2s ease-in-out infinite;transform-origin:50% 92%}
.you-cc img{width:100%;height:100%;object-fit:contain}
@keyframes you-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.025,1.035)}}
@keyframes you-glow{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}
.you-line{font-family:"Kaiti SC","STKaiti",serif;color:#8a7a66;font-size:15px;text-align:center;margin:8px 0 2px}
.you-meta{text-align:center;color:var(--soft);font-size:11.5px;margin:0}
.you-note{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 14px;margin:18px 0 6px}
.you-eyebrow{font-size:11px;color:var(--soft);letter-spacing:.08em;margin-bottom:4px}
.you-ch{display:flex;gap:8px;padding:3px 0;font-size:13.5px}
.you-k{flex:none;font-size:11px;color:#b0763a;border:1px solid #efd9bd;border-radius:999px;padding:0 7px;height:18px;line-height:17px;margin-top:2px}
.you-was{color:var(--soft);font-size:12px}
.you-sec{font-size:11px;color:var(--soft);letter-spacing:.12em;margin:24px 0 4px}
.you-it,.you-who{display:flex;gap:10px;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.you-who{justify-content:flex-start}.you-who b{font-weight:550;min-width:48px}
.you-due{flex:none;font-size:11.5px;color:#b0763a}
.you-new{display:inline-block;width:6px;height:6px;border-radius:50%;background:#e8a25a;margin-left:6px;vertical-align:middle}
.you-foot{text-align:center;color:#b3a896;font-size:12px;margin-top:26px;font-family:"Kaiti SC","STKaiti",serif}
.home-character{cursor:pointer}
@media(prefers-reduced-motion:reduce){.you-cc,.you-halo{animation:none}}
```

`apps/mobile/src/phone.html`:
- 删除 `<details class="memory-pocket" id="mem-box">…</details>` 那一行,删除 `.mem-dot … .mem-at …` 那一行样式。
- 在 `<div class="pane" id="p-matters">` 之前加:

```html
<div class="pane" id="p-you">
  <button id="you-back" class="you-back" type="button">← 回去</button>
  <div class="you-hero" aria-hidden="true"><div class="you-halo"></div><div class="you-cc"><img id="you-img" alt=""></div></div>
  <div id="you-body" aria-live="polite"></div>
</div>
```

- 在 `<style>{{>presence.css}}</style>` 之后加 `<style>{{>you.css}}</style>`。
- 脚本包含串 `…{{>presence.js}}{{>home.js}}` 改为 `…{{>presence.js}}{{>you.js}}{{>home.js}}`。

`apps/mobile/src/presence.html`:`<div class="home-character" role="img" aria-label="CC">` 改为 `<div class="home-character" role="button" tabindex="0" aria-label="看看 CC 眼中的你">`;`<p class="home-greeting">你来啦。</p>` 改为 `<p class="home-greeting">你来啦 · 点我看看我记得你什么</p>`。

`apps/mobile/src/presence.js` 末尾(最后一行 `setTimeout(...)` 之前)加:

```js
var homeCharacter = document.querySelector(".home-character")
homeCharacter.addEventListener("click", function(){ openYou() })
homeCharacter.addEventListener("keydown", function(/** @type {KeyboardEvent} */ ev){ if (ev.key === "Enter" || ev.key === " ") openYou() })
```

`apps/mobile/src/home.js`:删除 `// CC 记得你(2026-09-25)…` 注释起、到 `memBox.addEventListener(…)` 为止的整段(`loadMemory` 函数与 `memBox` 两行)。

`apps/mobile/build.test.ts`:ASI 检查的文件名数组加 `'you.js'`。

`apps/mobile/README.md` 的包含顺序那一条改为 `boot.js` → `transport.js` → `nav.js` → `workbench.js` → `presence.js` → `you.js` → `home.js`。

- [ ] **Step 4: 生成、类型、全部手机测试**

Run: `bun run build:mobile && bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel && npx vitest run -c vitest.node.config.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel`
Expected: 全绿(包括 `apps/mobile/build.test.ts` 同步 / ASI、`mobile-page-presence.test.ts` 的 512KB 帧、`pairing.test.ts`、新的 `you.test.ts` 6 条)。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile src/daemon/mobile-page.generated.json
git commit -m "手机「CC 眼中的你」:点此刻的 CC 进入,一封信排版,呼吸 + 懒加载眨眼;去掉旧折叠区"
```

---

### Task 6: 文档与整套回路

**Files:**
- Modify: `docs/maintainer/mobile-presence.md`(加一段「CC 眼中的你」)、`docs/roadmap.md`(在 2026-09-25 那条每晚整理后面补一句)

- [ ] **Step 1: 文档**

- `docs/maintainer/mobile-presence.md` 末尾加:

```markdown
## CC 眼中的你(2026-09-26)

「此刻」点 CC 进入 `p-you`:一封信的样子(手写一句、「昨晚」便签、五栏按承诺→关于你→偏好→身边的人→近况)。显示派生全部由 daemon `src/daemon/memory/memory-text.ts` 算好,经 `/m/api/memory` 下发;眨眼帧 256px 全彩经 `/m/api/art/blink` 懒加载,不进页面(守 512KB 中继帧)。源码 `apps/mobile/src/you.{js,css}`。
```

- `docs/roadmap.md`:找到 2026-09-25 每晚整理那一行,在句末补「;09-26 界面改版:手机「CC 眼中的你」、微信信件排版、一条一件事」。

- [ ] **Step 2: 整套回路**

```bash
bun run test > "$SCRATCH/mv-bun.txt" 2>&1; tail -5 "$SCRATCH/mv-bun.txt"
npm run test:node > "$SCRATCH/mv-node.txt" 2>&1; tail -5 "$SCRATCH/mv-node.txt"
bun run typecheck && bun run depcheck
```

(`$SCRATCH` = controller 给的 scratchpad 目录。)Expected:两套全绿;typecheck 0;depcheck 0 error。已知负载抖动 `src/daemon/settings-panel-workbench.test.ts` 若超时,单独跑该文件 3 次都过才算抖动。

- [ ] **Step 3: 提交**

```bash
git add docs
git commit -m "文档:CC 眼中的你(懒加载眨眼、显示派生在 daemon)"
```
