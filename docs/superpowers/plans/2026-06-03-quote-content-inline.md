# Quote-Content Inline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a WeChat user quotes/replies to an earlier message, surface the **full** quoted content to the agent as a structured `<quote>` element in the prompt, replacing today's truncated `[引用: …]` body snippet and the meaningless `quote_to="<id>"` attribute.

**Architecture:** ilink's inbound payload already carries the quoted message inline in `item.ref_msg` (`message_item.text_item.text` = full text, `unsupported_item.text` = media fallback, `title` = short snippet) plus the quoted item's `type`. There is **no** stable quoted-message id and **no** message store, so a lookup tool/DB is infeasible and unnecessary — we just extract the richest available text + type during parsing and render it as `<quote type="…">…</quote>` inside the existing `<wechat>` envelope. No DB migration, no new MCP tool.

**Tech Stack:** TypeScript, Bun, vitest. Pure-function changes to `parseUpdates` (poll-loop) and `formatInbound` (prompt-format), plus one system-prompt doc line.

---

## Background — why this shape (read before starting)

Current behavior (the thing we're replacing):
- `src/daemon/poll-loop.ts:75-90` — on `item.ref_msg`, sets `quoteTo = item.msg_id` (this is the **current** item's id, not the quoted message's — useless as a lookup key) and pushes `[引用: <title ?? text>]` into the body, **preferring the short `title` over the fuller text** (truncation bug).
- `src/core/prompt-format.ts:8,32` — `InboundMsg.quoteTo?: string` is emitted as `quote_to="<id>"`. Nothing in the system prompt tells the agent what to do with it (`prompt-builder.ts` has zero mentions of quote), so it's dead.

Target behavior:
```xml
<wechat chat_id="u1" user="小白" user_id="u1" account="acct" msg_type="text" ts="2026-06-03T…">
<quote type="text">明天下午三点的会议改到周四了，地点也换成 B 栋 5 楼会议室，记得通知大家</quote>
收到，我转告一下
</wechat>
```
- The `quote` becomes a structured field `quote?: { type: string; text: string }` on `InboundMsg`.
- `quoteTo` is **removed** (only 5 references, all in these two files + their tests — see grep below).
- Text preference order changes to richest-first: `message_item.text_item.text` ?? `message_item.unsupported_item.text` ?? `title` ?? `''`.
- `type` is a human label derived from `message_item.type` (1=text … 5=video, else unknown).

Authoritative type source (the full ilink shape) — `src/lib/ilink.ts:46`:
```ts
ref_msg?: { title?: string; message_item?: { type?: number; text_item?: { text?: string }; unsupported_item?: { text?: string } } }
```
The local mirror in `poll-loop.ts:34` is **narrower** (`{ title?: string; message_item?: { text_item?: { text?: string } } }`) and must be widened to include `type` and `unsupported_item`.

Complete reference inventory (from grep `引用|quoteTo|quote_to|ref_msg`):
- `src/core/prompt-format.ts:8` (def), `:32` (render) — change here.
- `src/daemon/poll-loop.ts:34` (local type), `:75-90` (capture+body push), `:156` (spread into InboundMsg) — change here.
- `src/core/prompt-format.test.ts:36-43` — update test.
- `src/daemon/poll-loop.test.ts:54-67` — update test.
- `src/core/prompt-builder.ts:68` — envelope doc line; add `<quote>` mention.
- (Other `引用` hits in `chatroom-moderator.ts`, `handoff.ts`, `lifecycle.ts` are unrelated prose — do NOT touch.)

---

## File Structure

- **Modify** `src/core/prompt-format.ts` — `InboundMsg.quote` field replaces `quoteTo`; `formatInbound` renders `<quote>` and drops `quote_to`.
- **Modify** `src/daemon/poll-loop.ts` — widen local `ref_msg` type; extract structured `quote`; remove `[引用]` body push; add `quotedTypeLabel` helper.
- **Modify** `src/core/prompt-builder.ts` — one sentence documenting `<quote>` to the agent.
- **Modify** `src/core/prompt-format.test.ts`, `src/daemon/poll-loop.test.ts`, `src/core/prompt-builder.test.ts` — tests.

---

## Task 1: Structured `quote` field + `<quote>` rendering (prompt-format)

**Files:**
- Modify: `src/core/prompt-format.ts:8` (field), `:24-42` (formatInbound)
- Test: `src/core/prompt-format.test.ts:36-43`

- [ ] **Step 1: Rewrite the existing quote test to expect the structured `<quote>` element**

Replace the `it('includes quote reference when quoteTo set', …)` block (`src/core/prompt-format.test.ts:36-43`) with:

```ts
  it('renders full quoted content as a <quote> element', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '这条', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: '明天下午三点的会议改到周四了' },
    })
    expect(out).toContain('<quote type="text">明天下午三点的会议改到周四了</quote>')
    expect(out).not.toContain('quote_to')
  })

  it('escapes quote body and preserves newlines', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '回', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: 'a < b\nsecond line' },
    })
    expect(out).toContain('<quote type="text">a &lt; b\nsecond line</quote>')
  })

  it('omits <quote> entirely when no quote present', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<quote')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/core/prompt-format.test.ts`
Expected: FAIL — `quote` is not a property of `InboundMsg` (typecheck/compile error) and/or assertion failures on `<quote …>`.

- [ ] **Step 3: Replace the `quoteTo` field with the structured `quote` field**

In `src/core/prompt-format.ts`, replace line 8:
```ts
  quoteTo?: string
```
with:
```ts
  /**
   * A quoted/replied-to message, extracted inline from ilink's `ref_msg`.
   * ilink gives us the content (text or a media-type label), never a stable
   * id — so this is the actual quoted text, not a lookup key. Rendered as a
   * `<quote type="…">…</quote>` element inside the <wechat> envelope.
   */
  quote?: { type: string; text: string }
```

- [ ] **Step 4: Render `<quote>` in `formatInbound`; drop the `quote_to` attribute**

In `src/core/prompt-format.ts`, in `formatInbound`:

Remove the `quote_to` attribute line (currently `:32`) from the `attrs` array — delete this line:
```ts
    m.quoteTo ? `quote_to="${escAttr(m.quoteTo)}"` : '',
```
so the `attrs` array ends at `ts="…"`.

Then change the body assembly (currently `:40`) from:
```ts
  const body = [escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
```
to:
```ts
  const quoteEl = m.quote
    ? `<quote type="${escAttr(m.quote.type)}">${escBody(m.quote.text)}</quote>`
    : ''
  const body = [quoteEl, escBody(m.text), ...attachmentLines].filter(Boolean).join('\n')
```

(The `<quote>` line comes first so the agent reads the context before the user's new text.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test src/core/prompt-format.test.ts`
Expected: PASS (all three new cases green).

- [ ] **Step 6: Commit**

```bash
git add src/core/prompt-format.ts src/core/prompt-format.test.ts
git commit -m "feat(prompt): structured <quote> element replaces dead quote_to attr"
```

---

## Task 2: Extract structured quote during parsing (poll-loop)

**Files:**
- Modify: `src/daemon/poll-loop.ts:34` (local type), `:75-90` (capture), `:156` (spread), plus a new helper
- Test: `src/daemon/poll-loop.test.ts:54-67`

- [ ] **Step 1: Rewrite the `quoteTo` parse test for structured `quote` + richest-text preference**

Replace the `it('preserves quoteTo when ref_msg is present in an item', …)` block (`src/daemon/poll-loop.test.ts:54-67`) with:

```ts
  it('extracts full quoted text (prefers message_item text over title) + type', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          msg_id: 'cur-1',
          ref_msg: {
            title: '明天下午三点的会议…',                       // truncated snippet
            message_item: { type: 1, text_item: { text: '明天下午三点的会议改到周四了，记得通知大家' } },
          },
        },
        { type: 1, text_item: { text: 'this' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'text', text: '明天下午三点的会议改到周四了，记得通知大家' })
    // the quote no longer leaks into the body as [引用: …]
    expect(msg!.text).not.toContain('[引用')
    expect(msg!.text).toBe('this')
  })

  it('falls back to title then unsupported_item, labels non-text quote types', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          ref_msg: {
            title: '[图片]',
            message_item: { type: 2, unsupported_item: { text: '[图片]' } },
          },
        },
        { type: 1, text_item: { text: 'what is this' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'image', text: '[图片]' })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/daemon/poll-loop.test.ts`
Expected: FAIL — `msg.quote` is undefined (parser still sets `quoteTo`), and the `ref_msg.message_item.type` / `unsupported_item` fields aren't in the local type.

- [ ] **Step 3: Widen the local `ref_msg` type**

In `src/daemon/poll-loop.ts`, replace line 34:
```ts
  ref_msg?: { title?: string; message_item?: { text_item?: { text?: string } } }
```
with (mirrors the full ilink shape at `src/lib/ilink.ts:46`):
```ts
  ref_msg?: {
    title?: string
    message_item?: {
      type?: number
      text_item?: { text?: string }
      unsupported_item?: { text?: string }
    }
  }
```

- [ ] **Step 4: Add the `quotedTypeLabel` helper**

In `src/daemon/poll-loop.ts`, add this helper just above `export function parseUpdates` (i.e. before line 59):

```ts
/** Map an ilink item `type` (1=text … 5=video) to a human label for <quote>. */
function quotedTypeLabel(type?: number): string {
  switch (type) {
    case 1: return 'text'
    case 2: return 'image'
    case 3: return 'voice'
    case 4: return 'file'
    case 5: return 'video'
    default: return 'unknown'
  }
}
```

- [ ] **Step 5: Replace the capture logic and the InboundMsg spread**

In `src/daemon/poll-loop.ts`, change the declaration (currently `:75`) from:
```ts
    let quoteTo: string | undefined
```
to:
```ts
    let quote: InboundMsg['quote']
```

Replace the `ref_msg` handling block (currently `:78-90`) — the one that sets `quoteTo` and pushes `[引用: …]` into `textParts` — with:
```ts
      // Capture the first quoted message as structured content. ilink inlines
      // the quoted text in ref_msg (no stable id), richest field first.
      if (item.ref_msg) {
        if (!quote) {
          const ri = item.ref_msg.message_item
          const text = ri?.text_item?.text
            ?? ri?.unsupported_item?.text
            ?? item.ref_msg.title
            ?? ''
          quote = { type: quotedTypeLabel(ri?.type), text }
        }
      }
```

(Note: the `[引用: …]` / `[引用]` pushes into `textParts` are intentionally gone — the quote now lives in its own element, not the body.)

Then change the InboundMsg spread (currently `:156`) from:
```ts
      ...(quoteTo !== undefined ? { quoteTo } : {}),
```
to:
```ts
      ...(quote !== undefined ? { quote } : {}),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test src/daemon/poll-loop.test.ts`
Expected: PASS (both new cases green).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/poll-loop.ts src/daemon/poll-loop.test.ts
git commit -m "feat(poll): parse full quoted content into structured InboundMsg.quote"
```

---

## Task 3: Document `<quote>` in the system prompt

**Files:**
- Modify: `src/core/prompt-builder.ts:68-70` (baseChannelSection)
- Test: `src/core/prompt-builder.test.ts:14-19`

- [ ] **Step 1: Add a failing assertion that the prompt documents `<quote>`**

In `src/core/prompt-builder.test.ts`, inside the existing `it('includes the channel base section + reply tool guidance', …)` block (after line 18, before the closing `})`), add:
```ts
    expect(p).toContain('<quote')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/core/prompt-builder.test.ts`
Expected: FAIL — the prompt does not yet mention `<quote>`.

- [ ] **Step 3: Add the doc sentence to `baseChannelSection`**

In `src/core/prompt-builder.ts`, in `baseChannelSection`, insert a new bullet immediately after the media-attachments bullet (currently line 70, the `媒体附件以 …` line). Add this line right after it:
```ts
- 用户引用/回复某条历史消息时，被引用内容会以 \`<quote type="text|image|voice|file|...">被引用的原文</quote>\` 出现在该条消息体的开头。把它当作用户这次发言的上下文来理解。
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/core/prompt-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts
git commit -m "docs(prompt): tell the agent how to read the <quote> element"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `bun run typecheck`
Expected: exit 0, no errors. (Confirms no stray `quoteTo` reference survives — the compiler will flag any.)

- [ ] **Step 2: Run the full test suite**

Run: `bun run test`
Expected: all files pass (baseline before this work: 141 files / 2236 passed / 8 skipped — expect the same file count with the rewritten cases green).

- [ ] **Step 3: Grep for orphaned references**

Run: `grep -rn 'quoteTo\|quote_to' src/`
Expected: **no matches.** If any remain, they're dead references — remove them and re-run Steps 1-2.

- [ ] **Step 4: Commit any cleanup (only if Step 3 found something)**

```bash
git add -A
git commit -m "chore: remove orphaned quoteTo references"
```

---

## Self-Review notes (already applied)

- **Spec coverage:** Option A = "surface full quoted content as structured `<quote>`, drop dead `quote_to`." Task 1 (render) + Task 2 (extract richest text + type, stop leaking into body) + Task 3 (agent guidance) cover it. No DB / no MCP tool, per the chosen scope.
- **Type consistency:** the field is `quote?: { type: string; text: string }` everywhere — defined in Task 1 (prompt-format), produced in Task 2 (poll-loop via `InboundMsg['quote']`), referenced by the same name. `quotedTypeLabel` returns the exact label set asserted in Task 2's tests (`text`/`image`).
- **No placeholders:** every edit shows the literal before/after text and exact run commands.
