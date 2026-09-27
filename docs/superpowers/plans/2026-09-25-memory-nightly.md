# 每晚整理记忆 + 看得见 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主人的长期记忆变成一份每晚自动整理、每次对话都读、手机和微信都能看、有值得说的变化会告诉主人的 `memory.md`。

**Architecture:** 纯函数四件(`curated-doc` 解析写回 / `nightly-ops` 校验执行改动 / `nightly-notify` 该不该说与怎么说 / `nightly-schedule` 时间判断)+ 一个编排(`nightly.ts` 跑一次整理)+ 一个运行时(`nightly-runtime.ts` 定时、送信、给微信和手机的视图)。模型只回改动清单(JSON),程序执行、校验、做到期新陈代谢。接线在 `pipeline-deps.ts` 造运行时,`main.ts` 挂生命周期,提示词、写入闸、微信命令、手机页、CLI 各接一处。

**Tech Stack:** TypeScript(Bun + Node 双跑)、vitest、`Intl.DateTimeFormat` 时区、现有 `startCompanionScheduler` / care ledger / cheapEval / `apps/mobile` 构建。

**Spec:** `docs/superpowers/specs/2026-09-25-memory-nightly-design.md`

## Global Constraints

- 只在 `dev` 上干活;进 master 只走 PR + squash;标准回路四件全绿:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`。
- 五栏固定且有序:`关于你`、`偏好`、`承诺`、`身边的人`、`近况`。
- 文件名 `memory.md`,路径 `<stateDir>/memory/<ownerChatId>/memory.md`;总长上限 3000 字(只算条目正文);单条 ≤ 200 字。
- 条目尾注格式 `<!-- m:<4+位小写hex> · YYYY-MM-DD -->`;承诺期限写在正文 `(期限 YYYY-MM-DD)`。
- 一晚删除超过 `max(2, floor(现有条目数×0.3))` 条 → 整批作废。
- 承诺期限过去 **7 天以上**归档;近况最后确认超过 **14 天**归档;超长先按最后确认日期淡出最旧的近况,仍超整批作废。
- 默认整理时间 `04:00`(companion 时区);通知最早 `09:00`,待发通知 24 小时过期。
- 通知只由程序拼装、直接 `ilink.sendMessage`,不走 AI 轮次,不放链接,最多列 3 条。
- care 新 kind `memory`:care=off 不发;连续 2 次未回暂停;20 小时一条。
- 手机页源码改完必须 `bun run build:mobile`;手机脚本行首不许是 `(` 或 `[`。
- daemon 不 import `apps/mobile`;新的 daemon 接线进 `pipeline-deps.ts` / `bootstrap/*`,不塞进 `index.ts`。
- 提交信息结尾:`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

**对 spec 的三处落地调整(执行者照此做):**
1. 配置放 companion config 的**扁平**字段 `memory_nightly_enabled` / `memory_nightly_at`(该文件全是扁平 snake_case),并登记进 `src/daemon/config-surface.ts`;不是 spec 写的 `memory.nightly.*`。
2. 归档的过期条目写到 `<stateDir>/memory-archive/<owner>/memory-expired.md`,**不放**在 `memory/<owner>/` 下 —— 那里的 `.md` 会被 recall / snapshot / 园丁读到。
3. 没有「每日聊天摘要」这种现成文本(turn_records 只有计数);素材改用 `messages-store.listSince` 的原始聊天(主人/CC 两方,纯文本,截断)。notes 全量读入(指纹没变就不调模型,效果等价于「只看变动」)。
4. (执行中终审裁定,2026-09-25)`POST /v1/memory/synthesize` **没有**改成跑本流程:桌面记忆面板的「整理记忆」按钮走它,且桌面项目地图解析 `_overview.md`(`apps/desktop/src/modules/memory.js:475`),切过去会断。所以微信「整理记忆」/ CLI `memory nightly --now` 跑每晚整理,桌面按钮仍重算 `_overview.md` —— 两个同名按钮做的事不同,留给主人定是否统一。另:素材最终改为 30k 字总预算按优先级填充(执行中实际用 `listRange` 取最新 400 条聊天,不是 `listSince`)。

## Review Focus

1. **主人整理期间在桌面改了 `memory.md`** → 这次结果必须作废、不覆盖主人的改动,且**不算失败**(15 分钟后自然重跑)。→ Task 5 测试 `owner edit during the model call wins`。
2. **模型返回合法 JSON 但引用不存在的编号 / 一口气删一大半** → 整批作废,文件一字不变,失败计数 +1,当天不再重试。→ Task 2 + Task 5 测试。
3. **电脑凌晨睡着、早上 8 点醒来** → 醒后第一次检查就补跑一次,但通知仍等到 09:00 之后;当天只跑一次。→ Task 4 `isDue` / `noticeTiming` 测试 + Task 6 `tick` 测试。
4. **CC 白天用 `memory_write` 整份覆盖 `memory.md`** → 被 daemon 拒绝并提示写 profile.md / notes/;主人经 CLI / 桌面写不受影响。→ Task 8 测试。
5. **主人手写了一条没有编号的条目、或加了一个不认识的栏** → 整理后不丢:无编号条目补上编号,未知内容原样保留。→ Task 1 往返测试 + Task 5 集成测试。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `src/daemon/memory/curated-doc.ts` | `memory.md` 解析 / 写回 / 渲染给提示词 / 补编号(纯) |
| `src/daemon/memory/nightly-ops.ts` | 解析模型 JSON、校验、执行改动、到期新陈代谢、超长处理(纯) |
| `src/daemon/memory/nightly-notify.ts` | 「值得说」判定、通知文案、`整理记忆` 回复文案(纯) |
| `src/daemon/memory/nightly-schedule.ts` | 时区里的日期/钟点、`isDue`、`noticeTiming`(纯) |
| `src/daemon/memory/nightly.ts` | 跑一次整理:素材、指纹、提示词、调模型、修订检查、写入、日志、状态 |
| `src/daemon/memory/nightly-sources.ts` | 从 SQLite / 本机 Claude 记忆取素材(薄适配) |
| `src/daemon/memory/nightly-runtime.ts` | `tick` / `runNow` / 送信 / 微信文本视图 / 手机视图 |
| `src/daemon/memory/nightly-lifecycle.ts` | 15 分钟定时器挂载 |
| `src/daemon/companion/config.ts`、`config-surface.ts` | 两个新配置 |
| `src/daemon/companion/calibration.ts`、`care-ledger.ts` | care kind `memory` |
| `src/core/prompt-builder.ts`、`src/daemon/main.ts`、`src/daemon/bootstrap/{index,types}.ts` | 提示词注入 `memory.md` |
| `src/daemon/internal-api/routes.ts` | 会话写 `memory.md` 的闸 |
| `src/daemon/admin-commands.ts` | 「查看记忆」「整理记忆」 |
| `src/daemon/internal-api/{routes-memory,route-tiers,types,index,lifecycle}.ts`、`src/lib/cli-llm-eval.ts`、`cli.ts` | 手动入口 |
| `src/daemon/settings-panel.ts`、`apps/mobile/src/{phone.html,home.js}` | 手机「CC 记得你」 |
| `src/daemon/wiring/pipeline-deps.ts`、`src/daemon/wiring/index.ts`、`src/daemon/memory-llm-ops.ts` | 组装运行时 |

---

### Task 1: `memory.md` 格式

**Files:**
- Create: `src/daemon/memory/curated-doc.ts`
- Test: `src/daemon/memory/curated-doc.test.ts`

**Interfaces:**
- Produces:
  - `SECTIONS: readonly ['关于你','偏好','承诺','身边的人','近况']`,`type Section`
  - `MEMORY_FILENAME = 'memory.md'`,`MEMORY_CAP_CHARS = 3000`
  - `interface MemoryEntry { id: string | null; text: string; seen: string | null }`
  - `interface MemoryDoc { sections: Record<Section, MemoryEntry[]>; extra: string[] }`
  - `emptyDoc(): MemoryDoc`、`parseMemoryDoc(md: string): MemoryDoc`、`serializeMemoryDoc(doc: MemoryDoc, stampIso: string): string`
  - `renderForPrompt(doc: MemoryDoc): string`、`docChars(doc: MemoryDoc): number`、`parseDue(text: string): string | null`
  - `assignMissingIds(doc: MemoryDoc, newId: () => string, today: string): MemoryDoc`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseMemoryDoc, serializeMemoryDoc, renderForPrompt, docChars, parseDue, assignMissingIds, emptyDoc } from './curated-doc'

const SAMPLE = [
  '<!-- wechat-cc 记忆 · 每晚整理 · 最近整理 2026-09-24T04:00:00.000Z · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->',
  '',
  '## 关于你',
  '- 全栈开发兼产品 <!-- m:7f3a · 2026-08-24 -->',
  '## 偏好',
  '- 回复直接,别客套 <!-- m:91c2 · 2026-09-10 -->',
  '- 主人手写的一条',
  '## 承诺',
  '- 周五前给 X 回话(期限 2026-09-27) <!-- m:b01e · 2026-09-24 -->',
  '## 随手记',
  '一段主人自己加的话',
].join('\n')

describe('curated memory doc', () => {
  it('parses entries, ids, seen dates; keeps unknown sections as extra', () => {
    const d = parseMemoryDoc(SAMPLE)
    expect(d.sections['关于你']).toEqual([{ id: '7f3a', text: '全栈开发兼产品', seen: '2026-08-24' }])
    expect(d.sections['偏好'][1]).toEqual({ id: null, text: '主人手写的一条', seen: null })
    expect(d.extra).toEqual(['## 随手记', '一段主人自己加的话'])
  })
  it('round-trips byte-stably after one serialize', () => {
    const once = serializeMemoryDoc(parseMemoryDoc(SAMPLE), '2026-09-25T04:00:00.000Z')
    expect(serializeMemoryDoc(parseMemoryDoc(once), '2026-09-25T04:00:00.000Z')).toBe(once)
    expect(once).toContain('- 主人手写的一条\n')
    expect(once).toContain('## 随手记\n一段主人自己加的话')
  })
  it('renders for the prompt without comments or empty sections', () => {
    const r = renderForPrompt(parseMemoryDoc(SAMPLE))
    expect(r).not.toContain('<!--')
    expect(r).toContain('### 承诺\n- 周五前给 X 回话(期限 2026-09-27)')
    expect(r).not.toContain('### 近况')
  })
  it('counts only entry text; parses due dates', () => {
    const d = emptyDoc(); d.sections['近况'].push({ id: 'aaaa', text: '12345', seen: '2026-09-01' })
    expect(docChars(d)).toBe(5)
    expect(parseDue('周五前给 X 回话(期限 2026-09-27)')).toBe('2026-09-27')
    expect(parseDue('没有期限')).toBeNull()
  })
  it('assigns ids (and today as seen) only to entries without one', () => {
    let n = 0
    const d = assignMissingIds(parseMemoryDoc(SAMPLE), () => `n${n++}ab`, '2026-09-25')
    expect(d.sections['偏好'][1]).toEqual({ id: 'n0ab', text: '主人手写的一条', seen: '2026-09-25' })
    expect(d.sections['关于你'][0]!.id).toBe('7f3a')
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/curated-doc.test.ts`
Expected: FAIL,`Cannot find module './curated-doc'`

- [ ] **Step 3: 实现**

```ts
/**
 * memory.md —— 主人的长期记忆(每晚整理,每次对话都读)。人能直接读和改的 Markdown:
 * 五栏各一个列表,每条尾注挂编号与最后确认日期。编号只给整理用;没编号的条目照常读入,整理时补上。
 * 栏外 / 不认识的栏的内容进 extra,写回时原样放在末尾 —— 主人手写的东西不丢。
 */
export const SECTIONS = ['关于你', '偏好', '承诺', '身边的人', '近况'] as const
export type Section = (typeof SECTIONS)[number]
export const MEMORY_FILENAME = 'memory.md'
export const MEMORY_CAP_CHARS = 3000

export interface MemoryEntry { id: string | null; text: string; seen: string | null }
export interface MemoryDoc { sections: Record<Section, MemoryEntry[]>; extra: string[] }

const HEADER_PREFIX = '<!-- wechat-cc 记忆'
const ENTRY_RE = /^-\s+(.*?)\s*(?:<!--\s*m:([0-9a-f]{4,})\s*·\s*(\d{4}-\d{2}-\d{2})\s*-->)?\s*$/
const DUE_RE = /(期限 (\d{4}-\d{2}-\d{2}))/

export function emptyDoc(): MemoryDoc {
  return { sections: { 关于你: [], 偏好: [], 承诺: [], 身边的人: [], 近况: [] }, extra: [] }
}

function isSection(s: string): s is Section {
  return (SECTIONS as readonly string[]).includes(s)
}

export function parseMemoryDoc(md: string): MemoryDoc {
  const doc = emptyDoc()
  let cur: Section | null = null
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith(HEADER_PREFIX)) continue
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      if (isSection(h[1]!)) { cur = h[1]; continue }
      cur = null
      doc.extra.push(line)
      continue
    }
    const e = cur ? ENTRY_RE.exec(line) : null
    if (cur && e && e[1]) {
      doc.sections[cur].push({ id: e[2] ?? null, text: e[1], seen: e[3] ?? null })
      continue
    }
    if (line.trim()) doc.extra.push(line)
  }
  return doc
}

export function serializeMemoryDoc(doc: MemoryDoc, stampIso: string): string {
  const out = [`${HEADER_PREFIX} · 每晚整理 · 最近整理 ${stampIso} · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->`]
  for (const s of SECTIONS) {
    out.push('', `## ${s}`)
    for (const e of doc.sections[s]) out.push(e.id && e.seen ? `- ${e.text} <!-- m:${e.id} · ${e.seen} -->` : `- ${e.text}`)
  }
  if (doc.extra.length) out.push('', ...doc.extra)
  return out.join('\n') + '\n'
}

export function renderForPrompt(doc: MemoryDoc): string {
  const parts: string[] = []
  for (const s of SECTIONS) {
    if (!doc.sections[s].length) continue
    parts.push(`### ${s}`, ...doc.sections[s].map(e => `- ${e.text}`))
  }
  if (doc.extra.length) parts.push('### 其它', ...doc.extra)
  return parts.join('\n')
}

export function docChars(doc: MemoryDoc): number {
  let n = 0
  for (const s of SECTIONS) for (const e of doc.sections[s]) n += e.text.length
  return n
}

export function parseDue(text: string): string | null {
  return DUE_RE.exec(text)?.[2] ?? null
}

export function assignMissingIds(doc: MemoryDoc, newId: () => string, today: string): MemoryDoc {
  const next = structuredClone(doc)
  for (const s of SECTIONS) for (const e of next.sections[s]) if (!e.id) { e.id = newId(); e.seen = today }
  return next
}
```

- [ ] **Step 4: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory/curated-doc.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/curated-doc.test.ts`
Expected: 5 passed ×2

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/curated-doc.ts src/daemon/memory/curated-doc.test.ts
git commit -m "记忆 memory.md 格式:五栏 + 隐藏编号,解析写回不丢手写内容

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 改动清单的校验与执行

**Files:**
- Create: `src/daemon/memory/nightly-ops.ts`
- Test: `src/daemon/memory/nightly-ops.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出
- Produces:
  - `interface NightlyOps { add: Array<{ section: Section; text: string }>; update: Array<{ id: string; text: string; reversal: boolean }>; confirm: string[]; remove: Array<{ id: string; reason: string }> }`
  - `type ExpireReason = 'commitment_past_due' | 'recent_stale' | 'over_cap'`
  - `type AppliedOp = { kind: 'add'; id: string; section: Section; text: string } | { kind: 'update'; id: string; section: Section; text: string; before: string; reversal: boolean } | { kind: 'remove'; id: string; section: Section; text: string; reason: string } | { kind: 'expire'; id: string; section: Section; text: string; reason: ExpireReason }`
  - `parseOps(raw: string): NightlyOps | null`
  - `applyNightly(doc: MemoryDoc, ops: NightlyOps, o: { today: string; newId: () => string }): { ok: true; doc: MemoryDoc; applied: AppliedOp[] } | { ok: false; reason: string }`
  - `daysBetween(fromDay: string, toDay: string): number`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseOps, applyNightly, daysBetween, type NightlyOps } from './nightly-ops'
import { emptyDoc, type MemoryDoc } from './curated-doc'

function doc(): MemoryDoc {
  const d = emptyDoc()
  d.sections['关于你'] = [{ id: 'a001', text: '做 wechat-cc', seen: '2026-09-01' }]
  d.sections['偏好'] = [{ id: 'b001', text: '先打磨再上线', seen: '2026-09-01' }, { id: 'b002', text: '回复直接', seen: '2026-09-01' }]
  d.sections['承诺'] = [{ id: 'c001', text: '给 X 回话(期限 2026-09-10)', seen: '2026-09-05' }]
  d.sections['近况'] = [{ id: 'd001', text: '在赶发版', seen: '2026-09-05' }, { id: 'd002', text: '最近睡得晚', seen: '2026-09-24' }]
  return d
}
const none: NightlyOps = { add: [], update: [], confirm: [], remove: [] }
let n = 0
const opts = { today: '2026-09-25', newId: () => `e${String(n++).padStart(3, '0')}` }

describe('parseOps', () => {
  it('accepts a fenced JSON object with all four keys', () => {
    expect(parseOps('```json\n{"add":[{"section":"承诺","text":"周五回话"}],"update":[],"confirm":["a001"],"remove":[]}\n```'))
      .toEqual({ add: [{ section: '承诺', text: '周五回话' }], update: [], confirm: ['a001'], remove: [] })
  })
  it('rejects missing keys, unknown sections and non-JSON', () => {
    expect(parseOps('{"add":[],"update":[],"confirm":[]}')).toBeNull()
    expect(parseOps('{"add":[{"section":"杂项","text":"x"}],"update":[],"confirm":[],"remove":[]}')).toBeNull()
    expect(parseOps('我觉得没什么要改的')).toBeNull()
  })
})

describe('applyNightly', () => {
  it('applies confirm/update/remove/add and records what happened', () => {
    const r = applyNightly(doc(), {
      add: [{ section: '承诺', text: '周五前给 Y 回话(期限 2026-09-26)' }],
      update: [{ id: 'b001', text: '先上线再优化', reversal: true }],
      confirm: ['a001'],
      remove: [{ id: 'b002', reason: '主人说不对' }],
    }, opts)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.sections['偏好']).toEqual([{ id: 'b001', text: '先上线再优化', seen: '2026-09-25' }])
    expect(r.doc.sections['关于你'][0]!.seen).toBe('2026-09-25')
    expect(r.applied.map(a => a.kind)).toEqual(['update', 'remove', 'add', 'expire', 'expire'])
    expect(r.applied[0]).toMatchObject({ kind: 'update', before: '先打磨再上线', reversal: true, section: '偏好' })
  })
  it('expires commitments >7 days past due and 近况 unconfirmed >14 days', () => {
    const r = applyNightly(doc(), none, opts)
    expect(r.ok && r.applied).toEqual([
      { kind: 'expire', id: 'c001', section: '承诺', text: '给 X 回话(期限 2026-09-10)', reason: 'commitment_past_due' },
      { kind: 'expire', id: 'd001', section: '近况', text: '在赶发版', reason: 'recent_stale' },
    ])
  })
  it('rejects unknown ids, over-long text and mass removal without touching the input', () => {
    const d = doc()
    expect(applyNightly(d, { ...none, confirm: ['zzzz'] }, opts)).toEqual({ ok: false, reason: 'unknown_id:zzzz' })
    expect(applyNightly(d, { ...none, add: [{ section: '偏好', text: 'x'.repeat(201) }] }, opts)).toEqual({ ok: false, reason: 'bad_text' })
    expect(applyNightly(d, { ...none, remove: ['a001', 'b001', 'b002'].map(id => ({ id, reason: 'x' })) }, opts))
      .toEqual({ ok: false, reason: 'too_many_removals' })
    expect(d.sections['偏好'][0]!.text).toBe('先打磨再上线')
  })
  it('fades the oldest 近况 to fit the cap, then gives up', () => {
    const d = emptyDoc()
    d.sections['近况'] = [{ id: 'r001', text: 'x'.repeat(200), seen: '2026-09-20' }, { id: 'r002', text: 'y'.repeat(200), seen: '2026-09-24' }]
    for (let i = 0; i < 14; i++) d.sections['关于你'].push({ id: `f${String(i).padStart(3, '0')}`, text: 'z'.repeat(190), seen: '2026-09-24' })
    const r = applyNightly(d, none, opts)   // 14×190 + 400 = 3060 > 3000
    expect(r.ok && r.applied).toEqual([{ kind: 'expire', id: 'r001', section: '近况', text: 'x'.repeat(200), reason: 'over_cap' }])
    // 再加 400 字:两条近况全淡出后仍是 14×190 + 400 = 3060 > 3000
    d.sections['关于你'].push({ id: 'f998', text: 'v'.repeat(200), seen: '2026-09-24' }, { id: 'f999', text: 'w'.repeat(200), seen: '2026-09-24' })
    expect(applyNightly(d, none, opts)).toEqual({ ok: false, reason: 'over_cap' })
  })
  it('counts days between local dates', () => {
    expect(daysBetween('2026-09-10', '2026-09-25')).toBe(15)
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly-ops.test.ts`
Expected: FAIL,`Cannot find module './nightly-ops'`

- [ ] **Step 3: 实现**

```ts
/**
 * 每晚整理的改动清单:模型只报「新增 / 修改 / 仍成立 / 删除」,这里逐条校验后执行,
 * 再做程序自己的新陈代谢(承诺过期、近况淡出、超长)。任何一条不合法 → 整批作废,不做半截。
 */
import { SECTIONS, MEMORY_CAP_CHARS, docChars, parseDue, type MemoryDoc, type MemoryEntry, type Section } from './curated-doc'

export interface NightlyOps {
  add: Array<{ section: Section; text: string }>
  update: Array<{ id: string; text: string; reversal: boolean }>
  confirm: string[]
  remove: Array<{ id: string; reason: string }>
}
export type ExpireReason = 'commitment_past_due' | 'recent_stale' | 'over_cap'
export type AppliedOp =
  | { kind: 'add'; id: string; section: Section; text: string }
  | { kind: 'update'; id: string; section: Section; text: string; before: string; reversal: boolean }
  | { kind: 'remove'; id: string; section: Section; text: string; reason: string }
  | { kind: 'expire'; id: string; section: Section; text: string; reason: ExpireReason }

export const MAX_ENTRY_CHARS = 200
const COMMITMENT_GRACE_DAYS = 7
const RECENT_STALE_DAYS = 14

const isStr = (v: unknown): v is string => typeof v === 'string'
const isSection = (v: unknown): v is Section => isStr(v) && (SECTIONS as readonly string[]).includes(v)

export function parseOps(raw: string): NightlyOps | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let j: unknown
  try { j = JSON.parse(m[0]) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (!Array.isArray(o.add) || !Array.isArray(o.update) || !Array.isArray(o.confirm) || !Array.isArray(o.remove)) return null
  const add: NightlyOps['add'] = []
  for (const a of o.add as unknown[]) {
    const x = a as Record<string, unknown>
    if (!x || !isSection(x.section) || !isStr(x.text)) return null
    add.push({ section: x.section, text: x.text.trim() })
  }
  const update: NightlyOps['update'] = []
  for (const u of o.update as unknown[]) {
    const x = u as Record<string, unknown>
    if (!x || !isStr(x.id) || !isStr(x.text)) return null
    update.push({ id: x.id, text: x.text.trim(), reversal: x.reversal === true })
  }
  if (!(o.confirm as unknown[]).every(isStr)) return null
  const remove: NightlyOps['remove'] = []
  for (const r of o.remove as unknown[]) {
    const x = r as Record<string, unknown>
    if (!x || !isStr(x.id)) return null
    remove.push({ id: x.id, reason: isStr(x.reason) ? x.reason : '' })
  }
  return { add, update, confirm: o.confirm as string[], remove }
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000)
}

export function applyNightly(
  input: MemoryDoc,
  ops: NightlyOps,
  o: { today: string; newId: () => string },
): { ok: true; doc: MemoryDoc; applied: AppliedOp[] } | { ok: false; reason: string } {
  const doc = structuredClone(input)
  const index = new Map<string, { section: Section; entry: MemoryEntry }>()
  for (const s of SECTIONS) for (const e of doc.sections[s]) if (e.id) index.set(e.id, { section: s, entry: e })
  for (const id of [...ops.confirm, ...ops.update.map(u => u.id), ...ops.remove.map(r => r.id)]) {
    if (!index.has(id)) return { ok: false, reason: `unknown_id:${id}` }
  }
  for (const t of [...ops.add.map(a => a.text), ...ops.update.map(u => u.text)]) {
    if (!t || t.length > MAX_ENTRY_CHARS) return { ok: false, reason: 'bad_text' }
  }
  if (ops.remove.length > Math.max(2, Math.floor(index.size * 0.3))) return { ok: false, reason: 'too_many_removals' }

  const applied: AppliedOp[] = []
  for (const id of ops.confirm) index.get(id)!.entry.seen = o.today
  for (const u of ops.update) {
    const hit = index.get(u.id)!
    applied.push({ kind: 'update', id: u.id, section: hit.section, text: u.text, before: hit.entry.text, reversal: u.reversal })
    hit.entry.text = u.text
    hit.entry.seen = o.today
  }
  for (const r of ops.remove) {
    const hit = index.get(r.id)!
    doc.sections[hit.section] = doc.sections[hit.section].filter(e => e !== hit.entry)
    applied.push({ kind: 'remove', id: r.id, section: hit.section, text: hit.entry.text, reason: r.reason })
  }
  for (const a of ops.add) {
    const id = o.newId()
    doc.sections[a.section].push({ id, text: a.text, seen: o.today })
    applied.push({ kind: 'add', id, section: a.section, text: a.text })
  }

  const expire = (s: Section, e: MemoryEntry, reason: ExpireReason) => {
    doc.sections[s] = doc.sections[s].filter(x => x !== e)
    applied.push({ kind: 'expire', id: e.id ?? '', section: s, text: e.text, reason })
  }
  for (const e of [...doc.sections['承诺']]) {
    const due = parseDue(e.text)
    if (due && daysBetween(due, o.today) > COMMITMENT_GRACE_DAYS) expire('承诺', e, 'commitment_past_due')
  }
  for (const e of [...doc.sections['近况']]) {
    if (e.seen && daysBetween(e.seen, o.today) > RECENT_STALE_DAYS) expire('近况', e, 'recent_stale')
  }
  while (docChars(doc) > MEMORY_CAP_CHARS && doc.sections['近况'].length) {
    const oldest = [...doc.sections['近况']].sort((a, b) => (a.seen ?? '').localeCompare(b.seen ?? ''))[0]!
    expire('近况', oldest, 'over_cap')
  }
  if (docChars(doc) > MEMORY_CAP_CHARS) return { ok: false, reason: 'over_cap' }
  return { ok: true, doc, applied }
}
```

- [ ] **Step 4: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory/nightly-ops.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/nightly-ops.test.ts`
Expected: 7 passed ×2

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/nightly-ops.ts src/daemon/memory/nightly-ops.test.ts
git commit -m "每晚整理的改动清单:逐条校验、整批作废、到期与超长新陈代谢

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 值得说什么、怎么说

**Files:**
- Create: `src/daemon/memory/nightly-notify.ts`
- Test: `src/daemon/memory/nightly-notify.test.ts`

**Interfaces:**
- Consumes: Task 2 `AppliedOp`
- Produces:
  - `interface NoticeItem { label: '新记下' | '改了' | '删了'; text: string; before?: string; reason?: string }`
  - `noticeItems(applied: readonly AppliedOp[]): NoticeItem[]`
  - `FIRST_RUN_NOTICE: string`
  - `composeNotice(items: readonly NoticeItem[], firstRun: boolean): string | null`
  - `formatNightlyReply(r: NightlyRunResult): string`(`NightlyRunResult` 类型在本文件定义并导出,Task 5 用):
    `type NightlyRunResult = { status: 'written'; applied: AppliedOp[]; notice: string | null } | { status: 'skipped'; reason: 'disabled' | 'no_owner' | 'not_due' | 'failed_today' | 'owner_busy' | 'no_new_material' | 'owner_edited' } | { status: 'failed'; reason: string }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { noticeItems, composeNotice, formatNightlyReply, FIRST_RUN_NOTICE } from './nightly-notify'
import type { AppliedOp } from './nightly-ops'

const applied: AppliedOp[] = [
  { kind: 'add', id: 'e1', section: '承诺', text: '周五前给 X 回话' },
  { kind: 'add', id: 'e2', section: '关于你', text: '养了只猫' },
  { kind: 'update', id: 'b1', section: '偏好', text: '先上线再优化', before: '先打磨再上线', reversal: true },
  { kind: 'update', id: 'b2', section: '偏好', text: '回复直接一点', before: '回复直接', reversal: false },
  { kind: 'remove', id: 'd1', section: '近况', text: '在准备搬家', reason: '之后没再提' },
  { kind: 'expire', id: 'c1', section: '承诺', text: '旧承诺', reason: 'commitment_past_due' },
]

describe('nightly notice', () => {
  it('only new commitments, reversals of 偏好/关于你, and model removals are worth telling', () => {
    expect(noticeItems(applied)).toEqual([
      { label: '新记下', text: '周五前给 X 回话' },
      { label: '改了', text: '先上线再优化', before: '先打磨再上线' },
      { label: '删了', text: '在准备搬家', reason: '之后没再提' },
    ])
  })
  it('composes at most three lines and points to 查看记忆 for the rest', () => {
    const items = [...noticeItems(applied), { label: '新记下' as const, text: '第四条' }]
    const t = composeNotice(items, false)!
    expect(t).toBe([
      '昨晚整理记忆,有几件想跟你对一下:',
      '· 新记下:周五前给 X 回话',
      '· 改了:先上线再优化(原来是:先打磨再上线)',
      '· 删了:在准备搬家(之后没再提)',
      '还有 1 条,发「查看记忆」看全部。',
      '不对的话直接跟我说。',
    ].join('\n'))
    expect(t).not.toMatch(/https?:\/\//)
  })
  it('says nothing when nothing notable changed; introduces itself on the first run', () => {
    expect(composeNotice([], false)).toBeNull()
    expect(composeNotice([], true)).toBe(FIRST_RUN_NOTICE)
  })
  it('formats the 整理记忆 reply for every outcome', () => {
    expect(formatNightlyReply({ status: 'written', applied, notice: '通知正文' })).toBe('通知正文')
    expect(formatNightlyReply({ status: 'written', applied: [], notice: null })).toBe('整理好了,没有需要特别跟你说的变化。发「查看记忆」看全部。')
    expect(formatNightlyReply({ status: 'skipped', reason: 'no_new_material' })).toBe('没有新东西要整理,记忆保持原样。')
    expect(formatNightlyReply({ status: 'failed', reason: 'bad_json' })).toBe('这次没整理成(bad_json),记忆保持原样。')
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly-notify.test.ts`
Expected: FAIL,`Cannot find module './nightly-notify'`

- [ ] **Step 3: 实现**

```ts
/** 整理完什么值得告诉主人、怎么说。纯函数:规则由程序定,不看模型心情。 */
import type { AppliedOp } from './nightly-ops'

export type NightlyRunResult =
  | { status: 'written'; applied: AppliedOp[]; notice: string | null }
  | { status: 'skipped'; reason: 'disabled' | 'no_owner' | 'not_due' | 'failed_today' | 'owner_busy' | 'no_new_material' | 'owner_edited' }
  | { status: 'failed'; reason: string }

export interface NoticeItem { label: '新记下' | '改了' | '删了'; text: string; before?: string; reason?: string }

export const FIRST_RUN_NOTICE = '我把对你的理解整理成了一份记忆,以后每晚更新。发「查看记忆」就能看,不对的地方直接跟我说。'

export function noticeItems(applied: readonly AppliedOp[]): NoticeItem[] {
  const out: NoticeItem[] = []
  for (const op of applied) {
    if (op.kind === 'add' && op.section === '承诺') out.push({ label: '新记下', text: op.text })
    else if (op.kind === 'update' && op.reversal && (op.section === '偏好' || op.section === '关于你')) out.push({ label: '改了', text: op.text, before: op.before })
    else if (op.kind === 'remove') out.push({ label: '删了', text: op.text, reason: op.reason })
  }
  return out
}

function line(i: NoticeItem): string {
  if (i.label === '改了') return `· 改了:${i.text}(原来是:${i.before ?? ''})`
  if (i.label === '删了') return `· 删了:${i.text}${i.reason ? `(${i.reason})` : ''}`
  return `· 新记下:${i.text}`
}

export function composeNotice(items: readonly NoticeItem[], firstRun: boolean): string | null {
  if (firstRun) return FIRST_RUN_NOTICE
  if (!items.length) return null
  const out = ['昨晚整理记忆,有几件想跟你对一下:', ...items.slice(0, 3).map(line)]
  if (items.length > 3) out.push(`还有 ${items.length - 3} 条,发「查看记忆」看全部。`)
  out.push('不对的话直接跟我说。')
  return out.join('\n')
}

export function formatNightlyReply(r: NightlyRunResult): string {
  if (r.status === 'written') return r.notice ?? '整理好了,没有需要特别跟你说的变化。发「查看记忆」看全部。'
  if (r.status === 'failed') return `这次没整理成(${r.reason}),记忆保持原样。`
  if (r.reason === 'no_new_material') return '没有新东西要整理,记忆保持原样。'
  if (r.reason === 'owner_edited') return '你刚好在改记忆,我先不动,稍后再整理。'
  if (r.reason === 'no_owner') return '还没认出主人,没法整理。'
  return `这次没有整理(${r.reason})。`
}
```

- [ ] **Step 4: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory/nightly-notify.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/nightly-notify.test.ts`
Expected: 4 passed ×2

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/nightly-notify.ts src/daemon/memory/nightly-notify.test.ts
git commit -m "每晚整理:值得说的变化与通知文案(最多三条、不放链接)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 时区里的「该不该跑 / 该不该发」

**Files:**
- Create: `src/daemon/memory/nightly-schedule.ts`
- Test: `src/daemon/memory/nightly-schedule.test.ts`

**Interfaces:**
- Produces:
  - `localParts(ms: number, tz: string): { day: string; hhmm: string }`(坏时区回退 UTC)
  - `isDue(o: { nowMs: number; tz: string; at: string; lastRunDay: string | null }): boolean`
  - `NOTICE_EARLIEST = '09:00'`、`NOTICE_TTL_MS = 86_400_000`
  - `noticeTiming(o: { nowMs: number; tz: string; createdAtMs: number }): 'send' | 'wait' | 'expire'`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { localParts, isDue, noticeTiming } from './nightly-schedule'

const SH = 'Asia/Shanghai'
const at = (iso: string) => Date.parse(iso)

describe('nightly schedule', () => {
  it('reads the local day and clock in the owner timezone, falling back to UTC', () => {
    expect(localParts(at('2026-09-24T20:30:00Z'), SH)).toEqual({ day: '2026-09-25', hhmm: '04:30' })
    expect(localParts(at('2026-09-24T20:30:00Z'), 'Not/AZone')).toEqual({ day: '2026-09-24', hhmm: '20:30' })
  })
  it('is due once per local day after the configured time — including catch-up after sleeping through it', () => {
    expect(isDue({ nowMs: at('2026-09-24T19:59:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(false)   // 03:59
    expect(isDue({ nowMs: at('2026-09-24T20:00:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(true)    // 04:00
    expect(isDue({ nowMs: at('2026-09-25T00:10:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(true)    // 08:10 woke up
    expect(isDue({ nowMs: at('2026-09-25T00:10:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-25' })).toBe(false)   // already ran
    expect(isDue({ nowMs: at('2026-09-24T16:30:00Z'), tz: SH, at: '04:00', lastRunDay: '2026-09-24' })).toBe(false)   // 00:30 new day, too early
  })
  it('holds notices until 09:00 local and drops them after 24h', () => {
    const created = at('2026-09-24T20:00:00Z')   // 04:00
    expect(noticeTiming({ nowMs: at('2026-09-25T00:59:00Z'), tz: SH, createdAtMs: created })).toBe('wait')    // 08:59
    expect(noticeTiming({ nowMs: at('2026-09-25T01:00:00Z'), tz: SH, createdAtMs: created })).toBe('send')    // 09:00
    expect(noticeTiming({ nowMs: at('2026-09-25T20:00:01Z'), tz: SH, createdAtMs: created })).toBe('expire')
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly-schedule.test.ts`
Expected: FAIL,`Cannot find module './nightly-schedule'`

- [ ] **Step 3: 实现**

```ts
/** 每晚整理的时间判断,全部按主人的 IANA 时区(companion config.timezone)。纯函数,时钟由调用方传。 */
export const NOTICE_EARLIEST = '09:00'
export const NOTICE_TTL_MS = 24 * 3_600_000

function formatter(tz: string): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }) } catch { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }) }
}

export function localParts(ms: number, tz: string): { day: string; hhmm: string } {
  const p: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` }
}

export function isDue(o: { nowMs: number; tz: string; at: string; lastRunDay: string | null }): boolean {
  const { day, hhmm } = localParts(o.nowMs, o.tz)
  return hhmm >= o.at && o.lastRunDay !== day
}

export function noticeTiming(o: { nowMs: number; tz: string; createdAtMs: number }): 'send' | 'wait' | 'expire' {
  if (o.nowMs - o.createdAtMs > NOTICE_TTL_MS) return 'expire'
  return localParts(o.nowMs, o.tz).hhmm >= NOTICE_EARLIEST ? 'send' : 'wait'
}
```

- [ ] **Step 4: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory/nightly-schedule.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/nightly-schedule.test.ts`
Expected: 3 passed ×2

- [ ] **Step 5: 提交**

```bash
git add src/daemon/memory/nightly-schedule.ts src/daemon/memory/nightly-schedule.test.ts
git commit -m "每晚整理的时间判断:按主人时区、睡过头醒来补跑、通知等到 9 点

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 跑一次整理

**Files:**
- Create: `src/daemon/memory/nightly.ts`
- Test: `src/daemon/memory/nightly.test.ts`
- Modify: `src/daemon/memory/gardener.ts`(排除 `memory.md`)

**Interfaces:**
- Consumes: Task 1–4 全部导出
- Produces:
  - `interface NightlySources { observationsSince(sinceIso: string | null): Promise<string[]>; milestonesSince(sinceIso: string | null): Promise<string[]>; messagesSince(sinceIso: string | null): Promise<string[]>; projectMemory(): string }`
  - `interface NightlyConfig { enabled: boolean; at: string; timezone: string }`
  - `interface NightlyState { lastRunDay: string | null; lastRunIso: string | null; fingerprint: string | null; failures: number; lastFailDay: string | null; firstRunDone: boolean; pendingNotice: { text: string; createdAtMs: number } | null }`
  - `readNightlyState(stateDir: string): NightlyState`、`writeNightlyState(stateDir: string, s: NightlyState): void`(文件 `<stateDir>/companion/memory-nightly.json`)
  - `interface NightlyRunDeps { stateDir: string; ownerChatId: () => string | null; config: () => NightlyConfig; sources: NightlySources; cheapEval: () => ((p: string) => Promise<string>) | null; ownerRecentlyActive: () => Promise<boolean>; now: () => number; newId: () => string; log: (tag: string, line: string) => void }`
  - `ownerMemoryRoot(stateDir: string, owner: string): string | null`(chatId 含 `..`、`/`、`\` → null)
  - `gatherMaterial(root: string, sources: NightlySources, sinceIso: string | null, firstRun: boolean): Promise<string>`
  - `buildNightlyPrompt(a: { today: string; current: string; material: string }): string`
  - `runMemoryNightly(deps: NightlyRunDeps, opts: { force: boolean }): Promise<NightlyRunResult>`
  - `MEMORY_LOG_FILE = 'memory-log.jsonl'`(在 `memory/<owner>/`,每行 `{ at: string; ops: AppliedOp[] }`)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryNightly, readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'
import { parseMemoryDoc } from './curated-doc'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, calls: string[], reply: string, now: number
let n = 0

function deps(over: Partial<NightlyRunDeps> = {}): NightlyRunDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: {
      observationsSince: async () => ['- 2026-09-24 主人最近在赶发版'],
      milestonesSince: async () => [],
      messagesSince: async () => ['主人:周五前我得给 X 回话'],
      projectMemory: () => '',
    },
    cheapEval: () => async (p: string) => { calls.push(p); return reply },
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => `id${String(n++).padStart(2, '0')}`,
    log: () => {},
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '主人叫大人,做 wechat-cc\n')
  calls = []
  now = Date.parse('2026-09-25T04:05:00Z')
  reply = JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }, { section: '关于你', text: '做 wechat-cc' }], update: [], confirm: [], remove: [] })
})

describe('runMemoryNightly', () => {
  it('first run: writes memory.md, logs ops, sets the first-run notice, records state', async () => {
    const r = await runMemoryNightly(deps(), { force: false })
    expect(r.status).toBe('written')
    const doc = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8'))
    expect(doc.sections['承诺'][0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', seen: '2026-09-25' })
    expect(calls[0]).toContain('主人叫大人')
    expect(calls[0]).toContain('周五前我得给 X 回话')
    const log = readFileSync(join(root, 'memory-log.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(log[0]!).ops).toHaveLength(2)
    const st = readNightlyState(stateDir)
    expect(st).toMatchObject({ lastRunDay: '2026-09-25', failures: 0, firstRunDone: true })
    expect(st.pendingNotice?.text).toContain('整理成了一份记忆')
  })
  it('does not run before the configured time or twice a day, and skips when the owner is mid-conversation', async () => {
    now = Date.parse('2026-09-25T03:59:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'not_due' })
    now = Date.parse('2026-09-25T04:05:00Z')
    expect(await runMemoryNightly(deps({ ownerRecentlyActive: async () => true }), { force: false })).toEqual({ status: 'skipped', reason: 'owner_busy' })
    await runMemoryNightly(deps(), { force: false })
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'not_due' })
    expect(calls).toHaveLength(1)
  })
  it('skips the model when nothing new came in since last night', async () => {
    await runMemoryNightly(deps(), { force: true })
    expect(await runMemoryNightly(deps(), { force: true })).toEqual({ status: 'skipped', reason: 'no_new_material' })
    expect(calls).toHaveLength(1)
  })
  it('a rejected batch leaves the file untouched, counts a failure and stops for today', async () => {
    await runMemoryNightly(deps(), { force: true })
    const before = readFileSync(join(root, 'memory.md'), 'utf8')
    writeFileSync(join(root, 'profile.md'), '新的一天有新草稿\n')
    reply = JSON.stringify({ add: [], update: [], confirm: ['nope'], remove: [] })
    now = Date.parse('2026-09-26T04:05:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'failed', reason: 'unknown_id:nope' })
    expect(readFileSync(join(root, 'memory.md'), 'utf8')).toBe(before)
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 1, lastFailDay: '2026-09-26' })
    now = Date.parse('2026-09-26T04:20:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'failed_today' })
  })
  it('owner edit during the model call wins — result dropped, not counted as a failure', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(join(root, 'profile.md'), '又一份草稿\n')
    const edited = readFileSync(join(root, 'memory.md'), 'utf8') + '\n## 随手记\n主人自己写的\n'
    const d = deps({ cheapEval: () => async () => { writeFileSync(join(root, 'memory.md'), edited); return JSON.stringify({ add: [], update: [], confirm: [], remove: [] }) } })
    expect(await runMemoryNightly(d, { force: true })).toEqual({ status: 'skipped', reason: 'owner_edited' })
    expect(readFileSync(join(root, 'memory.md'), 'utf8')).toBe(edited)
    expect(readNightlyState(stateDir).failures).toBe(0)
  })
  it('keeps the owner hand-written entry (assigning it an id) and archives the previous version', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(join(root, 'memory.md'), readFileSync(join(root, 'memory.md'), 'utf8').replace('## 偏好\n', '## 偏好\n- 主人手写:别用表情\n'))
    writeFileSync(join(root, 'profile.md'), '第二天草稿\n')
    reply = JSON.stringify({ add: [], update: [], confirm: [], remove: [] })
    now = Date.parse('2026-09-26T04:05:00Z')
    expect((await runMemoryNightly(deps(), { force: false })).status).toBe('written')
    const doc = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8'))
    expect(doc.sections['偏好'][0]).toMatchObject({ text: '主人手写:别用表情', seen: '2026-09-26' })
    expect(doc.sections['偏好'][0]!.id).toMatch(/^id\d\d$/)
    expect(existsSync(join(stateDir, 'memory-archive', OWNER, 'memory.md.2026-09-26.md'))).toBe(true)
  })
  it('forced runs return the notice instead of queueing it', async () => {
    const r = await runMemoryNightly(deps(), { force: true })
    expect(r.status === 'written' && r.notice).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('refuses owner ids that would escape the memory dir', async () => {
    expect(await runMemoryNightly(deps({ ownerChatId: () => '../x' }), { force: true })).toEqual({ status: 'skipped', reason: 'no_owner' })
  })
  it('state round-trips and defaults when missing', () => {
    expect(readNightlyState(stateDir)).toEqual({ lastRunDay: null, lastRunIso: null, fingerprint: null, failures: 0, lastFailDay: null, firstRunDone: false, pendingNotice: null })
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 2 })
    expect(readNightlyState(stateDir).failures).toBe(2)
  })
})
```

- [ ] **Step 2: 跑,确认红**

Run: `bun --bun vitest run src/daemon/memory/nightly.test.ts`
Expected: FAIL,`Cannot find module './nightly'`

- [ ] **Step 3: 实现**

```ts
/**
 * 跑一次每晚记忆整理(spec 2026-09-25-memory-nightly-design §2)。
 * 素材 → 指纹(没新东西不调模型)→ 便宜模型出改动清单 → 程序校验执行 → 修订检查(主人正在改就作废)
 * → 备份旧版、原子写、追加日志、更新状态。任何失败都不写文件;同一天不再自动重试。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MEMORY_FILENAME, assignMissingIds, parseMemoryDoc, serializeMemoryDoc } from './curated-doc'
import { applyNightly, parseOps } from './nightly-ops'
import { composeNotice, noticeItems, type NightlyRunResult } from './nightly-notify'
import { isDue, localParts } from './nightly-schedule'

export interface NightlySources {
  observationsSince(sinceIso: string | null): Promise<string[]>
  milestonesSince(sinceIso: string | null): Promise<string[]>
  messagesSince(sinceIso: string | null): Promise<string[]>
  projectMemory(): string
}
export interface NightlyConfig { enabled: boolean; at: string; timezone: string }
export interface NightlyState {
  lastRunDay: string | null
  lastRunIso: string | null
  fingerprint: string | null
  failures: number
  lastFailDay: string | null
  firstRunDone: boolean
  pendingNotice: { text: string; createdAtMs: number } | null
}
export interface NightlyRunDeps {
  stateDir: string
  ownerChatId: () => string | null
  config: () => NightlyConfig
  sources: NightlySources
  cheapEval: () => ((p: string) => Promise<string>) | null
  ownerRecentlyActive: () => Promise<boolean>
  now: () => number
  newId: () => string
  log: (tag: string, line: string) => void
}

export const MEMORY_LOG_FILE = 'memory-log.jsonl'
const STATE_FILE = 'memory-nightly.json'
const BLOCK_CAP = 6000
const EVAL_TIMEOUT_MS = 5 * 60_000
const DEFAULT_STATE: NightlyState = { lastRunDay: null, lastRunIso: null, fingerprint: null, failures: 0, lastFailDay: null, firstRunDone: false, pendingNotice: null }

export function readNightlyState(stateDir: string): NightlyState {
  try { return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(join(stateDir, 'companion', STATE_FILE), 'utf8')) as Partial<NightlyState>) } }
  catch { return { ...DEFAULT_STATE } }
}

export function writeNightlyState(stateDir: string, s: NightlyState): void {
  const dir = join(stateDir, 'companion')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${STATE_FILE}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, join(dir, STATE_FILE))
}

export function ownerMemoryRoot(stateDir: string, owner: string): string | null {
  if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
  return join(stateDir, 'memory', owner)
}

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')

export async function gatherMaterial(root: string, sources: NightlySources, sinceIso: string | null, firstRun: boolean): Promise<string> {
  const blocks: Array<[string, string]> = [
    ['CC 白天的草稿 profile.md', readIf(join(root, 'profile.md'))],
    ['待办 agenda.md', readIf(join(root, 'agenda.md'))],
    ['从聊天提炼的待办与联系人 knowledge.md', readIf(join(root, 'knowledge.md'))],
  ]
  const notes = join(root, 'notes')
  if (existsSync(notes)) {
    for (const f of readdirSync(notes).filter(f => f.endsWith('.md')).sort()) blocks.push([`笔记 notes/${f}`, readIf(join(notes, f))])
  }
  if (firstRun) blocks.push(['旧的整体理解 _overview.md', readIf(join(root, '_overview.md'))])
  blocks.push(['观察', (await sources.observationsSince(sinceIso)).join('\n')])
  blocks.push(['里程碑', (await sources.milestonesSince(sinceIso)).join('\n')])
  blocks.push(['这段时间的聊天', (await sources.messagesSince(sinceIso)).join('\n')])
  blocks.push(['本机 Claude 记忆', sources.projectMemory()])
  return blocks.filter(([, v]) => v.trim()).map(([k, v]) => `### ${k}\n${v.slice(0, BLOCK_CAP)}`).join('\n\n')
}

export function buildNightlyPrompt(a: { today: string; current: string; material: string }): string {
  return [
    `你在为主人整理一份长期记忆(今天是 ${a.today})。这份记忆每次对话都会被读,只留经得起时间的东西。`,
    '五栏:关于你(稳定事实)/ 偏好(做事方式、喜恶)/ 承诺(谁答应了谁什么;有期限就在正文写「(期限 YYYY-MM-DD)」)/ 身边的人(重要的人与关系)/ 近况(有时效的状态)。',
    '规则:',
    '- 只根据下面的素材改,不要编造;素材里主人说某条不对,就改掉或删掉它。',
    '- 仍然成立的条目放进 confirm;合并措辞、补充细节用 update 且 reversal=false;意思被推翻才 reversal=true。',
    '- 删除必须写原因;只有确定不再成立才删。',
    '- 单条不超过 200 字,全文不超过 3000 字;宁可合并,不要堆砌。',
    '只输出一个 JSON 对象,不要任何别的文字。四个键都必须出现,没有就给空数组:',
    '{"add":[{"section":"承诺","text":"…"}],"update":[{"id":"7f3a","text":"…","reversal":false}],"confirm":["91c2"],"remove":[{"id":"4d7c","reason":"…"}]}',
    '',
    '## 当前记忆(每条尾注里的 m:xxxx 是编号)',
    a.current,
    '',
    '## 新素材',
    a.material || '(无)',
  ].join('\n')
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export async function runMemoryNightly(deps: NightlyRunDeps, opts: { force: boolean }): Promise<NightlyRunResult> {
  const owner = deps.ownerChatId()
  const root = owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  if (!owner || !root) return { status: 'skipped', reason: 'no_owner' }
  const cfg = deps.config()
  if (!opts.force && !cfg.enabled) return { status: 'skipped', reason: 'disabled' }
  const state = readNightlyState(deps.stateDir)
  const nowMs = deps.now()
  const { day } = localParts(nowMs, cfg.timezone)
  if (!opts.force) {
    if (!isDue({ nowMs, tz: cfg.timezone, at: cfg.at, lastRunDay: state.lastRunDay })) return { status: 'skipped', reason: 'not_due' }
    if (state.lastFailDay === day) return { status: 'skipped', reason: 'failed_today' }
    if (await deps.ownerRecentlyActive()) return { status: 'skipped', reason: 'owner_busy' }
  }

  mkdirSync(root, { recursive: true })
  const memPath = join(root, MEMORY_FILENAME)
  const firstRun = !existsSync(memPath)
  const currentText = readIf(memPath)
  const material = await gatherMaterial(root, deps.sources, state.lastRunIso, firstRun)
  const fingerprint = createHash('sha256').update(material).digest('hex')
  if (!firstRun && fingerprint === state.fingerprint) {
    writeNightlyState(deps.stateDir, { ...state, lastRunDay: day })
    return { status: 'skipped', reason: 'no_new_material' }
  }

  const fail = (reason: string): NightlyRunResult => {
    const failures = state.failures + 1
    writeNightlyState(deps.stateDir, { ...state, failures, lastFailDay: day })
    deps.log('MEMORY_NIGHTLY', `failed (${reason}); ${failures} in a row`)
    if (failures >= 3) deps.log('MEMORY_NIGHTLY', `ALERT: ${failures} consecutive failures — memory.md may be stale`)
    return { status: 'failed', reason }
  }

  const evalFn = deps.cheapEval()
  if (!evalFn) return fail('no_cheap_eval')
  const doc = assignMissingIds(parseMemoryDoc(currentText), deps.newId, day)
  let raw: string
  try {
    raw = await withTimeout(evalFn(buildNightlyPrompt({ today: day, current: serializeMemoryDoc(doc, ''), material })), EVAL_TIMEOUT_MS)
  } catch (e) {
    return fail(`eval_error:${e instanceof Error ? e.message : String(e)}`)
  }
  const ops = parseOps(raw)
  if (!ops) return fail('bad_json')
  const res = applyNightly(doc, ops, { today: day, newId: deps.newId })
  if (!res.ok) return fail(res.reason)

  if (readIf(memPath) !== currentText) {
    deps.log('MEMORY_NIGHTLY', 'memory.md changed during the run — dropped, will retry')
    return { status: 'skipped', reason: 'owner_edited' }
  }
  const nowIso = new Date(nowMs).toISOString()
  if (!firstRun) {
    const archiveDir = join(deps.stateDir, 'memory-archive', owner)
    mkdirSync(archiveDir, { recursive: true })
    copyFileSync(memPath, join(archiveDir, `memory.md.${day}.md`))
  }
  const expired = res.applied.filter(a => a.kind === 'expire')
  if (expired.length) {
    const archiveDir = join(deps.stateDir, 'memory-archive', owner)
    mkdirSync(archiveDir, { recursive: true })
    appendFileSync(join(archiveDir, 'memory-expired.md'), expired.map(a => `- ${day} [${a.section}] ${a.text}(${a.kind === 'expire' ? a.reason : ''})`).join('\n') + '\n')
  }
  const tmp = `${memPath}.tmp-${process.pid}`
  writeFileSync(tmp, serializeMemoryDoc(res.doc, nowIso))
  renameSync(tmp, memPath)
  appendFileSync(join(root, 'memory-log.jsonl'), JSON.stringify({ at: nowIso, ops: res.applied }) + '\n')

  const notice = composeNotice(noticeItems(res.applied), !state.firstRunDone)
  writeNightlyState(deps.stateDir, {
    ...state,
    lastRunDay: day,
    lastRunIso: nowIso,
    fingerprint,
    failures: 0,
    lastFailDay: null,
    firstRunDone: true,
    pendingNotice: !opts.force && notice ? { text: notice, createdAtMs: nowMs } : state.pendingNotice,
  })
  deps.log('MEMORY_NIGHTLY', `written: ${res.applied.length} change(s)`)
  return { status: 'written', applied: res.applied, notice }
}
```

- [ ] **Step 4: 园丁不碰 `memory.md`**

先看园丁怎么挑文件:`grep -n "profile.md\|notes\|readdirSync\|\.md'" src/daemon/memory/gardener.ts`。在挑候选文件的地方加一行排除(变量名按该文件实际的循环变量改):

```ts
    if (rel === 'memory.md') continue   // 每晚整理的长期记忆由 memory/nightly.ts 独管,园丁不压缩它(2026-09-25)
```

并在 `src/daemon/memory/gardener.test.ts` 加一条测试:在测试夹具的 memoryRoot 里放一个 3KB 的 `memory.md`,跑一次 `runGarden`,断言 `cheapEval` 没被以含该文件内容的提示词调用、文件字节不变。照该测试文件里已有的第一个 `it(` 的夹具写法搭(同一个 `memoryRoot`、`archiveRoot`、`stateFile`、假 `cheapEval`),只换输入文件。

- [ ] **Step 5: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/memory/nightly.test.ts src/daemon/memory/gardener.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory/nightly.test.ts src/daemon/memory/gardener.test.ts`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/daemon/memory/nightly.ts src/daemon/memory/nightly.test.ts src/daemon/memory/gardener.ts src/daemon/memory/gardener.test.ts
git commit -m "跑一次每晚记忆整理:指纹跳过、改动清单、修订检查、备份与日志;园丁不碰 memory.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 配置、care kind、运行时(定时 + 送信 + 两种视图)

**Files:**
- Modify: `src/daemon/companion/config.ts`(接口 / 默认值 / 加载器各一处)、`src/daemon/config-surface.ts`
- Modify: `src/daemon/companion/calibration.ts`、`src/daemon/companion/care-ledger.ts`
- Create: `src/daemon/memory/nightly-runtime.ts`、`src/daemon/memory/nightly-lifecycle.ts`
- Test: `src/daemon/memory/nightly-runtime.test.ts`、`src/daemon/companion/calibration.test.ts`(追加)、`src/daemon/companion/config.test.ts`(追加)

**Interfaces:**
- Consumes: Task 3 `NightlyRunResult`,Task 5 全部导出
- Produces:
  - `CompanionConfig.memory_nightly_enabled: boolean`(默认 `true`)、`CompanionConfig.memory_nightly_at: string`(默认 `'04:00'`,只收 `HH:MM`)
  - `CareKind` 增加 `'memory'`;`CareLedgerEntry.lastMemoryAtIso?: string`;`CareLedger.claimMemory(chatId: string, nowIso: string): void`
  - `interface NoticeDeps { careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }; claim(chatId: string, nowIso: string): void; wechatSuspended(): boolean; send(chatId: string, text: string): Promise<{ error?: string }> }`
  - `interface CuratedView { updated_at: string | null; sections: Array<{ name: Section; items: Array<{ id: string | null; text: string; due: string | null; changed: boolean }> }> }`
  - `interface MemoryNightlyRuntime { tick(): Promise<void>; runNow(): Promise<NightlyRunResult>; readCurated(): string | null; curatedView(): CuratedView | null }`
  - `makeMemoryNightlyRuntime(deps: NightlyRunDeps & NoticeDeps): MemoryNightlyRuntime`
  - `deliverPendingNotice(deps: NightlyRunDeps & NoticeDeps): Promise<'none' | 'sent' | 'waiting' | 'expired' | 'dropped'>`
  - `registerMemoryNightly(d: { runtime: MemoryNightlyRuntime; holdBusy?: (label: string) => () => void; log: (tag: string, line: string) => void; intervalMs?: number }): Lifecycle`

- [ ] **Step 1: 写失败测试(配置 + care)**

在 `src/daemon/companion/config.test.ts` 末尾追加(文件已 import `loadCompanionConfig`;若没有,补 `import { loadCompanionConfig } from './config'` 与 fs/os/path):

```ts
describe('memory nightly config', () => {
  it('defaults to enabled at 04:00 and rejects malformed times', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
    expect(loadCompanionConfig(dir)).toMatchObject({ memory_nightly_enabled: true, memory_nightly_at: '04:00' })
    writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify({ memory_nightly_enabled: false, memory_nightly_at: '4am' }))
    expect(loadCompanionConfig(dir)).toMatchObject({ memory_nightly_enabled: false, memory_nightly_at: '04:00' })
  })
})
```

(先用 `grep -n "function loadCompanionConfig" -A6 src/daemon/companion/config.ts` 确认配置文件的实际路径;若不是 `companion/config.json`,把上面测试里的路径改成实际路径,并在写入前 `mkdirSync` 该目录。)

在 `src/daemon/companion/calibration.test.ts` 末尾追加:

```ts
describe('memory kind', () => {
  const base = { level: 'low' as const, nowIso: '2026-09-25T09:00:00Z' }
  it('pauses after two unanswered proactive sends and allows one per 20h', () => {
    expect(shouldSpeak({ ...base, kind: 'memory', ledger: { noReplyCount: 2 } })).toEqual({ ok: false, reason: 'paused_no_reply' })
    expect(shouldSpeak({ ...base, kind: 'memory', ledger: { noReplyCount: 0, lastMemoryAtIso: '2026-09-24T20:00:00Z' } })).toEqual({ ok: false, reason: 'memory_cooldown' })
    expect(shouldSpeak({ ...base, kind: 'memory', ledger: { noReplyCount: 0, lastMemoryAtIso: '2026-09-24T12:00:00Z' } })).toEqual({ ok: true })
    expect(shouldSpeak({ ...base, level: 'off', kind: 'memory', ledger: { noReplyCount: 0 } })).toEqual({ ok: false, reason: 'care_off' })
  })
})
```

Run: `bun --bun vitest run src/daemon/companion/config.test.ts src/daemon/companion/calibration.test.ts`
Expected: FAIL(字段不存在 / `kind: 'memory'` 不被接受)

- [ ] **Step 2: 实现配置 + care**

`src/daemon/companion/config.ts` —— 接口里 `import_local_history: boolean` 下一行加:

```ts
  /** 每晚整理长期记忆 memory.md(2026-09-25,memory/nightly.ts)。 */
  memory_nightly_enabled: boolean
  /** 每晚整理的时间点,主人时区的 HH:MM。 */
  memory_nightly_at: string
```

`defaultCompanionConfig()` 里 `import_local_history: false,` 下一行加:

```ts
    memory_nightly_enabled: true,
    memory_nightly_at: '04:00',
```

`loadCompanionConfig()` 里 `import_local_history: ...,` 下一行加:

```ts
      memory_nightly_enabled: typeof parsed.memory_nightly_enabled === 'boolean' ? parsed.memory_nightly_enabled : d.memory_nightly_enabled,
      memory_nightly_at: typeof parsed.memory_nightly_at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.memory_nightly_at) ? parsed.memory_nightly_at : d.memory_nightly_at,
```

`src/daemon/config-surface.ts` —— `companion.import_local_history` 那一项后面加:

```ts
  { key: 'companion.memory_nightly_enabled', store: 'companion', field: 'memory_nightly_enabled',
    type: 'boolean', writable: true, effect: 'next-tick',
    description: '每晚整理长期记忆 memory.md(每次对话都读;有值得说的变化会告诉主人)' },
  { key: 'companion.memory_nightly_at', store: 'companion', field: 'memory_nightly_at',
    type: 'string', writable: true, effect: 'next-tick',
    description: '每晚整理的时间点(主人时区,HH:MM,默认 04:00)',
    validate: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) },
```

`src/daemon/companion/calibration.ts`:
- `export type CareKind = 'agenda' | 'gap' | 'hunt' | 'visit' | 'memory'`
- `CareLedgerEntry` 里 `lastVisitAtIso?: string` 下一行加 `/** 上次「昨晚整理记忆」通知(2026-09-25)。 */ lastMemoryAtIso?: string`
- `VISIT_COOLDOWN_MS` 下一行加 `/** 记忆通知一天最多一次。 */ const MEMORY_COOLDOWN_MS = 20 * HOUR`
- 在 `if (kind === 'visit') {` 这一块**之前**插入:

```ts
  if (kind === 'memory') {
    // 同打猎 / 串门:主人两次不回就暂停;不看 lastInbound。
    if (ledger.noReplyCount >= PAUSE_AFTER_NO_REPLIES) return { ok: false, reason: 'paused_no_reply' }
    const lastMemoryMs = ledger.lastMemoryAtIso !== undefined ? Date.parse(ledger.lastMemoryAtIso) : undefined
    if (lastMemoryMs !== undefined && Number.isNaN(lastMemoryMs)) return { ok: false, reason: 'invalid_timestamp' }
    if (lastMemoryMs !== undefined && nowMs - lastMemoryMs < MEMORY_COOLDOWN_MS) return { ok: false, reason: 'memory_cooldown' }
    return { ok: true }
  }
```

`src/daemon/companion/care-ledger.ts` —— 接口里 `claimVisit` 下加 `/** 记忆通知发出前登记(at-most-once,同 claimHunt)。 */ claimMemory(chatId: string, nowIso: string): void`,实现里 `claimVisit` 后加:

```ts
    claimMemory(chatId, nowIso) {
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur, lastMemoryAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
      store.set(chatId, JSON.stringify(next))
    },
```

然后 `bun run typecheck`;凡是手写 `CareLedger` 假对象的测试报缺 `claimMemory`,就在那个假对象里加 `claimMemory: () => {}`(`git grep -n "claimVisit" -- src` 能找全)。

Run: `bun --bun vitest run src/daemon/companion/config.test.ts src/daemon/companion/calibration.test.ts && bun run typecheck`
Expected: 全绿,typecheck 0 error

- [ ] **Step 3: 写失败测试(运行时)**

`src/daemon/memory/nightly-runtime.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryNightlyRuntime, deliverPendingNotice, type NoticeDeps } from './nightly-runtime'
import { readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, now: number, sent: string[]
let n = 0

function deps(over: Partial<NightlyRunDeps & NoticeDeps> = {}): NightlyRunDeps & NoticeDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => ['主人:周五前给 X 回话'], projectMemory: () => '' },
    cheapEval: () => async () => JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }], update: [], confirm: [], remove: [] }),
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => `id${String(n++).padStart(2, '0')}`,
    log: () => {},
    careGate: () => ({ ok: true }),
    claim: vi.fn(),
    wechatSuspended: () => false,
    send: async (_c, t) => { sent.push(t); return {} },
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-rt-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '草稿\n')
  now = Date.parse('2026-09-25T04:05:00Z')
  sent = []
})

describe('memory nightly runtime', () => {
  it('tick at 04:05 writes the memory but holds the notice until 09:00', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.tick()
    expect(sent).toEqual([])
    now = Date.parse('2026-09-25T09:01:00Z')
    await rt.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('claims before sending, drops on care denial, waits on cooldown or a suspended WeChat link, expires after 24h', async () => {
    const claim = vi.fn()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'x', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    now = Date.parse('2026-09-25T10:00:00Z')
    expect(await deliverPendingNotice(deps({ wechatSuspended: () => true }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'memory_cooldown' }) }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ claim }))).toBe('sent')
    expect(claim).toHaveBeenCalledWith(OWNER, '2026-09-25T10:00:00.000Z')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'y', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'paused_no_reply' }) }))).toBe('dropped')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'z', createdAtMs: Date.parse('2026-09-24T04:00:00Z') } })
    expect(await deliverPendingNotice(deps())).toBe('expired')
    expect(sent).toEqual(['x'])
  })
  it('readCurated shows the rendered memory with a header; curatedView marks last night changes and dues', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    expect(rt.readCurated()).toBeNull()
    await rt.runNow()
    const text = rt.readCurated()!
    expect(text.split('\n')[0]).toBe('最近整理:2026-09-25 04:05 · 改了 1 处')
    expect(text).toContain('### 承诺\n- 周五前给 X 回话(期限 2026-09-26)')
    const v = rt.curatedView()!
    expect(v.updated_at).toBe('2026-09-25T04:05:00.000Z')
    expect(v.sections.find(s => s.name === '承诺')!.items[0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', due: '2026-09-26', changed: true })
  })
  it('warns in the header after three failed nights', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 3 })
    expect(rt.readCurated()!.split('\n')[0]).toBe('⚠️ 最近 3 次整理都没成功,下面可能是旧的。')
  })
})
```

Run: `bun --bun vitest run src/daemon/memory/nightly-runtime.test.ts`
Expected: FAIL,`Cannot find module './nightly-runtime'`

- [ ] **Step 4: 实现运行时与生命周期**

`src/daemon/memory/nightly-runtime.ts`:

```ts
/**
 * 每晚记忆整理的运行时:15 分钟一次 tick(该跑就跑一次整理、再看看待发通知),
 * 「整理记忆」的立即运行,以及给微信(文本)与手机(结构)的只读视图。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_FILENAME, SECTIONS, parseDue, parseMemoryDoc, renderForPrompt, type Section } from './curated-doc'
import { MEMORY_LOG_FILE, ownerMemoryRoot, readNightlyState, runMemoryNightly, writeNightlyState, type NightlyRunDeps } from './nightly'
import type { NightlyRunResult } from './nightly-notify'
import type { AppliedOp } from './nightly-ops'
import { localParts, noticeTiming } from './nightly-schedule'

export interface NoticeDeps {
  careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }
  claim(chatId: string, nowIso: string): void
  wechatSuspended(): boolean
  send(chatId: string, text: string): Promise<{ error?: string }>
}
export interface CuratedView {
  updated_at: string | null
  sections: Array<{ name: Section; items: Array<{ id: string | null; text: string; due: string | null; changed: boolean }> }>
}
export interface MemoryNightlyRuntime {
  tick(): Promise<void>
  runNow(): Promise<NightlyRunResult>
  readCurated(): string | null
  curatedView(): CuratedView | null
}

const CHANGED_WINDOW_MS = 36 * 3_600_000

export async function deliverPendingNotice(deps: NightlyRunDeps & NoticeDeps): Promise<'none' | 'sent' | 'waiting' | 'expired' | 'dropped'> {
  const state = readNightlyState(deps.stateDir)
  const pending = state.pendingNotice
  const owner = deps.ownerChatId()
  if (!pending || !owner) return 'none'
  const nowMs = deps.now()
  const clear = () => writeNightlyState(deps.stateDir, { ...readNightlyState(deps.stateDir), pendingNotice: null })
  const timing = noticeTiming({ nowMs, tz: deps.config().timezone, createdAtMs: pending.createdAtMs })
  if (timing === 'expire') { clear(); deps.log('MEMORY_NIGHTLY', 'notice expired unsent'); return 'expired' }
  if (timing === 'wait' || deps.wechatSuspended()) return 'waiting'
  const nowIso = new Date(nowMs).toISOString()
  const gate = deps.careGate(owner, nowIso)
  if (!gate.ok) {
    if (gate.reason === 'memory_cooldown') return 'waiting'
    clear()
    deps.log('MEMORY_NIGHTLY', `notice dropped: ${gate.reason}`)
    return 'dropped'
  }
  deps.claim(owner, nowIso)   // 先登记再发:至多一次,不重试轰炸
  clear()
  const r = await deps.send(owner, pending.text)
  if (r.error) deps.log('MEMORY_NIGHTLY', `notice send failed (not retried): ${r.error}`)
  return 'sent'
}

function lastLog(root: string): { at: string; ops: AppliedOp[] } | null {
  const p = join(root, MEMORY_LOG_FILE)
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  try { return JSON.parse(lines[lines.length - 1]!) as { at: string; ops: AppliedOp[] } } catch { return null }
}

export function makeMemoryNightlyRuntime(deps: NightlyRunDeps & NoticeDeps): MemoryNightlyRuntime {
  const root = (): string | null => {
    const owner = deps.ownerChatId()
    return owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  }
  const readDoc = () => {
    const r = root()
    const p = r ? join(r, MEMORY_FILENAME) : null
    return r && p && existsSync(p) ? { root: r, doc: parseMemoryDoc(readFileSync(p, 'utf8')) } : null
  }
  return {
    async tick() {
      const r = await runMemoryNightly(deps, { force: false })
      if (r.status !== 'skipped' || r.reason !== 'not_due') deps.log('MEMORY_NIGHTLY', `tick: ${r.status}${r.status === 'written' ? '' : ` (${r.reason})`}`)
      await deliverPendingNotice(deps)
    },
    runNow: () => runMemoryNightly(deps, { force: true }),
    readCurated() {
      const got = readDoc()
      if (!got) return null
      const state = readNightlyState(deps.stateDir)
      const log = lastLog(got.root)
      const changes = log ? log.ops.length : 0
      const when = state.lastRunIso ? localParts(Date.parse(state.lastRunIso), deps.config().timezone) : null
      const header = state.failures >= 3
        ? `⚠️ 最近 ${state.failures} 次整理都没成功,下面可能是旧的。`
        : `最近整理:${when ? `${when.day} ${when.hhmm}` : '还没有'} · 改了 ${changes} 处`
      return `${header}\n\n${renderForPrompt(got.doc)}`
    },
    curatedView() {
      const got = readDoc()
      if (!got) return null
      const log = lastLog(got.root)
      const fresh = log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      const changed = new Set(fresh ? log!.ops.filter(o => o.kind === 'add' || o.kind === 'update').map(o => o.id) : [])
      return {
        updated_at: readNightlyState(deps.stateDir).lastRunIso,
        sections: SECTIONS.map(name => ({
          name,
          items: got.doc.sections[name].map(e => ({ id: e.id, text: e.text, due: parseDue(e.text), changed: !!e.id && changed.has(e.id) })),
        })),
      }
    },
  }
}
```

`src/daemon/memory/nightly-lifecycle.ts`:

```ts
/** 每晚记忆整理的定时器:15 分钟看一次「该不该跑」,由 main.ts 挂载(2026-09-25)。 */
import { startCompanionScheduler } from '../companion/scheduler'
import type { Lifecycle } from '../../lib/lifecycle'
import type { MemoryNightlyRuntime } from './nightly-runtime'

export function registerMemoryNightly(d: {
  runtime: MemoryNightlyRuntime
  holdBusy?: (label: string) => () => void
  log: (tag: string, line: string) => void
  intervalMs?: number
}): Lifecycle {
  const scheduler = startCompanionScheduler({
    name: 'memory-nightly', intervalMs: d.intervalMs ?? 15 * 60_000, jitterRatio: 0,
    shouldRun: () => true, onTick: () => d.runtime.tick(), log: d.log,
    ...(d.holdBusy ? { holdBusy: d.holdBusy } : {}),
  })
  let stopped = false
  return { name: 'memory-nightly', stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } } }
}
```

- [ ] **Step 5: 跑,确认绿(两个运行器)+ typecheck**

Run: `bun --bun vitest run src/daemon/memory src/daemon/companion/config.test.ts src/daemon/companion/calibration.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/memory src/daemon/companion/config.test.ts src/daemon/companion/calibration.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/daemon/companion src/daemon/config-surface.ts src/daemon/memory
git commit -m "每晚记忆整理运行时:定时、9 点后送信(care 新 kind memory)、微信与手机视图;两个新配置

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 接线 —— 素材、运行时、挂载、手动入口

**Files:**
- Create: `src/daemon/memory/nightly-sources.ts`
- Modify: `src/daemon/memory-llm-ops.ts`(抽出 `resolveCheapEval`)
- Modify: `src/daemon/wiring/pipeline-deps.ts`(造运行时、传给管理命令与设置面板、随返回值带出)、`src/daemon/wiring/index.ts`(透传)
- Modify: `src/daemon/main.ts`(挂生命周期、接内部 API)
- Modify: `src/daemon/internal-api/{types,index,lifecycle,routes-memory,route-tiers}.ts`
- Modify: `src/lib/cli-llm-eval.ts`、`cli.ts`
- Test: `src/daemon/internal-api/routes-memory.test.ts`(追加)、`src/daemon/memory-llm-ops.test.ts`(追加,若该文件不存在则新建)

**Interfaces:**
- Consumes: Task 5 `NightlySources`、Task 6 `makeMemoryNightlyRuntime` / `registerMemoryNightly` / `MemoryNightlyRuntime`、`CareLedger.claimMemory`
- Produces:
  - `makeNightlySources(o: { db: Db; stateDir: string; ownerChatId: () => string | null }): NightlySources`
  - `resolveCheapEval(deps: Pick<MemoryLlmOpsDeps, 'getMode' | 'registry'>, chatId: string): ((p: string) => Promise<string>) | null`
  - `wireMain(...)` 返回值新增 `memoryNightly: MemoryNightlyRuntime`
  - 内部 API `POST /v1/memory/nightly/run` → `{ ok: true, result: NightlyRunResult }`;无运行时 → 503 `{ error: 'memory_nightly_not_wired' }`
  - `InternalApiDeps.memoryNightly?: { runNow(): Promise<unknown> }`、`setMemoryNightly(r): void`
  - CLI `wechat-cc memory nightly --now [--json]`

- [ ] **Step 1: 写失败测试(路由 + resolveCheapEval)**

在 `src/daemon/internal-api/routes-memory.test.ts` 里,照该文件对 `POST /v1/memory/synthesize` 的现有测试构造路由表的方式(同一个工厂与假 deps),追加:

```ts
  it('POST /v1/memory/nightly/run runs the nightly tidy now and returns its result', async () => {
    const runNow = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'no_new_material' })
    const routes = makeRoutes({ ...baseDeps, memoryNightly: { runNow } })
    const r = await routes['POST /v1/memory/nightly/run']!({}, {})
    expect(r).toEqual({ status: 200, body: { ok: true, result: { status: 'skipped', reason: 'no_new_material' } } })
  })
  it('POST /v1/memory/nightly/run is 503 when not wired', async () => {
    const routes = makeRoutes({ ...baseDeps })
    expect(await routes['POST /v1/memory/nightly/run']!({}, {})).toEqual({ status: 503, body: { error: 'memory_nightly_not_wired' } })
  })
```

(`makeRoutes` / `baseDeps` 换成该测试文件里实际用的工厂名与基础 deps 变量名 —— 打开文件看 synthesize 那条测试,原样照抄前两行。)

新建或追加 `src/daemon/memory-llm-ops.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveCheapEval } from './memory-llm-ops'

describe('resolveCheapEval', () => {
  const own = async () => 'own', fallback = async () => 'fallback'
  const registry = { get: (id: string) => (id === 'codex' ? { provider: { cheapEval: own } } : null), getCheapEval: () => fallback }
  it('follows the chat solo provider, else the registry default', () => {
    expect(resolveCheapEval({ getMode: () => ({ kind: 'solo', provider: 'codex' }), registry }, 'c')).toBe(own)
    expect(resolveCheapEval({ getMode: () => undefined, registry }, 'c')).toBe(fallback)
  })
})
```

Run: `bun --bun vitest run src/daemon/internal-api/routes-memory.test.ts src/daemon/memory-llm-ops.test.ts`
Expected: FAIL(路由不存在 / `resolveCheapEval` 未导出)

- [ ] **Step 2: 实现 `resolveCheapEval` 并让 `makeMemoryLlmOps` 用它**

`src/daemon/memory-llm-ops.ts` 在 `makeMemoryLlmOps` 前加:

```ts
/** 与主人当前对话同一家的 cheapEval,没有就用注册表默认 —— 记忆整理类任务统一走这里。 */
export function resolveCheapEval(deps: Pick<MemoryLlmOpsDeps, 'getMode' | 'registry'>, chatId: string): ((p: string) => Promise<string>) | null {
  const mode = deps.getMode(chatId)
  const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
  return (provider ? deps.registry.get(provider)?.provider.cheapEval : null) ?? deps.registry.getCheapEval()
}
```

并把 `makeMemoryLlmOps` 里原来那两行(`const provider = mode && mode.kind === 'solo' ...` 与 `const cheapEval = (provider ? ...) ?? deps.registry.getCheapEval()`)换成 `const cheapEval = resolveCheapEval(deps, adminChatId)`(保留其后 `if (!cheapEval) throw ...`;若原代码先取了 `mode` 另有他用,保留那一行)。

- [ ] **Step 3: 素材适配器**

`src/daemon/memory/nightly-sources.ts`:

```ts
/** 每晚整理的素材来源(薄适配,真库):观察、里程碑、上次整理以来的聊天、可选的本机 Claude 记忆。 */
import type { Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { summarizeProjectMemories } from '../../lib/memory-synthesis'
import { loadCompanionConfig } from '../companion/config'
import { makeMilestonesStore } from '../milestones/store'
import { makeObservationsStore } from '../observations/store'
import type { NightlySources } from './nightly'

const FIRST_RUN_LOOKBACK_MS = 3 * 86_400_000

export function makeNightlySources(o: { db: Db; stateDir: string; ownerChatId: () => string | null }): NightlySources {
  return {
    async observationsSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      return (await makeObservationsStore(o.db, c).listActive()).filter(r => !since || r.ts > since).map(r => `- ${r.ts.slice(0, 10)} ${r.body}`)
    },
    async milestonesSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      return (await makeMilestonesStore(o.db, c).list()).filter(r => !since || r.ts > since).map(r => `- ${r.ts.slice(0, 10)} ${r.body}`)
    },
    async messagesSince(since) {
      const c = o.ownerChatId()
      if (!c) return []
      const from = since ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString()
      const rows = await makeMessagesStore(o.db).listSince(c, from, 400)
      return rows.filter(m => m.kind === 'text' && m.text.trim()).map(m => `${m.direction === 'in' ? '主人' : 'CC'}:${m.text.slice(0, 300)}`).slice(-200)
    },
    projectMemory() {
      if (!loadCompanionConfig(o.stateDir).import_local_history) return ''
      return summarizeProjectMemories().map(p => `# ${p.name}\n${p.files.map(f => f.content).join('\n')}`).join('\n\n').slice(0, 6000)
    },
  }
}
```

- [ ] **Step 4: 在 pipeline-deps 造运行时**

`src/daemon/wiring/pipeline-deps.ts`,紧接 `makeMemoryLlmOps({ ... })` 那一行之后(约 :316-330,`const memoryLlmOps = ...` 处):

```ts
  // 每晚整理长期记忆 memory.md(spec 2026-09-25-memory-nightly-design)。定时器由 main.ts 挂。
  const nightlyOwner = (): string | null => loadCompanionConfig(stateDir).default_chat_id ?? null
  const memoryNightly = makeMemoryNightlyRuntime({
    stateDir,
    ownerChatId: nightlyOwner,
    config: () => {
      const c = loadCompanionConfig(stateDir)
      return { enabled: c.memory_nightly_enabled, at: c.memory_nightly_at, timezone: c.timezone }
    },
    sources: makeNightlySources({ db, stateDir, ownerChatId: nightlyOwner }),
    cheapEval: () => {
      const o = nightlyOwner()
      return o ? resolveCheapEval({ getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry }, o) : boot.registry.getCheapEval()
    },
    ownerRecentlyActive: async () => {
      const o = nightlyOwner()
      if (!o) return false
      const ts = await makeMessagesStore(db).latestInboundTs(o)
      return !!ts && Date.now() - Date.parse(ts) < 3 * 60_000
    },
    now: () => Date.now(),
    newId: () => randomBytes(3).toString('hex'),
    log: (t, l) => log(t, l),
    careGate: (chatId, nowIso) => shouldSpeak({
      kind: 'memory',
      level: careLevel(chatId, chatPrefs.get(chatId), loadCompanionConfig(stateDir).default_chat_id),
      nowIso,
      ledger: careLedger.get(chatId),
    }),
    claim: (chatId, nowIso) => careLedger.claimMemory(chatId, nowIso),
    wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
    send: (chatId, text) => ilink.sendMessage(chatId, text),
  })
```

补 import(按文件现有风格合并到已有 import 行):`makeMemoryNightlyRuntime` from `'../memory/nightly-runtime'`、`makeNightlySources` from `'../memory/nightly-sources'`、`resolveCheapEval` from `'../memory-llm-ops'`、`shouldSpeak, careLevel` from `'../companion/calibration'`、`makeMessagesStore` from `'../../lib/messages-store'`、`randomBytes` from `'node:crypto'`、`loadCompanionConfig`(若未 import)。本文件里的 `boot` / `db` / `stateDir` / `ilink` / `careLedger` / `chatPrefs` / `log` 以该函数作用域里实际可用的名字为准(`makeMemoryLlmOps({stateDir, db, getMode, registry: boot.registry})` 那一行就在同一作用域;`careLedger`、`chatPrefs`、`ilink` 是 `wireMain` 的入参,见 `main.ts` 的 `wireMain({ ... stateDir, db, ilink, accounts, boot, dangerously, chatPrefs, careLedger ... })`,在本文件里通过 `opts.` 前缀取的就写 `opts.careLedger` 等)。`chatPrefs.get(chatId)` 若返回类型没有 `care` 字段,写 `chatPrefs.get(chatId) as { care?: CareLevel }`。

然后:
- 把 `memoryNightly` 加进本文件末尾的返回对象(:1035 `return { pipelineDeps, companionConverse, petTurn, mattersService, settingsPanelLink: ... }` 加 `memoryNightly`),并在声明该返回类型的接口里(`settingsPanelLink: () => Promise<string | null>` 所在处,约 :198)加 `memoryNightly: import('../memory/nightly-runtime').MemoryNightlyRuntime`。
- `src/daemon/wiring/index.ts`::238 的解构里加 `memoryNightly`,:244 附近的返回对象里加 `memoryNightly`,:130 附近 `settingsPanelLink: () => Promise<string | null>` 所在接口加同一行类型。

- [ ] **Step 5: 内部 API 路由与 setter**

- `src/daemon/internal-api/types.ts`:`settingsLink?: () => Promise<string | null>`(:478)下加 `memoryNightly?: { runNow(): Promise<unknown> }`;`setSettingsLink(fn: ...)`(:587)下加 `setMemoryNightly(r: { runNow(): Promise<unknown> }): void`。
- `src/daemon/internal-api/index.ts`:`setSettingsLink(fn) { deps.settingsLink = fn },`(:433)下加 `setMemoryNightly(r) { deps.memoryNightly = r },`。
- `src/daemon/internal-api/lifecycle.ts`:接口里 `setSettingsLink(...)`(:26)下加 `setMemoryNightly(r: { runNow(): Promise<unknown> }): void`,实现里 `setSettingsLink: (fn) => api.setSettingsLink(fn),`(:74)下加 `setMemoryNightly: (r) => api.setMemoryNightly(r),`。
- `src/daemon/internal-api/routes-memory.ts`,`'POST /v1/memory/synthesize'` 之后加:

```ts
    // 每晚记忆整理的立即运行(CLI `memory nightly --now`)。忽略时间点,仍走指纹 / 校验 / 修订检查。
    'POST /v1/memory/nightly/run': async () => {
      if (!deps.memoryNightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      return { status: 200, body: { ok: true, result: await deps.memoryNightly.runNow() } }
    },
```

- `src/daemon/internal-api/route-tiers.ts`:`'POST /v1/memory/synthesize': 'trusted',`(:231)下加 `'POST /v1/memory/nightly/run': 'trusted',`。再 `git grep -n "v1/memory/synthesize" -- src` 核对:凡是列了 synthesize 的注册表(schema、允许清单等),都照样给 nightly/run 加一项。

- [ ] **Step 6: main.ts 挂载**

`src/daemon/main.ts`,在 `mailboxLc` 那三行之后加:

```ts
    // 每晚整理长期记忆 memory.md(2026-09-25)。15 分钟一次「该不该跑」,运行时在 pipeline-deps 造好。
    const memoryNightlyLc = await sup.start('memory-nightly', () => registerMemoryNightly({
      runtime: wired.memoryNightly, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
    }))
    if (memoryNightlyLc) lc.register(memoryNightlyLc)
    internalApi.setMemoryNightly(wired.memoryNightly)
```

并 `import { registerMemoryNightly } from './memory/nightly-lifecycle'`。

- [ ] **Step 7: CLI**

`src/lib/cli-llm-eval.ts`:`MemoryDelegateOp` 的联合里加 `'nightly'`,`MEMORY_OP_PATHS` 加 `'nightly': '/v1/memory/nightly/run',`。

`cli.ts`,在 `memorySynthesizeCmd` 定义之后加:

```ts
const memoryNightlyCmd = defineCommand({
  meta: { name: 'nightly', description: '立刻跑一次每晚记忆整理(需要 daemon 在跑)' },
  args: {
    now: { type: 'boolean', description: '忽略时间点,立刻跑(目前只支持这一种)', default: false },
    json: { type: 'boolean', description: '机器可读输出', default: false },
  },
  async run({ args }) {
    if (!args.now) { console.error('用法:wechat-cc memory nightly --now'); process.exitCode = 2; return }
    const apiInfo = await readCliApiInfo()
    const r = await delegateMemoryOp('nightly', {}, { readApiInfo: () => apiInfo, fetch })
    console.log(args.json ? JSON.stringify(r) : JSON.stringify(r, null, 2))
    if (!(r as { ok?: boolean }).ok) process.exitCode = 1
  },
})
```

并在 `memoryCmd` 的 `subCommands` 里加 `nightly: memoryNightlyCmd,`。

- [ ] **Step 8: 跑,确认绿 + 全量 typecheck/depcheck**

Run: `bun --bun vitest run src/daemon/internal-api/routes-memory.test.ts src/daemon/memory-llm-ops.test.ts src/daemon/memory && npx vitest run -c vitest.node.config.ts src/daemon/internal-api/routes-memory.test.ts src/daemon/memory-llm-ops.test.ts src/daemon/memory && bun run typecheck && bun run depcheck`
Expected: 全绿;typecheck 0;depcheck 0 error

- [ ] **Step 9: 提交**

```bash
git add src/daemon/memory src/daemon/memory-llm-ops.ts src/daemon/memory-llm-ops.test.ts src/daemon/wiring src/daemon/main.ts src/daemon/internal-api src/lib/cli-llm-eval.ts cli.ts
git commit -m "接线每晚记忆整理:素材适配、pipeline-deps 造运行时、main 挂载、/v1/memory/nightly/run 与 CLI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 每次对话读 `memory.md`;CC 白天不能改它

**Files:**
- Modify: `src/core/prompt-builder.ts`、`src/daemon/bootstrap/{types,index}.ts`、`src/daemon/main.ts`
- Modify: `src/daemon/internal-api/routes.ts`
- Test: `src/core/prompt-builder.test.ts`、`src/daemon/internal-api.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 `parseMemoryDoc` / `renderForPrompt` / `MEMORY_FILENAME`
- Produces:
  - `BuildSystemPromptArgs.curatedMemory?: string`;`CURATED_MEMORY_MAX_CHARS = 3200`;`curatedMemorySection(content: string): string`
  - `BootstrapDeps.curatedMemoryFor?: (chatId: string) => string`
  - 会话来源(`caller.origin === 'session'`)写 / 删 `<chat>/memory.md` → `200 { ok: false, error: 'curated_memory_readonly', hint: '…' }`

- [ ] **Step 1: 写失败测试(提示词)**

`src/core/prompt-builder.test.ts` 的 `describe('core-memory prompt section')` 里(该 describe 已有 `const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }`)追加,并在文件顶部 import 里加 `curatedMemorySection`:

```ts
  it('curated memory replaces the profile section when present', () => {
    const p = buildSystemPrompt({ ...base, coreMemory: 'PROFILE 草稿', curatedMemory: '### 偏好\n- 回复直接' })
    expect(p).toContain('### 偏好\n- 回复直接')
    expect(p).not.toContain('PROFILE 草稿')
    expect(p).toContain('长期记忆')
  })
  it('falls back to the profile section when curated memory is empty', () => {
    const p = buildSystemPrompt({ ...base, coreMemory: 'PROFILE 草稿', curatedMemory: '  ' })
    expect(p).toContain('PROFILE 草稿')
  })
  it('curatedMemorySection tells CC where daytime notes go', () => {
    expect(curatedMemorySection('- x')).toContain('profile.md')
  })
```

Run: `bun --bun vitest run src/core/prompt-builder.test.ts`
Expected: FAIL(`curatedMemorySection` 未导出)

- [ ] **Step 2: 实现提示词段**

`src/core/prompt-builder.ts`:
- `BuildSystemPromptArgs` 里 `coreMemory?: string`(:186)下加 `/** 每晚整理的长期记忆 memory.md 正文(去尾注);有它就不再注入 coreMemory(2026-09-25)。 */ curatedMemory?: string`
- :312 那一行 `args.coreMemory && ... ? coreMemorySection(args.coreMemory) : '',` 换成:

```ts
    args.curatedMemory && args.curatedMemory.trim().length > 0
      ? curatedMemorySection(args.curatedMemory)
      : args.coreMemory && args.coreMemory.trim().length > 0 ? coreMemorySection(args.coreMemory) : '',
```

- `coreMemorySection` 之后加:

```ts
export const CURATED_MEMORY_MAX_CHARS = 3200

/** 长期记忆段:每晚整理的 memory.md。CC 白天不改它(daemon 会拒写),新东西记到 profile.md / notes/。 */
export function curatedMemorySection(content: string): string {
  const body = content.length > CURATED_MEMORY_MAX_CHARS ? `${content.slice(0, CURATED_MEMORY_MAX_CHARS)}\n(长期记忆已截断)` : content
  return [
    '## 长期记忆(每晚整理的你眼中的 ta)',
    body,
    '这份每晚整理,你白天别改它;聊天里得知的新情况、主人说哪条不对,记到 profile.md 或 notes/,今晚会整理进来。',
  ].join('\n')
}
```

- `src/daemon/bootstrap/types.ts`:`coreMemoryFor?: (chatId: string) => string`(:147)下加 `curatedMemoryFor?: (chatId: string) => string`。
- `src/daemon/bootstrap/index.ts`:`coreMemory: deps.coreMemoryFor?.(chatId),`(:815)下加 `curatedMemory: deps.curatedMemoryFor?.(chatId),`。
- `src/daemon/main.ts`:`coreMemoryFor: (c) => { ... },` 之后加:

```ts
      // 每晚整理的长期记忆(2026-09-25):有 memory.md 就注入它(去尾注),prompt-builder 据此不再注入 profile.md。
      curatedMemoryFor: (c) => {
        const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
        const raw = fs.read(MEMORY_FILENAME)
        return raw ? renderForPrompt(parseMemoryDoc(raw)) : ''
      },
```

  并 `import { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from './memory/curated-doc'`。

Run: `bun --bun vitest run src/core/prompt-builder.test.ts && bun run typecheck`
Expected: 绿

- [ ] **Step 3: 写失败测试(写入闸)**

`src/daemon/internal-api.test.ts`,在 `trusted session token gets 403 memory_scope_denied ...`(:403)那条测试旁,照它的写法追加(`startWithMemory` / `api!.mintSessionToken` / `write` 是该文件已有的帮手;若有 `del` 帮手同理,没有就只测 write):

```ts
  it('a session (even admin) cannot overwrite the curated memory.md; the CLI/operator path still can', async () => {
    const { port } = await startWithMemory()
    const admin = api!.mintSessionToken('admin', 'claude/a/ownerchat')
    const w = await write(port, admin, 'ownerchat/memory.md')
    expect(w.status).toBe(200)
    expect(await w.json()).toMatchObject({ ok: false, error: 'curated_memory_readonly' })
    const other = await write(port, admin, 'ownerchat/profile.md')
    expect(await other.json()).toEqual({ ok: true })
  })
```

(若该文件里 admin 会话令牌的写法不同 —— 例如 `mintSessionToken` 的第一个参数取值 —— 照该文件里已有的 admin 用例改;测试断言不变。另在同一文件里找到用文件令牌 / 非 session 来源写记忆的已有用例,确认它写 `ownerchat/memory.md` 仍 `{ ok: true }`,把这一断言加进同一条测试。)

Run: `bun --bun vitest run src/daemon/internal-api.test.ts -t "curated memory"`
Expected: FAIL(返回 `{ ok: true }`)

- [ ] **Step 4: 实现写入闸**

`src/daemon/internal-api/routes.ts`,`memoryScopeDenied` 函数之后加:

```ts
/** 每晚整理的长期记忆由 daemon 独管:会话(任何 tier)不许写 / 删 `<chat>/memory.md`;CLI / 桌面(非 session 来源)照常。 */
function curatedMemoryDenied(path: string, caller?: { origin: string }): boolean {
  if (!caller || caller.origin !== 'session') return false
  return /^[^/]+\/memory\.md$/.test(path.replace(/\\/g, '/'))
}
const CURATED_READONLY = {
  status: 200 as const,
  body: { ok: false, error: 'curated_memory_readonly', hint: 'memory.md 每晚自动整理,白天别直接改:新情况记到 profile.md 或 notes/,今晚会整理进去。' },
}
```

在 `'POST /v1/memory/write'` 里 `if (memoryScopeDenied(path, caller)) ...` 之后加 `if (curatedMemoryDenied(path, caller)) return CURATED_READONLY`;在 `'POST /v1/memory/delete'` 里对它的 `path` 做同样检查(位置同样紧跟它的作用域检查之后)。

- [ ] **Step 5: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts src/daemon/internal-api.test.ts && npx vitest run -c vitest.node.config.ts src/core/prompt-builder.test.ts src/daemon/internal-api.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts src/daemon/bootstrap src/daemon/main.ts src/daemon/internal-api/routes.ts src/daemon/internal-api.test.ts
git commit -m "每次对话读 memory.md(替代 profile.md 注入);CC 会话不能改写它

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 微信「查看记忆」「整理记忆」

**Files:**
- Modify: `src/daemon/admin-commands.ts`、`src/daemon/wiring/pipeline-deps.ts`
- Test: `src/daemon/admin-commands.test.ts`(追加)

**Interfaces:**
- Consumes: Task 3 `formatNightlyReply` / `NightlyRunResult`,Task 6/7 `memoryNightly.readCurated()` / `runNow()`
- Produces: `AdminCommandsDeps.readCuratedMemory?: (adminChatId: string) => Promise<string | null>`、`AdminCommandsDeps.runMemoryNightlyNow?: () => Promise<NightlyRunResult>`

- [ ] **Step 1: 写失败测试**

`src/daemon/admin-commands.test.ts`,在 `replies with the synthesized overview`(:544)附近,照它的 `make(...)` / `msg(...)` / `sentBody(i)` 帮手追加:

```ts
  it('查看记忆 shows the curated memory when there is one', async () => {
    const readOverview = vi.fn().mockResolvedValue('## 整体理解\n旧的')
    const readCuratedMemory = vi.fn().mockResolvedValue('最近整理:2026-09-25 04:05 · 改了 1 处\n\n### 偏好\n- 回复直接')
    const cmds = make({ readOverview: readOverview as unknown as AdminCommandsDeps['readOverview'], readCuratedMemory })
    expect(await cmds.handle(msg('查看记忆'))).toBe(true)
    expect(sentBody(0)).toBe('🧠 我记得的你:\n\n最近整理:2026-09-25 04:05 · 改了 1 处\n\n### 偏好\n- 回复直接')
    expect(readOverview).not.toHaveBeenCalled()
  })
  it('整理记忆 runs the nightly tidy now and replies with what changed', async () => {
    const runMemoryNightlyNow = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'no_new_material' })
    const cmds = make({ runMemoryNightlyNow })
    expect(await cmds.handle(msg('整理记忆'))).toBe(true)
    await vi.waitFor(() => expect(runMemoryNightlyNow).toHaveBeenCalled())
    await vi.waitFor(() => expect(sentBody(1)).toBe('没有新东西要整理,记忆保持原样。'))
    expect(sentBody(0)).toBe('🧠 正在整理记忆…')
  })
```

Run: `bun --bun vitest run src/daemon/admin-commands.test.ts -t "记忆"`
Expected: FAIL

- [ ] **Step 2: 实现**

`src/daemon/admin-commands.ts`:
- `AdminCommandsDeps` 里 `readOverview?:`(:64)下加:

```ts
  /** 每晚整理的长期记忆(渲染好的文本,带「最近整理」首行);没有 memory.md 时 null。 */
  readCuratedMemory?: (adminChatId: string) => Promise<string | null>
  /** 「整理记忆」:立刻跑一次每晚整理。 */
  runMemoryNightlyNow?: () => Promise<import('./memory/nightly-notify').NightlyRunResult>
```

- `runShowOverview` 开头(在 `readOverview` 判空之前)加:

```ts
  const curated = deps.readCuratedMemory ? await deps.readCuratedMemory(adminChatId) : null
  if (curated) { await deps.sendMessage(adminChatId, `🧠 我记得的你:\n\n${curated}`); return }
```

- `runSynthesize` 里,在 in-flight 判重之后、原来的 `holdBusy('admin-synthesize')` 之前加一条分支(复用同一个 in-flight 集合与 finally):

```ts
  if (deps.runMemoryNightlyNow) {
    synthesizeInFlight.add(adminChatId)
    const release = deps.holdBusy?.('admin-memory-nightly')
    try {
      await deps.sendMessage(adminChatId, '🧠 正在整理记忆…')
      await deps.sendMessage(adminChatId, formatNightlyReply(await deps.runMemoryNightlyNow()))
    } catch (e) {
      deps.log('ADMIN', `memory nightly failed: ${e instanceof Error ? e.message : String(e)}`)
      await deps.sendMessage(adminChatId, '这次没整理成,记忆保持原样。')
    } finally {
      synthesizeInFlight.delete(adminChatId)
      release?.()
    }
    return
  }
```

  并 `import { formatNightlyReply } from './memory/nightly-notify'`。(in-flight 集合的实际名字以 :695 附近的代码为准。)

`src/daemon/wiring/pipeline-deps.ts`:在管理命令 deps 里 `synthesizeMemory: (adminChatId) => memoryLlmOps.synthesize(adminChatId),` 旁加:

```ts
    readCuratedMemory: async () => memoryNightly.readCurated(),
    runMemoryNightlyNow: () => memoryNightly.runNow(),
```

- [ ] **Step 3: 跑,确认绿(两个运行器)**

Run: `bun --bun vitest run src/daemon/admin-commands.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/admin-commands.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add src/daemon/admin-commands.ts src/daemon/admin-commands.test.ts src/daemon/wiring/pipeline-deps.ts
git commit -m "微信「查看记忆」读 memory.md,「整理记忆」立刻跑每晚整理

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 手机「CC 记得你」

**Files:**
- Modify: `src/daemon/settings-panel.ts`、`src/daemon/wiring/pipeline-deps.ts`
- Modify: `apps/mobile/src/phone.html`、`apps/mobile/src/home.js`;重新生成 `src/daemon/mobile-page.generated.json`
- Test: `src/daemon/settings-panel.test.ts`(追加)

**Interfaces:**
- Consumes: Task 6 `CuratedView`、`memoryNightly.curatedView()`
- Produces: `SettingsPanelDeps.curatedMemory?: () => CuratedView | null`;`GET /m/api/memory` → `{ ok: true, updated_at: string | null, sections: CuratedView['sections'] }`,未接 → 503 `{ ok: false, error: 'memory_not_wired' }`

- [ ] **Step 1: 写失败测试**

`src/daemon/settings-panel.test.ts` 末尾追加(独立构造面板,最小 deps 与 `settings-panel-brand-compiled.test.ts` 里用的一致):

```ts
describe('phone curated memory', () => {
  it('serves the curated memory view behind the token', async () => {
    const view = { updated_at: '2026-09-25T04:05:00.000Z', sections: [{ name: '偏好' as const, items: [{ id: 'b1', text: '回复直接', due: null, changed: true }] }] }
    const p = makeSettingsPanel({
      stateDir: mkdtempSync(join(tmpdir(), 'sp-mem-')), ownerChatId: () => null,
      chatPrefs: { get: () => ({}), set: (_id, patch) => patch },
      getUserName: () => null, setUserName: async () => {}, log: () => {},
      curatedMemory: () => view,
    })
    const { port } = await p.start(0)
    try {
      const base = `http://127.0.0.1:${port}`
      expect((await fetch(`${base}/m/api/memory`)).status).toBe(401)
      const r = await (await fetch(`${base}/m/api/memory?t=${p.issueToken()}`)).json()
      expect(r).toEqual({ ok: true, ...view })
    } finally { await p.stop() }
  })
})
```

(若文件顶部没有 `mkdtempSync` / `tmpdir` / `join` 的 import,补上。)

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts -t "curated memory"`
Expected: FAIL(`curatedMemory` 不是已知 dep / 路由 401 之外返回 404 或 unauthorized 之后无路由)

- [ ] **Step 2: 实现接口与接线**

`src/daemon/settings-panel.ts`:
- deps 接口里(`seen?:` 那一组可选 dep 旁,约 :88-104)加 `/** 手机「CC 记得你」(2026-09-25,memory/nightly-runtime)。 */ curatedMemory?: () => import('./memory/nightly-runtime').CuratedView | null`
- `routeRequest` 里 `/m/api/state` 路由之后加:

```ts
          if (url.pathname === '/m/api/memory' && req.method === 'GET') {
            if (!deps.curatedMemory) return json({ ok: false, error: 'memory_not_wired' }, 503)
            const v = deps.curatedMemory()
            return json({ ok: true, updated_at: v?.updated_at ?? null, sections: v?.sections ?? [] })
          }
```

`src/daemon/wiring/pipeline-deps.ts`:`makeSettingsPanel({`(:505)里 `seen: { ... },` 旁加 `curatedMemory: () => memoryNightly.curatedView(),`。

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts && bun run typecheck`
Expected: 绿

- [ ] **Step 3: 手机页 UI**

`apps/mobile/src/phone.html`,在「回忆」页 `</details>`(`memory-pocket` 那个折叠区的结束标签)之后、`</div>` 之前加:

```html
  <details class="memory-pocket" id="mem-box"><summary>CC 记得你</summary><div id="mem"></div></details>
```

同文件第一个 `<style>` 块末尾(`.sec { margin-top:18px }` 之后)加:

```css
  .mem-dot { color:var(--accent); font-weight:700 } .mem-at { display:block; color:var(--soft); margin:4px 0 8px }
```

`apps/mobile/src/home.js` 末尾、`loadHome()` 那一行之前加:

```js
// CC 记得你(2026-09-25):每晚整理的长期记忆,只读;昨晚改过的标一个点。展开时才取。
function loadMemory() {
  api("/m/api/memory").then(function(r){ return r.json() }).then(function(m) {
    var box = document.getElementById("mem")
    if (!m || !m.ok) { box.innerHTML = '<div class="empty">暂时读不到</div>'; return }
    var h = ""
    m.sections.forEach(function(s) {
      if (!s.items.length) return
      h += '<div class="grp">' + esc(s.name) + '</div>'
      s.items.forEach(function(it) {
        h += '<div class="card">' + (it.changed ? '<span class="mem-dot" title="昨晚更新">•</span> ' : '') + esc(it.text) + '</div>'
      })
    })
    box.innerHTML = h ? (m.updated_at ? '<small class="mem-at">最近整理 ' + esc(ago(m.updated_at)) + '</small>' : '') + h : '<div class="empty">还没整理过 —— 今晚会整理第一份</div>'
  }).catch(function(){ toast("网络不通") })
}
var memBox = /** @type {HTMLDetailsElement} */ (document.getElementById("mem-box"))
memBox.addEventListener("toggle", function(){ if (memBox.open) loadMemory() })
```

(承诺的期限已经写在条目正文里,不再单独显示。)

- [ ] **Step 4: 生成、类型、同步测试**

Run: `bun run build:mobile && bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel && npx vitest run -c vitest.node.config.ts apps/mobile src/daemon/mobile-page src/daemon/settings-panel`
Expected: 全绿(`apps/mobile/build.test.ts` 的同步与「行首不许 ( / [」都过;512KB 帧测试过)

- [ ] **Step 5: 提交**

```bash
git add src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts src/daemon/wiring/pipeline-deps.ts apps/mobile/src src/daemon/mobile-page.generated.json
git commit -m "手机「CC 记得你」:/m/api/memory + 回忆页只读五栏,昨晚改过的标点

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: 文档、整套回路、真机手动跑一次

**Files:**
- Modify: `docs/roadmap.md`、`docs/全景导图.md`(再生成 `docs/全景导图.html`)、`docs/architecture.md`(记忆分层一节)
- Test: 全量

- [ ] **Step 1: 文档**

- `docs/全景导图.md` 记忆相关的定案附近加一条:

```markdown
- 做 **每晚整理的长期记忆 memory.md(五栏、每条隐藏编号、模型只报改动)** [定] · 不做 **整份重写的 _overview / JSON 记忆库** ⟨2026-09-25,借鉴 Meta Muse 的 MEMORY.md:每次对话都读,主人能看能改,只在「新承诺 / 偏好被推翻 / 模型删除」时告诉主人。整份重写说不清改了什么;JSON 推翻「记忆保留 .md」。profile.md 退回白天草稿,_overview.md 不再更新。下一步 A 逐条纠错、C 第二天「我注意到…」⟩
```

  然后 `bun scripts/build-map.ts`。
- `docs/roadmap.md`:在「在做 / 刚做完」一类的列表里加一行「每晚整理长期记忆(B 看得见)已上线;下一步 A:手机上逐条标不对 / 过时 / 删掉;C:第二天偶尔说一句我注意到…」,链接 spec。
- `docs/architecture.md`:记忆分层那一节(`grep -n "_overview\|profile.md" docs/architecture.md` 找位置)补一句:「每次对话注入的长期记忆是每晚整理的 `memory.md`(`src/daemon/memory/nightly*.ts`);`profile.md` 是白天草稿;`_overview.md` 已停止更新。」

- [ ] **Step 2: 整套回路**

```bash
bun run test > /tmp/mn-bun.txt 2>&1; tail -5 /tmp/mn-bun.txt
npm run test:node > /tmp/mn-node.txt 2>&1; tail -5 /tmp/mn-node.txt
bun run typecheck && bun run depcheck
```

Expected: typecheck 0、depcheck 0 error;两套测试全绿。已知会在整套负载下偶发 20 秒超时的 `src/daemon/settings-panel-workbench.test.ts`,若出现须单独跑该文件 3 次都过才算负载抖动,并在提交说明里写明。

- [ ] **Step 3: 提交文档**

```bash
git add docs
git commit -m "文档:每晚整理长期记忆(B)上线,记入全景导图与路线图

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: 真机(owner 点头才做)**

部署会重启 daemon、断开桌面 app,先问 owner。同意后:

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy
wechat-cc memory nightly --now --json
```

把返回的改动清单和生成的 `~/.claude/channels/wechat/memory/<主人>/memory.md` 给 owner 过目(不要把内容贴进公开位置)。owner 认可后才算完成;不认可就先 `wechat-cc` 配置里把 `companion.memory_nightly_enabled` 关掉再修。第一晚之后核对早上那条消息。
