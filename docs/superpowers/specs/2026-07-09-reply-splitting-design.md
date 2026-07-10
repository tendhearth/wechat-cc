# Design: reply splitting (主动拆分) + chat-prefs seed

Date: 2026-07-09
Status: approved design → writing-plans next
Roadmap: Phase 1b (+ the minimal seed of Phase 1a). See `docs/design/roadmap.md`, `docs/design/companion-liveness-layer.md`.

## 1. Motivation

A real person on WeChat sends 2–3 short bubbles, not one wall of text. Today every
agent reply arrives as a single block — instantly bot-like. Splitting replies into
a few naturally-paced messages is the cheapest, zero-dependency 活人感 win, and it
forces the first per-user settings dial into existence (the 钥匙 that later
liveness features hang off).

## 2. Scope decisions (locked)

- **Split exactly ONE path:** `POST /v1/wechat/reply` (routes.ts), and only when
  `maybePrefix` left the text unchanged (no `[Claude]`-style display prefix).
  Prefixed sends (parallel / chatroom) go out as a single message — splitting
  them would drop attribution from chunks 2+.
- **Everything else untouched:** `reply_voice`, `send_file`, `edit_message`,
  `broadcast`, companion proactive pushes (`ilink.sendMessage` paths),
  mode-command/system notices, onboarding. System messages should feel like
  system; proactive-path splitting waits for the calibration engine (Phase 2).
- **Transport-transparent to the agent:** no prompt changes; the agent calls
  `reply` once and doesn't know it was split. `replyToolCalled` /
  `REPLY_TOOLS` detection unchanged.
- **Per-chat toggle, default ON.** Anyone can turn their own chat off
  (`/set split off`). Rationale: liveness is the point of the feature; presence
  level is a per-user dial, not universal restraint. (Conservative alternative —
  default off, admin opt-in — rejected: nobody discovers it.)
- **No new LLM calls.** Splitting is pure string logic. (Cost invariant.)

## 3. `splitReply` — pure function

`src/daemon/reply-split.ts` (new):

```ts
splitReply(text: string, opts?: { maxChunks?: number; minLen?: number }): string[]
```

Algorithm (deterministic, unit-testable):
1. **Atomic units:** fenced code blocks (``` … ```) are never split internally.
2. **No-split fast path:** `text.length < minLen` (default ~100 chars) → `[text]`.
3. **Boundaries, in priority order:** blank lines (paragraph breaks) → sentence
   terminators `。！？!?` and single newlines. **Never a bare `.`** (URLs,
   decimals, file paths stay intact).
4. **Packing:** greedily pack segments into at most `maxChunks` (default 3)
   chunks of roughly even size; merge any tiny chunk (<10 chars) into its
   neighbor. 1 resulting chunk → return `[text]` (no behavior change).
5. Chunks preserve original text verbatim (only the boundary whitespace/newline
   between chunks is consumed); `chunks.join` semantics never rewrite content.

## 4. Integration — the reply route

In `'POST /v1/wechat/reply'` (routes.ts):

```
prefixed = maybePrefix(chat_id, text, participant_tag)
if (prefixed !== text)            → single send (unchanged, today's behavior)
else if (!prefs(chat_id).split)   → single send
else:
  chunks = splitReply(text)
  for each chunk (sequentially):
    await ilink.sendReply(chat_id, chunk)
    if not last: await sleep(pace(chunk))
  return { ok: true, msg_id: <last chunk's msgId> }
```

- **Pacing:** `pace(chunk) = clamp(chunk.length × 30ms, 600ms, 2000ms)` —
  loosely simulates typing. Total added latency ≤ ~4s (well under the 10-min
  turn watchdog; the TYPING keepalive middleware continues firing meanwhile,
  which reads naturally). `sleep` is an injectable dep so tests use a fake.
- **Return shape preserved** (`{ok, msg_id}` / `{ok:false, error}`): callers'
  mental model doesn't shift. `msg_id` = the **last** chunk's (the freshest
  bubble; documented decision — a later `edit_message` targets that one).
- **Mid-sequence failure:** stop remaining chunks, return
  `{ ok: false, error, sent: <n> }` (the extra `sent` field tells the agent
  partial delivery happened). Log via the route's existing log dep.
- **Ordering:** sends are awaited sequentially inside one handler invocation —
  per-call order guaranteed. Concurrent `reply` calls for the same chat are
  already rare (turns are serialized per chat); accepted as-is.

## 5. Chat-prefs seed (Phase 1a minimal)

- **Store:** `src/daemon/chat-prefs.ts` — `makeStateStore('chat_prefs.json',
  { debounceMs: 0 })` (write-through, per architecture-conventions #5).
  Shape: `{ [chatId]: { split?: boolean } }`. Accessors:
  `getChatPrefs(chatId): ChatPrefs` (missing → `{}`; `split` undefined ⇒ ON),
  `setChatPref(chatId, patch)`.
- **Command:** extend `mode-commands.ts` (slash word `set` is unclaimed):
  - `/set` → show this chat's current prefs + available keys.
  - `/set split on|off`(同义词 `拆分`)→ toggle for THIS chat; any user may
    set their own chat (same policy as mode commands — per-chat preference,
    not a system-wide change). Reply confirms new state.
  - Unknown key/value → helpful error listing valid keys.
- **Wiring:** routes deps gain `getChatPrefs` thunk; mode-commands deps gain
  get + set. Built once in wiring (pipeline-deps / bootstrap) from the store.
- This store is THE settings substrate later features read (sticker frequency,
  proactive level, persona seed…) — keys are added per feature, no schema
  ceremony now.

## 6. Testing (TDD)

- `splitReply` unit table: short text no-split; paragraph split; sentence-pack
  to maxChunks; code fence atomic; URL with dots never split mid-URL; tiny
  chunk merged; CJK + English sentence terminators; verbatim-content property
  (concatenation ≈ original modulo consumed boundary whitespace).
- Route integration (fake ilink + fake sleep): prefs on → n ordered sends with
  paced sleeps + last msg_id returned; prefs off → 1 send; prefixed → 1 send;
  mid-sequence failure → stops, `{ok:false, sent}`; short text → 1 send.
- `/set` command tests: show, toggle on/off, 拆分 alias, unknown key error,
  persistence via store fake.
- Full suite + tsc green.

## 7. Non-goals (v1)

- Natural-language settings ("少发点表情") — Phase 1a full; `/set` only for now.
- Calibration engine / splitting proactive-companion or chatroom sends (Phase 2+).
- Ephemeral web settings page (NAT reachability open question).
- Agent-side control ("don't split this one") — transport stays transparent.
- Admin editing OTHER chats' prefs.

## 8. Open items for planning

- Exact `maybePrefix` visibility in the handler (it's computed in routes.ts
  already — reuse, don't recompute).
- Where wiring constructs the store (pipeline-deps vs bootstrap) — follow
  whichever already owns routes deps construction.
- e2e harness: does `dispatch-solo` e2e assert a single sendmessage? If so,
  those tests must set `split off` or expect chunks (check during planning).
