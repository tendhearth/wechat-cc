# Per-Session Turn Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize agent turns per chatId so app / WeChat-inbound / tick turns on one session never run concurrently, and an app turn's reply-sink lifetime is covered by the same lock — closing the Stage-0 in-flight residual.

**Architecture:** A per-chatId async mutex `runExclusive(chatId, fn)` in the coordinator; `dispatch()` wraps its turn body in it (refactored to `dispatch = runExclusive(chatId, () => dispatchInner(msg))`). `companionConverse` acquires the SAME lock spanning `open sink → dispatchInner → close sink` (avoiding self-deadlock by calling `dispatchInner`, not `dispatch`). The fallback-text delivery becomes reply-sink-aware in the daemon.

**Tech Stack:** core/daemon TypeScript, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-session-serialization-design.md`. Rules:
  - Same-chat turns serialize; DIFFERENT chats stay parallel (mutex keyed by chatId).
  - **No self-deadlock**: `companionConverse` must NOT call the public locking `dispatch` from inside `runExclusive` — it calls `dispatchInner` (non-locking).
  - **Sink lifetime inside the lock**: the app turn's `replySinks.open()` and `sink.close()` both happen INSIDE the same `runExclusive` critical section, so a queued WeChat turn starts only after the sink is closed.
  - Keep the app-side fast-fail `isInFlight` pre-check (immediate 409 for the app UI); mutex is the correctness layer.
  - Chatroom mode already self-preempts (abort+replace) — verify the mutex composes with it or exempt chatroom (do NOT break chatroom).
  - WeChat inbound behavior for the common (non-concurrent) case must be unchanged.
- TDD; tsc clean; explicit `git add`.

---

### Task 1: per-chat mutex + dispatch/dispatchInner refactor

**Files:** Modify `src/core/conversation-coordinator.ts` (+ its test `conversation-coordinator.test.ts`). Possibly a tiny `src/core/async-mutex.ts` (+test) if a clean standalone primitive reads better.

**Interfaces (produce):**
```ts
// exposed on the coordinator object returned by makeConversationCoordinator:
runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T>
dispatchInner(msg: InboundMsg): Promise<void>   // the current dispatch body WITHOUT the lock
dispatch(msg: InboundMsg): Promise<void>        // = runExclusive(msg.chatId, () => dispatchInner(msg))
```
Mutex impl: a `Map<string, Promise<unknown>>` tail-chain — `runExclusive(chatId, fn)` chains `fn` after the current tail for that chatId, updates the tail, and cleans the map entry when the chain empties. A throwing `fn` must NOT poison the chain (next waiter still runs) — chain on a `.then/.catch`-settled promise, not a rejecting one. Different chatIds are independent.

- [ ] **Step 1 — failing tests** (mutex): two `runExclusive(c1, slowFn)` overlap ⇒ second starts only after first settles (assert via a shared sequence array + a deferred/await ordering, NO real timers — use resolvable promises); `runExclusive(c1,...)` and `runExclusive(c2,...)` run concurrently (both enter before either finishes); a throwing fn releases the lock (a following `runExclusive(c1)` still runs); the map entry is cleaned after the chain drains (no unbounded growth). Coordinator: `dispatch(msg)` still behaves as before for a single turn (existing dispatch tests green); a NEW test — two `dispatch` calls on the same chatId with a fake provider that records start/end order ⇒ serialized (second starts after first ends); different chatIds ⇒ interleaved.
- [ ] **Step 2-4** RED→GREEN. Refactor: rename the current `dispatch` body to `dispatchInner`; add `runExclusive`; `dispatch = (msg) => runExclusive(msg.chatId, () => dispatchInner(msg))`. Expose `runExclusive` + `dispatchInner` on the returned object. Verify chatroom's existing abort-preempt tests stay green (if the mutex would serialize chatroom in a way that breaks preemption, exempt chatroom mode from `runExclusive` — i.e. chatroom keeps calling dispatchInner-equivalent directly; document why). `bun --bun vitest run src/core/conversation-coordinator.test.ts` (+ async-mutex.test.ts); `bunx tsc --noEmit`.
- [ ] **Step 5 — commit** (explicit paths): `feat(coordinator): per-chatId turn serialization (runExclusive + dispatchInner)`.

### Task 2: companionConverse spans the lock over the sink; fallback text sink-aware; residual resolved

**Files:** Modify `src/daemon/wiring/pipeline-deps.ts` (`companionConverse`), the daemon's `sendAssistantText` wiring (find it — `src/daemon/bootstrap/index.ts` ~line 1030, `sendAssistantText` → `ilink.sendMessage`), and tests (`pipeline-deps-converse.test.ts` / wherever). Update `docs/superpowers/specs/2026-07-10-app-conversation-channel-design.md` residual (1) → RESOLVED.

**Consume from Task 1:** `coordinator.runExclusive`, `coordinator.dispatchInner`.

1. **companionConverse** (`pipeline-deps.ts`): keep the fast-fail `isInFlight` pre-check + `resolveOwnerSessionKey`. Then wrap the sink+dispatch in the lock:
```ts
return boot.coordinator.runExclusive(ownerChatId, async () => {
  const sink = replySinks.open(ownerChatId)
  try { await boot.coordinator.dispatchInner(synthetic); return { reply: sink.close() } }
  catch (e) { sink.close(); throw e }
})
```
(Replaces the current `replySinks.open` + `coordinator.dispatch` — note it now uses `dispatchInner`, and the lock spans the sink lifetime. The pre-check stays ABOVE `runExclusive`.)
2. **Fallback text sink-aware** (Part B): the daemon `sendAssistantText(chatId, text)` impl — before `ilink.sendMessage`, check `if (replySinks.capture(chatId, text)) return` (mirror the `POST /v1/wechat/reply` sink check from Stage 0). So an app turn whose agent emits plain assistant text (no reply tool) is captured into the sink, not leaked to WeChat. Thread the SHARED `replySinks` instance into wherever `sendAssistantText` is constructed (it's the same single instance from main.ts).
3. Update the app-conversation spec's Known-residual (1) to note it's resolved by session serialization (this plan).

- [ ] **Step 1 — failing tests**: companionConverse — extend the existing converse test: a fake coordinator whose `runExclusive` is a real pass-through mutex + a `dispatchInner` that, DURING its run, a second concurrent `dispatch(sameChat)` is attempted ⇒ the second does not start until the app turn's sink is closed (assert the sink was already closed / the second turn's captured reply did NOT land in the app sink). Fallback: a fake dispatch that triggers `sendAssistantText` while an app sink is open ⇒ the text is captured into the sink (returned as the app reply), and the ilink `sendMessage` mock is NOT called; with NO sink open ⇒ ilink `sendMessage` IS called (WeChat unchanged).
- [ ] **Step 2-4** RED→GREEN. `bun --bun vitest run` on the converse + pipeline + coordinator tests; full `bun --bun vitest run` (name pre-existing failures); `bunx tsc --noEmit`; e2e `bun --bun vitest run -c vitest.e2e.config.ts`.
- [ ] **Step 5 — commit** (explicit paths): `fix(app-channel): serialize app turn over sink lifetime + sink-aware fallback text (close in-flight residual)`.

## Self-Review notes

Spec §2A → T1 (mutex+refactor) + T2 (companionConverse spans lock). §2B → T2 (sink-aware sendAssistantText). Reentrancy avoided: T2 calls `dispatchInner`, never the locking `dispatch`. Sink-lifetime-in-lock is the crux (T2). Names: `runExclusive`/`dispatchInner` T1→T2. Chatroom-preemption composition verified in T1. Residual doc flip in T2. Latency trade (same-chat serialize) is intentional + documented.
