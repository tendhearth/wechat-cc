# Reply Splitting (主动拆分) + Chat-Prefs Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-prefixed agent replies go out as 2–3 human-paced WeChat bubbles instead of one wall of text, controlled by a per-chat `/set split on|off` preference (the first dial of the settings layer).

**Architecture:** A pure `splitReply()` function + a small loop inside the existing `POST /v1/wechat/reply` handler. A new `chat-prefs` store (write-through state-store) feeds both the route (read) and a new `/set` command in mode-commands (read+write). Transport-transparent to the agent; missing `getChatPrefs` dep ⇒ splitting disabled (all existing tests/embedded contexts keep today's behavior).

**Tech Stack:** TypeScript, vitest via `bun --bun vitest run <file>`, existing `src/daemon/state-store.ts` (string→string KV with `debounceMs:0` write-through).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-reply-splitting-design.md`. Key invariants:
  - Split ONLY `POST /v1/wechat/reply` and ONLY when `maybePrefix` returned the text unchanged. Prefixed sends, `reply_voice`, `send_file`, `edit_message`, `broadcast`, companion pushes, system notices: untouched.
  - Sentence boundaries are `。！？!?` and newline — **never a bare `.`** (URLs/decimals/paths stay intact). Fenced code blocks (``` … ```) are atomic.
  - Max 3 chunks; text `< 100` chars never splits; tiny chunks (<10 visible chars) merge into the previous chunk.
  - Pacing between chunks: `clamp(chunkLen × 30ms, 600ms, 2000ms)`, via an injectable `sleepMs` dep (tests use a fake — NEVER real timers in tests).
  - Return shape stays `{ok:true, msg_id}` (msg_id = LAST chunk's) / `{ok:false, error}`; mid-sequence failure adds `sent: <n>` when n>0.
  - **Absent `getChatPrefs` dep ⇒ splitting disabled** (backwards compatible); wired + pref unset ⇒ **default ON**; `split:false` ⇒ off.
  - No new LLM calls; no prompt changes; `replyToolCalled` detection unchanged.
- TDD every task: failing test → watch it fail → implement → pass → commit.
- Explicit `git add <files>` only (the working tree may hold unrelated WIP — never `git add -A`).
- Run `bunx tsc --noEmit` before each commit; keep it clean.

---

## File Structure

- Create `src/daemon/reply-split.ts` — `splitReply()` + `paceMs()` (pure, no deps).
- Create `src/daemon/reply-split.test.ts`.
- Create `src/daemon/chat-prefs.ts` — `makeChatPrefs(stateDir)` over `makeStateStore`.
- Create `src/daemon/chat-prefs.test.ts`.
- Modify `src/daemon/internal-api/types.ts` — add `getChatPrefs?`, `sleepMs?` to `InternalApiDeps`.
- Modify `src/daemon/internal-api/routes.ts` — reply handler split loop.
- Modify `src/daemon/internal-api.test.ts` — route split tests.
- Modify `src/daemon/mode-commands.ts` + `src/daemon/mode-commands.test.ts` — `/set` command.
- Modify `src/daemon/main.ts` (+ the `buildPipelineDeps` call site in `src/daemon/wiring/pipeline-deps.ts`) — wiring.

---

### Task 1: `splitReply` pure function

**Files:**
- Create: `src/daemon/reply-split.ts`
- Test: `src/daemon/reply-split.test.ts`

**Interfaces:**
- Produces: `splitReply(text: string, opts?: { maxChunks?: number; minLen?: number }): string[]` and `paceMs(chunk: string): number`. Later tasks import both from `'../reply-split'` (routes) — exact names matter.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { splitReply, paceMs } from './reply-split'

describe('splitReply', () => {
  it('returns short text unsplit', () => {
    expect(splitReply('好的,收到!')).toEqual(['好的,收到!'])
  })

  it('splits on paragraph breaks into at most 3 chunks', () => {
    const p = '第一段的内容,这里说明第一件事情,补充一点细节让它足够长一些。'
    const text = `${p}\n\n${p}\n\n${p}\n\n${p}`
    const chunks = splitReply(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.length).toBeLessThanOrEqual(3)
    // verbatim-content property: rejoining loses only boundary whitespace
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })

  it('splits a long single paragraph at sentence terminators, never at a bare dot', () => {
    const text = '这是第一句话,讲了很多细节!然后是第二句,参考 https://example.com/a.b.c 这个链接。最后一句做个总结,希望对你有帮助。'
    const chunks = splitReply(text, { minLen: 30 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // the URL survives intact in exactly one chunk
    const holding = chunks.filter(c => c.includes('https://example.com/a.b.c'))
    expect(holding).toHaveLength(1)
  })

  it('keeps fenced code blocks atomic', () => {
    const code = '```ts\nconst x = 1\nconst y = 2\n```'
    const text = `看这段代码,它演示了变量定义的写法,注意常量的用法。\n\n${code}\n\n以上就是全部内容了,有问题随时问我。`
    const chunks = splitReply(text, { minLen: 30 })
    const holding = chunks.filter(c => c.includes('const x = 1'))
    expect(holding).toHaveLength(1)
    expect(holding[0]).toContain('```ts')
    expect(holding[0]).toContain('\n```')
  })

  it('merges tiny trailing chunks instead of sending a 3-char bubble', () => {
    const text = `这一段足够长,包含了很多内容和细节,目的是让拆分逻辑生效并产生多个块。\n\n好。`
    const chunks = splitReply(text, { minLen: 30 })
    // '好。' (<10 chars) must not be its own chunk
    for (const c of chunks) expect(c.trim().length).toBeGreaterThanOrEqual(10)
  })

  it('maxChunks=1 or single unit returns the original', () => {
    const long = 'x'.repeat(300)
    expect(splitReply(long, { maxChunks: 1 })).toEqual([long])
    expect(splitReply(long)).toEqual([long]) // no boundaries at all → unsplit
  })
})

describe('paceMs', () => {
  it('clamps to [600, 2000]', () => {
    expect(paceMs('短')).toBe(600)
    expect(paceMs('x'.repeat(40))).toBe(1200)
    expect(paceMs('x'.repeat(500))).toBe(2000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/reply-split.test.ts`
Expected: FAIL — module `./reply-split` not found.

- [ ] **Step 3: Implement `src/daemon/reply-split.ts`**

```ts
/**
 * reply-split — pure splitting of an outbound reply into 2-3 human-feeling
 * WeChat bubbles (活人感, Phase 1b). No LLM, no I/O; boundaries are paragraph
 * breaks then sentence terminators 。！？!? and newlines — NEVER a bare '.'
 * (URLs / decimals / file paths stay intact). Fenced code blocks are atomic.
 * See docs/superpowers/specs/2026-07-09-reply-splitting-design.md.
 */

export interface SplitOpts {
  maxChunks?: number
  minLen?: number
}

/** Pacing between chunks: loosely simulates typing. */
export function paceMs(chunk: string): number {
  return Math.min(2000, Math.max(600, chunk.length * 30))
}

const MIN_CHUNK_VISIBLE = 10

export function splitReply(text: string, opts?: SplitOpts): string[] {
  const maxChunks = Math.max(1, opts?.maxChunks ?? 3)
  const minLen = opts?.minLen ?? 100
  if (maxChunks === 1 || text.length < minLen) return [text]

  // ── units over [start,end) ranges of the ORIGINAL string (verbatim chunks) ──
  type Unit = { start: number; end: number; atomic: boolean }
  const units: Unit[] = []
  const pushPlainParagraphs = (s: number, e: number): void => {
    const slice = text.slice(s, e)
    let last = 0
    for (const m of slice.matchAll(/\n[ \t]*\n+/g)) {
      if (m.index! > last) units.push({ start: s + last, end: s + m.index!, atomic: false })
      last = m.index! + m[0].length
    }
    if (last < slice.length) units.push({ start: s + last, end: s + slice.length, atomic: false })
  }
  // Fenced code blocks are atomic; an unterminated fence swallows to the end.
  let cursor = 0
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    if (m.index! > cursor) pushPlainParagraphs(cursor, m.index!)
    units.push({ start: m.index!, end: m.index! + m[0].length, atomic: true })
    cursor = m.index! + m[0].length
  }
  if (cursor < text.length) pushPlainParagraphs(cursor, text.length)

  // No paragraph structure → refine the single plain unit at sentence bounds.
  if (units.length < 2) {
    const only = units[0]
    if (!only || only.atomic) return [text]
    const refined: Unit[] = []
    const slice = text.slice(only.start, only.end)
    let last = 0
    for (const m of slice.matchAll(/[。！？!?]+|\n/g)) {
      const cut = m[0] === '\n' ? m.index! : m.index! + m[0].length
      if (cut > last) refined.push({ start: only.start + last, end: only.start + cut, atomic: false })
      last = m.index! + m[0].length
    }
    if (last < slice.length) refined.push({ start: only.start + last, end: only.start + slice.length, atomic: false })
    if (refined.length < 2) return [text]
    units.length = 0
    units.push(...refined)
  }

  // ── greedy pack into ≤ maxChunks, roughly even by length ──
  const target = Math.ceil(text.length / maxChunks)
  const ranges: { start: number; end: number }[] = []
  let curStart = units[0]!.start
  let curLen = 0
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!
    curLen += u.end - u.start
    const isLast = i === units.length - 1
    if (isLast || (curLen >= target && ranges.length < maxChunks - 1)) {
      ranges.push({ start: curStart, end: u.end })
      if (!isLast) { curStart = units[i + 1]!.start; curLen = 0 }
    }
  }

  // Merge tiny chunks into the previous one (no 3-char bubbles).
  const merged: { start: number; end: number }[] = []
  for (const r of ranges) {
    if (text.slice(r.start, r.end).trim().length < MIN_CHUNK_VISIBLE && merged.length > 0) {
      merged[merged.length - 1]!.end = r.end
    } else {
      merged.push({ ...r })
    }
  }

  if (merged.length < 2) return [text]
  return merged.map(r => text.slice(r.start, r.end).trim()).filter(c => c.length > 0)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/daemon/reply-split.test.ts`
Expected: PASS (7 tests). If a boundary test fails, fix the implementation — do NOT weaken the URL / code-fence / tiny-chunk assertions.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/reply-split.ts src/daemon/reply-split.test.ts
git commit -m "feat(liveness): splitReply — paragraph/sentence chunking, code fences atomic, never bare-dot"
```

---

### Task 2: chat-prefs store

**Files:**
- Create: `src/daemon/chat-prefs.ts`
- Test: `src/daemon/chat-prefs.test.ts`

**Interfaces:**
- Consumes: `makeStateStore(filePath, {debounceMs})` from `./state-store` (string→string KV: `get/set/delete/all/flush`).
- Produces (later tasks depend on these exact names):
  - `interface ChatPrefs { split?: boolean }`
  - `interface ChatPrefsStore { get(chatId: string): ChatPrefs; set(chatId: string, patch: Partial<ChatPrefs>): ChatPrefs }`
  - `makeChatPrefs(stateDir: string, deps?: { store?: StateStore }): ChatPrefsStore` — file lives at `<stateDir>/chat_prefs.json`, write-through (`debounceMs: 0`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeChatPrefs } from './chat-prefs'

describe('chat-prefs', () => {
  it('returns {} for an unknown chat (split undefined ⇒ caller treats as ON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      expect(makeChatPrefs(dir).get('nobody')).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('set() patches, persists write-through, and get() round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      expect(prefs.set('c1', { split: false })).toEqual({ split: false })
      expect(prefs.get('c1')).toEqual({ split: false })
      // write-through: a FRESH instance reads it back from disk
      expect(makeChatPrefs(dir).get('c1')).toEqual({ split: false })
      expect(readFileSync(join(dir, 'chat_prefs.json'), 'utf8')).toContain('c1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives a corrupt value (falls back to {})', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      prefs.set('c1', { split: true })
      // corrupt via the injectable raw store seam
      const prefs2 = makeChatPrefs(dir, { store: { get: () => 'not json', set: () => {}, delete: () => {}, all: () => ({}), flush: async () => {} } })
      expect(prefs2.get('c1')).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/chat-prefs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/daemon/chat-prefs.ts`**

```ts
/**
 * chat-prefs — per-chat preference store, the settings substrate liveness
 * features read (first key: reply splitting; later: sticker frequency,
 * proactive level, persona…). Write-through (debounceMs:0) per
 * architecture-conventions #5: low-frequency critical state survives kill -9.
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from './state-store'

export interface ChatPrefs {
  /** Reply splitting (活人感 bubbles). undefined ⇒ ON (default); false ⇒ off. */
  split?: boolean
}

export interface ChatPrefsStore {
  get(chatId: string): ChatPrefs
  set(chatId: string, patch: Partial<ChatPrefs>): ChatPrefs
}

export function makeChatPrefs(stateDir: string, deps?: { store?: StateStore }): ChatPrefsStore {
  const store = deps?.store ?? makeStateStore(join(stateDir, 'chat_prefs.json'), { debounceMs: 0 })
  const read = (chatId: string): ChatPrefs => {
    const raw = store.get(chatId)
    if (!raw) return {}
    try {
      const p = JSON.parse(raw) as unknown
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as ChatPrefs) : {}
    } catch {
      return {}
    }
  }
  return {
    get: read,
    set(chatId, patch) {
      const next = { ...read(chatId), ...patch }
      store.set(chatId, JSON.stringify(next))
      return next
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/daemon/chat-prefs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/chat-prefs.ts src/daemon/chat-prefs.test.ts
git commit -m "feat(liveness): chat-prefs store — per-chat settings substrate (write-through)"
```

---

### Task 3: route integration — split the reply send

**Files:**
- Modify: `src/daemon/internal-api/types.ts` (add two optional deps to `InternalApiDeps`)
- Modify: `src/daemon/internal-api/routes.ts` (reply handler, ~line 259)
- Test: `src/daemon/internal-api.test.ts` (append a describe; the existing reply-route test pattern is at ~line 1095-1160 — reuse its fixture style)

**Interfaces:**
- Consumes: `splitReply`, `paceMs` from `'../reply-split'` (Task 1). `ChatPrefs` shape `{split?: boolean}` (Task 2 — but the dep is a plain function type, no import needed).
- Produces: `InternalApiDeps` gains:
  ```ts
  /** Per-chat prefs read for reply splitting. ABSENT ⇒ splitting disabled
   *  (tests/embedded keep single-send behavior). Wired ⇒ split defaults ON
   *  unless the chat set split:false. */
  getChatPrefs?: (chatId: string) => { split?: boolean }
  /** Injectable sleep for chunk pacing; absent ⇒ real setTimeout. */
  sleepMs?: (ms: number) => Promise<void>
  ```

- [ ] **Step 1: Write the failing tests** (append to `src/daemon/internal-api.test.ts`, mirroring the existing reply-route fixture at ~1130: construct deps with a `sendReply` vi.fn and POST to `/v1/wechat/reply`; add `getChatPrefs` + a fake `sleepMs` that records delays)

```ts
describe('POST /v1/wechat/reply — splitting (活人感)', () => {
  const LONG = `第一段说明这个问题的背景,内容足够长,细节丰富,超过最小长度阈值。\n\n第二段给出结论和建议,也同样足够长,保证会被拆成多条发送。`

  it('splits an un-prefixed reply into ordered chunks with paced sleeps; msg_id is the LAST chunk', async () => {
    const sent: string[] = []
    const delays: number[] = []
    let n = 0
    const sendReply = vi.fn(async (_c: string, text: string) => { sent.push(text); n++; return { msgId: `m-${n}` } })
    // build deps exactly like the existing reply-route tests, plus:
    //   getChatPrefs: () => ({}),  sleepMs: async (ms) => { delays.push(ms) }
    // POST {chat_id:'c@bot', text: LONG} (no participant_tag → un-prefixed)
    // EXPECT: sendReply called ≥2 times; sent.join preserves content order;
    //         body {ok:true, msg_id:`m-${n}`}; delays.length === n-1; every delay in [600,2000]
  })

  it('split:false pref → single send with the full text', async () => {
    // getChatPrefs: () => ({ split: false }) → sendReply called once with LONG
  })

  it('absent getChatPrefs dep → single send (backwards compatible)', async () => {
    // no getChatPrefs in deps → sendReply called once with LONG
  })

  it('prefixed reply (participant_tag in a multi-participant mode) → single send', async () => {
    // reuse the existing prefix fixture (conversationStore mode) so maybePrefix
    // returns a prefixed string → sendReply once, even with getChatPrefs wired
  })

  it('mid-sequence failure stops and reports sent count', async () => {
    // sendReply: 1st ok, 2nd returns {msgId:'',error:'boom'}
    // EXPECT body {ok:false, error:'boom', sent:1}; no 3rd call
  })
})
```

(The skeleton comments above MUST be turned into real code by copying the deps-construction of the existing `'POST /v1/wechat/reply'` tests in this file — same helper, same request shape. Do not invent a new fixture style.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun --bun vitest run src/daemon/internal-api.test.ts -t 'splitting'`
Expected: FAIL (multiple sends never happen; `sent` field missing).

- [ ] **Step 3: Implement**

`types.ts`: add the two optional fields shown in **Interfaces** to `InternalApiDeps`.

`routes.ts`: import `{ splitReply, paceMs }` from `'../reply-split'`, add a module-level default sleep, and replace the reply handler body:

```ts
const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
```

```ts
    'POST /v1/wechat/reply': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const { chat_id, text, participant_tag } = body as WechatReplyRequestT
      const prefixed = maybePrefix(chat_id, text, participant_tag)
      // Reply splitting (活人感, spec 2026-07-09): only un-prefixed replies —
      // chunks 2+ of a prefixed send would lose their [Display] attribution.
      // Absent getChatPrefs dep ⇒ disabled (tests/embedded unchanged);
      // wired ⇒ default ON unless this chat set split:false.
      const prefs = prefixed === text ? deps.getChatPrefs?.(chat_id) : undefined
      const chunks = prefs !== undefined && prefs.split !== false ? splitReply(text) : [prefixed]
      const sleep = deps.sleepMs ?? defaultSleep
      let sentCount = 0
      try {
        let lastMsgId = ''
        for (let i = 0; i < chunks.length; i++) {
          const r = await deps.ilink.sendReply(chat_id, chunks[i]!)
          if (r.error) {
            return { status: 200, body: { ok: false, error: r.error, ...(sentCount > 0 ? { sent: sentCount } : {}) } }
          }
          sentCount++
          lastMsgId = r.msgId
          if (i < chunks.length - 1) await sleep(paceMs(chunks[i]!))
        }
        return { status: 200, body: { ok: true, msg_id: lastMsgId } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err), ...(sentCount > 0 ? { sent: sentCount } : {}) } }
      }
    },
```

- [ ] **Step 4: Run the new tests AND the whole internal-api suite**

Run: `bun --bun vitest run src/daemon/internal-api.test.ts`
Expected: ALL pass — the pre-existing reply tests (single send, `'hi'`) must still pass untouched because they don't wire `getChatPrefs`.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/daemon/internal-api/types.ts src/daemon/internal-api/routes.ts src/daemon/internal-api.test.ts
git commit -m "feat(liveness): reply route splits un-prefixed replies into paced bubbles"
```

---

### Task 4: `/set` command

**Files:**
- Modify: `src/daemon/mode-commands.ts`
- Test: `src/daemon/mode-commands.test.ts`

**Interfaces:**
- Consumes: `ChatPrefsStore`-shaped dep (structural type, no import needed).
- Produces: `ModeCommandsDeps` gains:
  ```ts
  /** Per-chat prefs (chat-prefs store). /set reads+writes THIS chat's entry. */
  chatPrefs: { get(chatId: string): { split?: boolean }; set(chatId: string, patch: { split?: boolean }): { split?: boolean } }
  ```
  New command: `/set` (show), `/set split on|off` (also `拆分` / `开`/`关`). Any user, own chat only — same policy as mode commands.

- [ ] **Step 1: Write the failing tests** (append to mode-commands.test.ts; FIRST update the `setup()` helper to provide `chatPrefs` — mirror how `pinModel` was added: a vi.fn-backed in-memory fake, returned from setup for assertions)

```ts
// in setup():
//   const prefsData = new Map<string, { split?: boolean }>()
//   const chatPrefs = {
//     get: (c: string) => prefsData.get(c) ?? {},
//     set: (c: string, p: { split?: boolean }) => { const n = { ...(prefsData.get(c) ?? {}), ...p }; prefsData.set(c, n); return n },
//   }
// pass into makeModeCommands deps; return { ..., chatPrefs, prefsData }

it('/set shows current prefs for this chat', async () => {
  const { cmds, sentMessages } = setup()
  expect(await cmds.handle(inbound('/set'))).toBe(true)
  expect(sentMessages[0]?.[1]).toContain('split')
  expect(sentMessages[0]?.[1]).toContain('on') // default ON when unset
})

it('/set split off persists and confirms', async () => {
  const { cmds, sentMessages, prefsData } = setup()
  expect(await cmds.handle(inbound('/set split off'))).toBe(true)
  expect(prefsData.get('chat-1')).toEqual({ split: false })
  expect(sentMessages[0]?.[1]).toContain('关闭')
})

it('/set 拆分 开 (Chinese alias) turns it on', async () => {
  const { cmds, prefsData } = setup()
  await cmds.handle(inbound('/set 拆分 开'))
  expect(prefsData.get('chat-1')).toEqual({ split: true })
})

it('/set with an unknown key replies usage, does not write', async () => {
  const { cmds, sentMessages, prefsData } = setup()
  await cmds.handle(inbound('/set volume 11'))
  expect(prefsData.size).toBe(0)
  expect(sentMessages[0]?.[1]).toContain('split')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run src/daemon/mode-commands.test.ts`
Expected: new tests FAIL (`/set` unrecognized → handler returns… check: unknown slash words — the existing code replies "可用命令" or passes through; either way assertions fail). Also compile error until deps updated — fine.

- [ ] **Step 3: Implement in `mode-commands.ts`**

1. Add `chatPrefs` to `ModeCommandsDeps` (exact shape in Interfaces above).
2. In the command dispatch (after the provider-command block, alongside `/name`/`/whoami` style handlers), add:

```ts
      // /set — per-chat preferences (the settings layer's first dial).
      if (slashWord.toLowerCase() === 'set') {
        const p = deps.chatPrefs.get(msg.chatId)
        if (tail === '') {
          const state = p.split === false ? 'off' : 'on'
          await reply(msg.chatId, `当前设置(本对话):\n· split(拆分回复): ${state}\n\n用法: /set split on|off — 回复像真人一样分几条发`)
          return true
        }
        const m2 = /^(split|拆分)\s+(on|off|开|关)$/i.exec(tail)
        if (!m2) {
          await reply(msg.chatId, '❓ 不认识这个设置。目前支持: /set split on|off(别名: 拆分 开|关)')
          return true
        }
        const on = /^(on|开)$/i.test(m2[2]!)
        deps.chatPrefs.set(msg.chatId, { split: on })
        await reply(msg.chatId, on
          ? '✅ 拆分回复已开启——回复会像真人一样分几条发。'
          : '✅ 拆分回复已关闭——每次回复只发一条。')
        deps.log('MODE_CMD', `chat=${msg.chatId} /set split=${on}`)
        return true
      }
```

3. Add one line to the `/help` text (the `handleHelp` lines array, near the 模式切换 section):
```ts
      '/set — 本对话偏好(拆分回复等)',
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/daemon/mode-commands.test.ts`
Expected: ALL pass (existing 53+ plus the 4 new).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` — this will now FAIL anywhere `makeModeCommands` is constructed without `chatPrefs` (pipeline-deps.ts). Add a TEMPORARY minimal wiring there (`chatPrefs: makeChatPrefs(stateDir)`) — Task 5 finalizes sharing; if `stateDir` is in scope in pipeline-deps (it is, see `pinModel`), this construction is actually already correct and Task 5 only reconciles the routes side. Then:
```bash
git add src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts src/daemon/wiring/pipeline-deps.ts
git commit -m "feat(liveness): /set command — per-chat split toggle (settings layer seed)"
```

---

### Task 5: wiring — ONE shared store for routes + commands; full verification

**Files:**
- Modify: `src/daemon/main.ts` (construct `makeChatPrefs(stateDir)` once; pass `getChatPrefs` into `registerInternalApi`; thread the same instance into the pipeline-deps construction)
- Modify: `src/daemon/wiring/pipeline-deps.ts` (accept the shared instance via `PipelineDepsOpts` instead of constructing its own — replace Task 4's temporary local construction)

**Interfaces:**
- Consumes: `makeChatPrefs` (Task 2); `InternalApiDeps.getChatPrefs` (Task 3); `ModeCommandsDeps.chatPrefs` (Task 4).
- Produces: exactly ONE `ChatPrefsStore` instance per daemon (a second instance would have a stale in-memory cache — the write-through only protects writes, not cross-instance reads).

- [ ] **Step 1: Wire main.ts**

Find `registerInternalApi({ stateDir, ... })` (~line 151). Before it:
```ts
  const chatPrefs = makeChatPrefs(stateDir)
```
Add to the deps object:
```ts
      getChatPrefs: (c) => chatPrefs.get(c),
```
Then locate where `buildPipelineDeps(opts, refs)` is invoked (grep `buildPipelineDeps(`; it may be main.ts or a lifecycle module) and add `chatPrefs` to its `opts`; extend `PipelineDepsOpts` with `chatPrefs: ChatPrefsStore` and replace Task 4's temporary `makeChatPrefs(stateDir)` inside pipeline-deps with `opts.chatPrefs`.

- [ ] **Step 2: Typecheck + full test suite**

Run: `bunx tsc --noEmit` → clean.
Run: `bun --bun vitest run` (full suite)
Expected: green, modulo any PRE-EXISTING unrelated failures — verify any failure also fails on the base commit via `git stash` before dismissing it. The existing e2e fake replies are all <100 chars so splitting (default ON, now wired) must not change their behavior; if any e2e/harness test DOES break on chunk counts, fix by setting that chat's pref `split:false` in the harness — never by weakening the split tests.

- [ ] **Step 3: e2e suite explicitly** (splitting is wired in main.ts, which the e2e harness boots)

Run: `bun --bun vitest run -c vitest.e2e.config.ts`
Expected: all pass (same reasoning: short fake replies never split).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts src/daemon/wiring/pipeline-deps.ts
git commit -m "feat(liveness): wire shared chat-prefs into reply route + /set command"
```

---

## Self-Review notes (author)

- **Spec coverage:** §3 splitReply → Task 1 (incl. never-bare-dot, fences, tiny-merge, minLen, maxChunks); §4 route integration → Task 3 (pacing clamp, last-msg-id, `sent` on partial failure, prefixed bypass, absent-dep bypass, injectable sleep); §5 chat-prefs + `/set` → Tasks 2+4 (default ON = unset, `拆分` alias, per-own-chat policy, help line); §2 non-touch list → enforced by only editing the one handler; §8 open items → Task 3 reuses in-file `maybePrefix` fixture, Task 5 resolves wiring location + e2e check.
- **Type consistency:** `ChatPrefsStore.get/set` used structurally in routes (function dep) and mode-commands (object dep) — names match Task 2's exports. `splitReply`/`paceMs` import path `'../reply-split'` from `internal-api/routes.ts` (routes.ts is in `src/daemon/internal-api/`, reply-split in `src/daemon/`) — correct relative path.
- **Known risk, mitigated:** Task 4 temporarily constructs a second store in pipeline-deps to keep tsc green mid-plan; Task 5 replaces it with the shared instance. The window is one commit and only affects a daemon built from that commit.
- **No placeholders** beyond Task 3 Step 1's explicitly-flagged instruction to copy the existing fixture style (the file's own pattern is the source of truth; inventing it here would drift).
