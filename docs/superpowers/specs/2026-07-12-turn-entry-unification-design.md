# Design: Turn-entry unification — the conversation-actor pattern (D3)

Date: 2026-07-12
Status: design → (pending user review) → plan
Origin: architecture debt **D3** (`docs/architecture.md §5`), "the single most fragile seam." The per-chat "one turn at a time" invariant is enforced in three callers with three mechanisms (`coordinator.dispatch` locks; `companionConverse` manually `runExclusive`+`dispatchInner`; `dispatchToChat` `runExclusive` around a raw `SessionManager.acquire`), plus chatroom exempt (its own abort-preempt), plus a public bare-callable `dispatchInner`, plus a `chatId`-only reply-sink. The invariant lives in comments, not types — nothing stops a new turn-entry author reintroducing a silent per-chat race. **This is a preventive refactor: it does not fix a bug biting today (the current callers happen to be correct); it removes the trap before the next channel — the near-term phone voice thin-client — steps on it.** Grounded in the 2026 convergent pattern (see §2).

## 1. What

Collapse all turn entries into ONE coordinator entrypoint that owns the per-chat serialization + turn lifecycle, so `dispatchInner` becomes un-reachable bare and the invariant is structural. Make the two serialization strategies (queue vs preempt) explicit per mode rather than a silent chatroom exemption. This is the architecture the phone voice channel needs anyway (barge-in = preempt; a real channel adapter instead of a WeChat impersonation).

## 2. The borrowed pattern (2026 state of the art)

- **Conversation actor** (Cloudflare Durable Objects, Orleans virtual actors): each conversation is a single-threaded actor; all inputs go through one door and serialize by construction — "you don't need a queue to coordinate exactly-one-worker; the runtime is already that." wechat-cc's per-chat mutex is a hand-rolled version; D3 makes it the ONLY door.
- **Explicit turn-taking policy** (LiveKit adaptive interruption, OpenAI Realtime `interrupt_response`, Pipecat): interruption/barge-in is a first-class, per-channel policy — abort the in-flight turn cleanly, track `was_interrupted`. This is chatroom's preempt, matured; the phone voice channel makes it non-optional.
- **One active run per thread** (OpenAI Assistants/Agents SDK; LangGraph typed state): the validated invariant is "≤1 active run per thread, others queue/reject," and LangGraph's lesson is to model concurrency in TYPES, not convention.
- **Channel-neutral session + adapters + correlation-id routing** (omnichannel platforms): one shared session, per-channel adapters normalizing into a common turn, replies routed by correlation id. Validates `session ≠ channel`; the fix is to stop the app impersonating WeChat and to key reply capture by turn, not chatId.

## 3. Locked decisions

- **Single entrypoint** `coordinator.submitTurn(chatId, input, opts?)`:
  - `input`: a channel-neutral shape `{ msg: InboundMsg }` (WeChat/tick already have an InboundMsg) OR `{ text: string, source: 'app' | 'wechat' | 'tick' }` which the coordinator normalizes into an InboundMsg (so the **app stops fabricating a WeChat InboundMsg + borrowing `ilink.resolveAccountId`**).
  - `opts.capture?: boolean` — open a reply-sink for this turn and return the captured reply text (the app path). Default off.
  - Resolves `mode` → **policy**; runs `_dispatchTurn` under that policy; returns the turn result.
- **`dispatchInner` → private** (rename `_dispatchTurn`, not exported on the `Coordinator` interface). The only public turn surface is `submitTurn`. `dispatch(msg)` becomes a thin `submitTurn({ msg })`.
- **Explicit turn-taking policy** — a `turnPolicy(mode): 'queue' | 'preempt'` (currently: chatroom → `preempt`; solo/parallel/primary_tool → `queue`). `submitTurn`:
  - `queue` → `mutex.runExclusive(chatId, () => _dispatchTurn(...))` (today's default).
  - `preempt` → abort the in-flight turn for chatId, then `_dispatchTurn(...)` (today's chatroom path, reusing `inFlightAborters` — unchanged logic, now named + reachable for future voice modes). Adding a new `preempt` mode is a one-line policy entry, not a re-derivation.
- **Three existing callers route through it:**
  - WeChat: `dispatch(msg)` → `submitTurn({ msg })`.
  - App: `companionConverse` becomes `coordinator.submitTurn(chatId, { text, source: 'app' }, { capture: true })` — the sink open/close + `dispatchInner` move INTO the coordinator; pipeline-deps no longer knows the pairing rules.
  - Tick: `dispatchToChat` claims (careLedger, unchanged) then `submitTurn(chatId, { msg: tickMsg })` instead of raw `SessionManager.acquire` — so it stops bypassing the coordinator.
- **Reply-ownership by turn lifecycle** (correlation-id, staged — see §4 Stage 2): the sink is opened by a specific turn and CLOSED when that turn ends/aborts, so a late reply from a preempted turn finds no sink (falls through to ilink) rather than landing in the successor's sink. Full turn-id tagging on `/v1/wechat/reply` is a stretch (the agent's reply tool doesn't carry a turn id); the lifecycle tie handles the real race.
- **Reuse, don't rewrite:** the mutex IS the `queue` impl; chatroom's abort-controllers ARE the `preempt` impl. D3 renames + routes, it does not reimplement either. Chatroom's preempt protocol stays byte-for-byte (only reached via the policy now).

## 4. Staging (each stage lands green + reviewed; SDD)

- **Stage 1 — the entrypoint (core structural fix).** Add `submitTurn` + `turnPolicy`; make `_dispatchTurn` private; route `dispatch` through it. WeChat path only. No behavior change (pure refactor, existing tests pin it). This alone makes bare dispatch unreachable via the public interface for the WeChat path.
- **Stage 2 — app + tick through it.** `companionConverse` → `submitTurn(..., {capture})` (sink lifecycle into coordinator); `dispatchToChat` → `submitTurn`. Removes the two hand-rolled lock sites. Reply-sink tied to turn lifecycle (abort closes sink).
- **Stage 3 — channel-neutral input + policy seam for the phone.** The `{text, source}` normalization so the app/phone don't fabricate WeChat msgs; document how a new `preempt`+voice channel plugs in (the actual phone build consumes this, not D3).

## 5. Non-goals

- Reimplementing chatroom's preempt or the mutex.
- The full channel-neutral `Turn` type overhaul (Stage 3 does the minimal normalization seam, not a downstream type migration).
- Full turn-id correlation threaded through the agent's reply MCP tool (lifecycle tie only).
- Building the phone channel (D3 is its enabler, built separately).
- Any change to modes/providers/memory/auth.

## 6. Testing

- Stage 1: existing coordinator/dispatch tests stay green (byte-identical behavior); new tests: `submitTurn({msg})` serializes per chat (two concurrent submits for one chat run sequentially); `turnPolicy` returns preempt for chatroom, queue otherwise; `_dispatchTurn` is not on the public `Coordinator` type (compile check / not exported). Chatroom preempt path unchanged (its existing tests green).
- Stage 2: `companionConverse` via `submitTurn` returns the captured reply (existing converse tests green); a WeChat turn in-flight ⇒ app `submitTurn` serializes behind it (not races); tick via `submitTurn` acquires+dispatches like before (tick tests green); an aborted (preempted) turn's late reply does NOT land in the successor's sink.
- Stage 3: app `submitTurn({text, source:'app'})` produces a valid turn WITHOUT calling `ilink.resolveAccountId` (the app no longer depends on WeChat account routing to converse).
- Full daemon suite + e2e green at every stage. Session-serialization e2e (the existing one) is the safety net for the hot path.
