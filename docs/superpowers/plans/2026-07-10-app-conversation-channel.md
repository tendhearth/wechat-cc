# App Conversation Channel (voice arc — Stage 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can hold a real, memory-ful text conversation with their CC inside the desktop app — same session as the WeChat owner chat, replies delivered to the app not WeChat.

**Architecture:** Separate *session* (memory, = `default_chat_id`) from *channel* (reply delivery). A per-`chatId` **reply-sink** lets an app-driven turn capture the agent's `reply`-tool output instead of ilink-sending it. A new admin-tier `POST /v1/companion/converse` drives one real coordinator turn on the owner session with an app sink and returns the captured reply. A Tauri command proxies the webview to it; the app's read-only 对话 pane gains a compose box.

**Tech Stack:** daemon TypeScript (`src/`, vitest via `bun --bun vitest run`); Tauri Rust (`apps/desktop/src-tauri`, `cargo`); vanilla-JS webview (`apps/desktop/src`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-app-conversation-channel-design.md`. Key invariants:
  - **WeChat path byte-unchanged**: absent a registered reply-sink, `POST /v1/wechat/reply` behaves exactly as today (split/pace/ilink). Prove via strict tests.
  - **Same session**: app turns run on `default_chat_id`'s session (shared memory/persona/agenda). No separate app session.
  - **App gets the WHOLE reply** (no splitting/pacing — that's a WeChat 活人感 concern); the sink captures the raw pre-split reply text.
  - **No double-delivery**: an app turn never also ilink-sends to WeChat.
  - **admin-tier only** on the converse route; **at-most-one turn per session** (reuse the existing in-flight guard; concurrent ⇒ busy).
  - Route table must NOT import coordinator internals — reach the coordinator via a late-bound dep closure (mirror `setConversation`/`setDelegate` at `internal-api/types.ts:247-257`).
- TDD for daemon tasks; tsc clean; explicit `git add`. App (Rust/JS) tasks: `cargo build` + manual-verify (no JS test harness in `apps/desktop`).
- Licensing (spec §4): new `apps/desktop` files — default to repo parity (MIT) unless the owner sets a commercial license; flag, don't decide.

---

### Task 1: reply-sink registry + reply-route seam

**Files:** Create `src/daemon/reply-sinks.ts` (+ `src/daemon/reply-sinks.test.ts`); Modify `src/daemon/internal-api/routes.ts` (`POST /v1/wechat/reply`, ~line 299), `src/daemon/internal-api/types.ts` (`InternalApiDeps`).

**Interfaces (produce):**
```ts
export interface ReplySinks {
  // Register a capture buffer for chatId; returns a handle. Throws if one is
  // already active for chatId (in-flight guard should prevent this).
  open(chatId: string): { close(): string }   // close() returns the concatenated captured text
  // Called by the reply route: if a sink is open for chatId, append text and
  // return true (caller must NOT ilink-send); else false.
  capture(chatId: string, text: string): boolean
}
export function makeReplySinks(): ReplySinks
```
`InternalApiDeps` gains `replySinks?: ReplySinks` (doc: when a sink is open for a chat, `POST /v1/wechat/reply` captures instead of ilink-sending — the app channel; absent ⇒ WeChat path unchanged).

**Route change:** at the TOP of `POST /v1/wechat/reply`, after the `ilink` 503 guard, before `maybePrefix`/`splitReply`:
```ts
if (deps.replySinks?.capture(chat_id, text)) {
  return { status: 200, body: { ok: true, captured: true } }
}
```
(Capture the RAW `text` — whole, pre-split, pre-prefix. App shows the whole reply.)

- [ ] **Step 1 — failing tests** (`reply-sinks.test.ts`): `open`→`capture` appends and `close()` returns the text; two `capture` calls concatenate; `capture` on a chat with no open sink ⇒ false; `open` twice on same chatId ⇒ throws; `close` returns buffer and a subsequent `capture` ⇒ false (deregistered). Plus a route-level test in `internal-api.test.ts`: with a sink open for `c1`, `POST /v1/wechat/reply {chat_id:c1, text:"hi"}` ⇒ `{ok:true,captured:true}` AND `deps.ilink.sendReply` NOT called; with no sink ⇒ ilink path unchanged (sendReply called, existing assertions still pass).
- [ ] **Step 2** run → fail. **Step 3** implement. **Step 4** run → pass. `bun --bun vitest run src/daemon/reply-sinks.test.ts src/daemon/internal-api.test.ts`; `bunx tsc --noEmit`.
- [ ] **Step 5 — commit** (`git add src/daemon/reply-sinks.ts src/daemon/reply-sinks.test.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/types.ts src/daemon/internal-api.test.ts`): `feat(app-channel): reply-sink seam — capture reply instead of ilink-send`.

---

### Task 2: converse endpoint + owner-session turn wiring

**Files:** Modify `src/daemon/internal-api/routes.ts` (new route), `src/daemon/internal-api/route-tiers.ts`, `src/daemon/internal-api/types.ts`, `src/daemon/internal-api/index.ts` (late-bind setter if needed), and the wiring in `src/daemon/wiring/pipeline-deps.ts` (construct the closure). Tests in `src/daemon/internal-api.test.ts` (+ wiring test if present).

**Interfaces (consume from Task 1):** `ReplySinks`. **Produce:** late-bound dep
```ts
// on InternalApiDeps — encapsulates the whole app turn so the route table
// never imports coordinator internals (mirror setConversation/setDelegate):
companionConverse?: (text: string) => Promise<{ reply: string; busy?: boolean }>
```
**Wiring (pipeline-deps.ts)** builds the closure with access to the coordinator + replySinks + owner chatId:
```ts
companionConverse: async (text) => {
  const chatId = ownerChatId()                       // default_chat_id; if none ⇒ throw/He handled as 503 upstream
  const sink = replySinks.open(chatId)               // throws if a turn is already in flight for this session
  try {
    await boot.coordinator.dispatch({ chatId, text, /* synthetic owner inbound; fill required InboundMsg fields — read the type */ })
    return { reply: sink.close() }
  } catch (err) { sink.close(); throw err }
}
```
(Read `InboundMsg`'s exact shape in `conversation-coordinator.ts` and construct a valid synthetic owner message — direction/from/alias/providerId as the owner's WeChat inbound would have. The in-flight guard is `replySinks.open` throwing when a sink is already active ⇒ surface as `busy`.)

**Route** `POST /v1/companion/converse`:
```ts
if (!deps.companionConverse) return { status: 503, body: { error: 'companion_converse_not_wired' } }
const { text } = body as { text?: unknown }
if (typeof text !== 'string' || text.trim().length === 0) return { status: 400, body: { error: 'text required' } }
try {
  const r = await deps.companionConverse(text)
  return { status: 200, body: { ok: true, reply: r.reply } }
} catch (err) {
  if (isBusy(err)) return { status: 409, body: { ok: false, error: 'session_busy' } }
  return { status: 500, body: { ok: false, error: errMsg(err) } }
}
```
**route-tiers.ts:** `'POST /v1/companion/converse': 'admin'` (owner-only; comment: same-session owner power, admin like the other companion mutations).

- [ ] **Step 1 — failing tests** (`internal-api.test.ts`): 503 when `companionConverse` absent; 400 on missing/empty text; happy ⇒ mock `companionConverse` returns `{reply:'hey'}` ⇒ `{ok:true,reply:'hey'}`; busy ⇒ mock throws a busy error ⇒ 409 `session_busy`; tier gate ⇒ guest/trusted token ⇒ 403 (mirror existing admin-route tier tests). (The wiring closure itself — coordinator.dispatch + sink — verify via a wiring/integration test if the harness supports it; otherwise assert the route contract with a mocked `companionConverse` and leave the closure to the final review + manual daemon check.)
- [ ] **Step 2-4** RED→GREEN. `bun --bun vitest run src/daemon/internal-api.test.ts src/daemon/internal-api/route-tiers.test.ts`; full `bun --bun vitest run` (git-stash triage); `bunx tsc --noEmit`.
- [ ] **Step 5 — commit** (explicit paths): `feat(app-channel): POST /v1/companion/converse — owner-session turn returned to caller`.

---

### Task 3: Tauri command `agent_converse`

**Files:** Modify `apps/desktop/src-tauri/src/lib.rs` (new command + register in `invoke_handler`). Read `wechat_health_ping` (`lib.rs:307-337`) first — mirror its port/token discovery (`internal-api-info.json` + `internal-token`) and `reqwest` usage.

```rust
#[tauri::command]
async fn agent_converse(text: String) -> Result<String, String> {
  // resolve base_url + bearer exactly like wechat_health_ping
  // POST {base}/v1/companion/converse  {"text": text}  with Authorization: Bearer <token>
  // parse {ok, reply} → Ok(reply) ; on !ok or http error → Err(message)
}
```
Register in `.invoke_handler(tauri::generate_handler![... , agent_converse])`.

- [ ] Implement; verify with `cargo build` (or `cargo check`) inside `apps/desktop/src-tauri`. If the Rust/Tauri toolchain is unavailable in this env, STOP and report DONE_WITH_CONCERNS (code written, compile unverified) rather than guessing — do not fake a green build.
- [ ] **Commit** (`git add apps/desktop/src-tauri/src/lib.rs`): `feat(app-channel): agent_converse Tauri command → /v1/companion/converse`.

---

### Task 4: app compose UI

**Files:** Modify `apps/desktop/src/modules/dialogue-page.js` (or add `apps/desktop/src/modules/converse.js` + wire a pane in `apps/desktop/src/index.html` / `apps/desktop/src/main.js` router `switchPane`). Read `dialogue-page.js` + `ipc.js` (`invoke` wrapper) first.

- Add a compose box (textarea + send button) + a live message list to the 对话 pane (or a new "跟 CC 说" pane). On send: `invoke('agent_converse', { text })` via the existing `ipc.js` wrapper; optimistically append the user message, append the returned reply; disable send while awaiting; show an inline error on failure. Match the existing vanilla-JS module + styling conventions (no framework).
- Whole reply shown at once (no splitting). Keep it minimal per the "desktop stays simple" principle.

- [ ] Implement. Verify: `cargo`/tauri dev build loads the pane (or, if the app can't be run in this env, a careful self-review + note that manual verification is pending). No JS test harness exists — do NOT invent one; verify by loading or by structural review.
- [ ] **Commit** (`git add apps/desktop/src/...`): `feat(app-channel): compose box — text-converse with the CC in the app`.

## Self-Review notes

Spec §2 (session≠channel) → T1 (sink seam) + T2 (converse drives owner session, sink captures). §3 endpoint/tier/Tauri/UI → T2/T3/T4. WeChat-byte-unchanged invariant pinned in T1 (absent-sink test). Names flow: `ReplySinks`/`replySinks` T1→T2; `companionConverse` T2→(route); `agent_converse` T3→T4. Risk: T2's wiring closure (coordinator.dispatch synthetic InboundMsg + in-flight via sink.open-throws) is the load-bearing integration — its correctness leans on the final review + a manual daemon smoke (send text via the route, confirm reply returns and WeChat is NOT pinged), since the route-level tests mock `companionConverse`. T3/T4 verification is compile/manual by nature (Rust/JS app), not vitest.
