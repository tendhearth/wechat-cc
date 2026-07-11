# Design: Per-Session Turn Serialization (close the app-channel in-flight residual)

Date: 2026-07-10
Status: approved design → implementation
Origin: Stage-0 documented residual — the `companionConverse` in-flight guard is one-directional; a WeChat/tick turn can start DURING an app turn, racing the shared session AND having its reply captured into the open app sink. Must close before voice arc Stage 2 (which adds concurrent/automated owner turns). Investigation: no per-chat serialization exists in the coordinator (`isInFlight` is an advisory TOCTOU counter).

## 1. Problem

Turns on ONE session (chatId) can run concurrently. `coordinator.dispatch` (solo/parallel/primary_tool) has no per-chat lock; `SessionManager.isInFlight` is advisory. Unprevented concurrent pairs on one chatId: **app-vs-WeChat-inbound, app-vs-tick, tick-vs-WeChat-inbound** (plus a narrow onboarding echo-dispatch WeChat-vs-WeChat case). Two harms: (1) two turns mutate one AgentSession's shared history → corruption (openai provider has no self-guard); (2) a concurrent WeChat/tick reply is captured into an open app reply-sink and lost from WeChat.

## 2. The fix — two parts

### A. Per-chat async mutex in the coordinator
A shared per-chatId serialization primitive `runExclusive(chatId, fn)` (a chained-promise mutex map, keyed by chatId) in `conversation-coordinator.ts`. WeChat inbound turns funnel through `dispatch()`, which wraps its whole `switch(mode.kind)` body in `runExclusive`. App converse turns (`companionConverse`) call the exposed `runExclusive` directly around their sink open→dispatch→close lifetime (see below). The companion push tick (`tick-bodies.ts`'s `dispatchToChat`, Task 3) also calls the same exposed `runExclusive` directly, around its acquire→claim→dispatch critical section — it never calls `coordinator.dispatch`/`dispatchInner` itself (it drives the `SessionManager` handle directly), so this cannot re-enter the mutex. All three turn entry points (WeChat inbound, app converse, tick) therefore share the SAME per-chatId mutex instance and serialize against each other; only chatroom mode is exempt (see below). Result: turns on one chat run strictly one-at-a-time; a second trigger WAITS for the first (bounded by `turnTimeoutMs`).

**Reentrancy**: expose an internal `dispatchExclusive`-free path so `companionConverse` can compose the mutex + sink itself WITHOUT double-locking (calling the public `dispatch` from inside its own `runExclusive` would deadlock). Concretely: refactor to `dispatchInner(msg)` (no lock) + `dispatch(msg) = runExclusive(chatId, () => dispatchInner(msg))`; expose `runExclusive` + `dispatchInner` (or a single `dispatchWithinLock` helper) for the daemon.

**Sink-lifetime span (critical)**: `companionConverse` must hold the SAME per-chat lock across `replySinks.open()` → `dispatchInner(synthetic)` → `sink.close()` as ONE critical section — so a queued WeChat turn cannot start until the sink is closed. Putting the lock only inside `dispatch()` is INSUFFICIENT (dispatch resolves before the daemon closes the sink). So `companionConverse` becomes:
```
return coordinator.runExclusive(ownerChatId, async () => {
  const sink = replySinks.open(ownerChatId)
  try { await coordinator.dispatchInner(synthetic); return { reply: sink.close() } }
  catch (e) { sink.close(); throw e }
})
```
The app-side fast-fail `isInFlight` pre-check STAYS (so the app UI gets an immediate 409 `session_busy` instead of hanging on the lock when a WeChat turn is running) — it's a UX optimization; the mutex is the correctness guarantee.

### B. Fallback-text path respects the reply-sink
`dispatchSolo`'s no-reply-tool fallback (`sendAssistantText` → ilink) currently bypasses `replySinks`, so an app turn whose agent emits plain text (no reply tool) leaks that text to WeChat and returns an empty app reply. Make the fallback delivery sink-aware: if a sink is open for the chat, capture the fallback text into it instead of ilink-sending (mirror the `POST /v1/wechat/reply` sink check). Then an app turn's fallback text is returned to the app, not leaked.

## 3. Locked decisions / non-goals

- Latency trade is INTENTIONAL: a slow turn blocks the next on the same chat (correctness over liveness). Only same-chat; different chats stay parallel.
- Keep chatroom mode's existing abort-preempt behavior (don't double-serialize it — verify the mutex composes with it or exempt chatroom).
- Do NOT fix the onboarding echo-dispatch WeChat-vs-WeChat case in this task unless it falls out for free (it's narrow + pre-existing); note it.
- No change to different-chat parallelism or provider behavior. The tick's own `isInFlight` advisory pre-check (in `dispatchToChat`, ABOVE the mutex) stays as a cheap fast-skip for the common "session obviously busy" case — avoids waiting on the lock — but is no longer the only guard: the tick's acquire+claim+dispatch now also runs inside `runExclusive(chatId, ...)` (Task 3), which closes the TOCTOU window the pre-check alone left open (see §2A).

## 4. Testing

- `runExclusive`: two overlapping calls on the same chatId serialize (second starts only after first resolves); different chatIds run concurrently; a throwing fn releases the lock (next proceeds).
- Serialization integration: a `dispatchInner` that's slow + a second `dispatch` on the same chat ⇒ the second waits (assert ordering via timestamps/sequence in a fake). App converse holding the lock ⇒ a concurrent `coordinator.dispatch` for the same chat does not start until the app turn's sink is closed (assert the sink was closed before the WeChat turn's reply delivery — the WeChat reply goes to ilink, NOT the app sink).
- Fallback sink-awareness: app turn whose fake agent emits assistantText + no reply tool ⇒ text captured into the sink (returned to app), `sendAssistantText`/ilink NOT called.
- Tick serialization (Task 3, `tick-bodies.test.ts`): the tick's acquire+claim+dispatch runs inside `coordinator.runExclusive(chatId, ...)`; a same-chat `runExclusive` already held (simulating an in-flight app turn) blocks the tick's acquire/dispatch from starting until it's released. Existing `isInFlight` fast-skip tests stay green (pre-check is unchanged, only what happens after it is new).
- Update the Stage-0 "Known residual (1)" in the app-conversation spec to RESOLVED (with a pointer here).
- Full daemon suite + e2e green; WeChat inbound behavior unchanged for the non-concurrent common case.
