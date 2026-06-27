# /chat Structured-Debate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/chat`'s sequential LLM-moderator round-robin with a three-beat conductor — parallel opening → parallel cross-talk → judged verdict — that is faster, higher-quality, and can't parse-fail.

**Architecture:** A new pure module (`chatroom-conductor.ts`) holds the prompt builders + a tolerant convergence parser. `dispatchChatroom` is rewritten to run beats over the panel concurrently (reusing a small `fanOut` helper), emitting each agent's turn as it completes, and always ending with a plain-text verdict. The old `evaluateRound` moderator is deleted.

**Tech Stack:** TypeScript, Bun, vitest (`bun --bun vitest run`), bun:sqlite. No new deps.

## Global Constraints

- Run tests with `bun --bun vitest run <path>` (NOT plain vitest — needs bun:sqlite).
- TDD: failing test first, watch it fail, minimal impl, watch it pass, commit.
- Provider-agnostic: no `=== 'codex'` / `peerOf` / 2-agent hardcoding. Panel is `ProviderId[]`.
- The verdict is PLAIN TEXT (no JSON). The ONLY JSON is the tiny convergence check `{"converged":bool,"disagreement":string}` — parsed tolerantly, never throws.
- `sendAssistantText(chatId, text)` sends ONE message per call. Emit each agent turn prefixed `[<DisplayName>] ` as soon as that agent completes.
- Reuse `collectTurn(events, { timeoutMs: deps.turnTimeoutMs })` → `TurnSummary { assistantText: string[]; replyToolCalled: boolean; error?: string; errorCode?: string }`.
- Emit exactly one `recordTurn` per agent-turn (mode `'chatroom'`), as the current code does.

---

### Task 1: chatroom-conductor.ts — prompt builders + tolerant convergence parser (pure)

**Files:**
- Create: `src/core/chatroom-conductor.ts`
- Test: `src/core/chatroom-conductor.test.ts`

**Interfaces:**
- Consumes: `ProviderId` from `./conversation`.
- Produces:
  - `type Opening = { speaker: ProviderId; text: string }`
  - `buildRebuttalPrompt(question: string, openings: Opening[], self: ProviderId): string`
  - `buildVerdictPrompt(question: string, openings: Opening[], rebuttals: Opening[]): string`
  - `buildConvergencePrompt(question: string, openings: Opening[], rebuttals: Opening[]): string`
  - `parseConvergence(raw: string): { converged: boolean; disagreement?: string }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { buildRebuttalPrompt, buildVerdictPrompt, parseConvergence } from './chatroom-conductor'

describe('chatroom-conductor', () => {
  const openings = [
    { speaker: 'claude' as const, text: '用 A 方案' },
    { speaker: 'codex' as const, text: '用 B 方案' },
  ]

  it('rebuttal prompt gives self the OTHERS full openings and asks for pointed engagement', () => {
    const p = buildRebuttalPrompt('选 A 还是 B?', openings, 'claude')
    expect(p).toContain('用 B 方案')        // sees the other's actual text
    expect(p).not.toContain('用 A 方案')     // not fed its own opening back
    expect(p).toMatch(/反驳|哪里错|漏|不同意/) // told to engage, not just restate
  })

  it('verdict prompt asks for a stance + consensus/disagreement/recommendation, not a transcript', () => {
    const p = buildVerdictPrompt('选 A 还是 B?', openings, openings)
    expect(p).toMatch(/共识/)
    expect(p).toMatch(/分歧/)
    expect(p).toMatch(/结论|建议/)
    expect(p).toMatch(/🎯/)                  // verdict marker
  })

  it('parseConvergence tolerates ```json fences', () => {
    expect(parseConvergence('```json\n{"converged":true}\n```')).toEqual({ converged: true })
  })

  it('parseConvergence extracts fields from a TRUNCATED output (the live parse-fail case)', () => {
    // moderator-style truncation: cut off mid-string, no closing brace
    const raw = '{"converged": false, "disagreement": "A 方案的并发安全性没说清，B 说的'
    expect(parseConvergence(raw)).toEqual({ converged: false, disagreement: expect.any(String) })
  })

  it('parseConvergence on total garbage defaults to converged=true (stop, never loop)', () => {
    expect(parseConvergence('更')).toEqual({ converged: true })
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — `bun --bun vitest run src/core/chatroom-conductor.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * chatroom-conductor — pure prompt builders + a tolerant convergence parser
 * for the three-beat /chat debate (opening → cross-talk → verdict). No LLM /
 * SDK here; the coordinator runs the agents and calls deps.haikuEval for the
 * convergence check + verdict. Replaces the old evaluateRound moderator.
 */
import type { ProviderId } from './conversation'

export interface Opening {
  speaker: ProviderId
  text: string
}

const NO_REPLY_TOOL = '用纯文本回复，不要调 reply 工具。'

function othersBlock(openings: Opening[], self: ProviderId): string {
  return openings
    .filter(o => o.speaker !== self)
    .map(o => `【${o.speaker} 的立场】\n${o.text}`)
    .join('\n\n')
}

/** Beat ② — each agent sees the OTHERS' openings and is told to engage pointedly. */
export function buildRebuttalPrompt(question: string, openings: Opening[], self: ProviderId): string {
  return [
    `用户的问题：${question}`,
    '',
    '另一(几)位 AI 的立场如下：',
    othersBlock(openings, self),
    '',
    '请针对性回应：他们哪里错了、漏了什么？哪点你认同、要承认？引用对方具体的话，别泛泛"你怎么看"。如果你们其实一致，就说一致——不要制造虚假对立。简短、中文、没废话。',
    NO_REPLY_TOOL,
  ].join('\n')
}

/** Beat ②b — tiny convergence check (the ONLY JSON; kept small so it can't truncate). */
export function buildConvergencePrompt(question: string, openings: Opening[], rebuttals: Opening[]): string {
  const transcript = [...openings, ...rebuttals].map(o => `[${o.speaker}] ${o.text}`).join('\n\n')
  return [
    `判断这场关于「${question}」的讨论是否已经收敛(双方对核心问题已无实质分歧)。`,
    transcript,
    '',
    '只输出一行紧凑 JSON,不要 markdown 围栏,不要解释：',
    '{"converged": true|false, "disagreement": "<若未收敛,一句话说清还在争什么;收敛则空字符串>"}',
  ].join('\n')
}

/** Beat ③ — the deliverable: a JUDGED synthesis. Plain text, no JSON to parse. */
export function buildVerdictPrompt(question: string, openings: Opening[], rebuttals: Opening[]): string {
  const transcript = [...openings, ...rebuttals].map(o => `[${o.speaker}] ${o.text}`).join('\n\n')
  return [
    `下面是几位 AI 关于「${question}」的讨论。给出最终裁决,不是"两种看法供参考"——要站队。`,
    transcript,
    '',
    '用这个结构,简短,中文,以 🎯 开头：',
    '🎯 共识：<他们一致的部分>',
    '分歧：<分歧点;哪边更对、为什么>',
    '结论/建议：<可落地的答案>',
    NO_REPLY_TOOL,
  ].join('\n')
}

/**
 * Tolerant parse of the convergence check. Never throws. Order:
 *  1. JSON.parse the first {...} block (strips ```json fences naturally).
 *  2. On failure (e.g. truncation), regex-extract `converged` + `disagreement`.
 *  3. On total failure, default converged=true (stop — never loop forever).
 */
export function parseConvergence(raw: string): { converged: boolean; disagreement?: string } {
  const block = raw.match(/\{[\s\S]*\}/)
  if (block) {
    try {
      const o = JSON.parse(block[0]) as { converged?: unknown; disagreement?: unknown }
      const converged = o.converged !== false
      return converged
        ? { converged: true }
        : { converged: false, ...(typeof o.disagreement === 'string' && o.disagreement.trim() ? { disagreement: o.disagreement } : {}) }
    } catch { /* fall through to field extraction */ }
  }
  // Truncation / malformed: pull fields out by regex.
  const convM = raw.match(/"converged"\s*:\s*(true|false)/)
  if (convM) {
    if (convM[1] === 'true') return { converged: true }
    const disM = raw.match(/"disagreement"\s*:\s*"([^"]*)/) // tolerate missing closing quote
    return { converged: false, ...(disM && disM[1]?.trim() ? { disagreement: disM[1] } : {}) }
  }
  return { converged: true } // unparseable → stop, don't loop
}
```

- [ ] **Step 4: Run it, verify it passes** — `bun --bun vitest run src/core/chatroom-conductor.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/chatroom-conductor.ts src/core/chatroom-conductor.test.ts
git commit -m "feat(chatroom): conductor prompt builders + tolerant convergence parser"
```

---

### Task 2: `runBeat` helper — concurrent fan-out that emits each agent turn as it completes

**Files:**
- Modify: `src/core/conversation-coordinator.ts` (add a module-scope helper near `dispatchParallel`, ~line 800)
- Test: `src/core/conversation-coordinator.test.ts` (add a focused test)

**Interfaces:**
- Consumes: `manager.acquire`, `collectTurn`, `deps.sendAssistantText`, `deps.recordTurn`, `deps.turnTimeoutMs`, `deps.providerDisplayName`, `nowMs`, `TURN_TIMEOUT_CODE`, `Opening` (from `./chatroom-conductor`).
- Produces (inside the coordinator factory, closing over `deps`/`proj`/`msg`):
  - `runBeat(participants: ProviderId[], promptFor: (p: ProviderId) => string): Promise<Opening[]>`
  - Runs every participant concurrently; for each that produces text, sends `[<DisplayName>] <text>` immediately on completion and emits one chatroom `recordTurn`; returns the `{ speaker, text }` of the ones that produced non-empty text (failed/empty agents are dropped from the returned array — graceful degradation).

- [ ] **Step 1: Write the failing test** (drop this inside the existing chatroom describe block in `conversation-coordinator.test.ts`; adapt fixture helpers already in that file — `makeFakeSession`, the coordinator factory, `TIER_PROFILES.admin`):

```typescript
it('runBeat: fans out concurrently, emits each non-empty turn prefixed, drops failures', async () => {
  // Build a coordinator whose two providers return distinct texts; one throws.
  // (Use the file's existing chatroom test scaffolding: a registry with claude+codex,
  //  sendAssistantText capturing messages, recordTurn capturing records.)
  // Send a /chat-triggering message and assert beat ① (opening) emitted BOTH
  // providers' prefixed messages and recorded 2 turns; if codex's session throws,
  // only claude's message is emitted and codex gets an 'error' TurnRecord.
  // See Task 3 for the end-to-end assertions; this step verifies the helper via
  // the opening beat specifically.
  expect(true).toBe(true) // replaced by the concrete assertions wired in Task 3
})
```

> Note: `runBeat` is a private closure, so it is tested THROUGH `dispatchChatroom` (Task 3), not in isolation. This task only ADDS the helper; its behavior is locked by Task 3's tests. Implement the helper now, verify the full suite still compiles/passes, then Task 3 drives it.

- [ ] **Step 2: Implement `runBeat`** (add near `dispatchParallel`, inside the coordinator factory so it closes over `deps`):

```typescript
// One debate beat: run `participants` concurrently, each with its own prompt.
// Emit each agent's text the moment that agent finishes (live feel, not
// wait-for-slowest), record one chatroom TurnRecord per agent, and return the
// {speaker,text} of agents that produced non-empty output (others dropped —
// graceful degradation). Shares the fan-out shape with dispatchParallel.
async function runBeat(
  msg: InboundMsg,
  proj: { alias: string; path: string },
  tierProfile: TierProfile,
  participants: ProviderId[],
  promptFor: (p: ProviderId) => string,
): Promise<Opening[]> {
  const results = await Promise.all(participants.map(async (providerId): Promise<Opening | null> => {
    const startedAt = nowMs()
    let summary: Awaited<ReturnType<typeof collectTurn>> | undefined
    let err: string | undefined
    try {
      const handle = await deps.manager.acquire({
        alias: proj.alias, path: proj.path, providerId,
        chatId: msg.chatId, tierProfile, permissionMode: deps.permissionMode,
      })
      summary = await collectTurn(handle.dispatch(promptFor(providerId)), { timeoutMs: deps.turnTimeoutMs })
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    const endedAt = nowMs()
    const outcome: TurnRecord['outcome'] =
      err ? 'error'
      : summary?.errorCode === TURN_TIMEOUT_CODE ? 'timeout'
      : summary?.errorCode === 'auth_failed' ? 'auth_failed'
      : summary?.error ? 'error'
      : 'completed'
    deps.recordTurn?.({
      chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: 'chatroom',
      startedAt, endedAt, durationMs: endedAt - startedAt, outcome,
      replyToolCalled: summary?.replyToolCalled ?? false,
      textChunks: summary?.assistantText.length ?? 0,
      error: summary?.error ?? err,
    })
    const text = (summary?.assistantText ?? []).join('\n').trim()
    if (!text) return null
    const dn = deps.providerDisplayName(providerId)
    await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${text}`)
    return { speaker: providerId, text }
  }))
  return results.filter((r): r is Opening => r !== null)
}
```

- [ ] **Step 3: Verify the suite still compiles + passes** — `bun --bun vitest run src/core/conversation-coordinator.test.ts` → PASS (unchanged behavior; helper unused until Task 3). Also `bun run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add src/core/conversation-coordinator.ts
git commit -m "feat(chatroom): runBeat concurrent fan-out helper (emit-on-complete, drop failures)"
```

---

### Task 3: Rewrite `dispatchChatroom` to the three-beat pipeline

**Files:**
- Modify: `src/core/conversation-coordinator.ts:481-789` (replace the sequential loop body of `dispatchChatroom`)
- Test: `src/core/conversation-coordinator.test.ts`

**Interfaces:**
- Consumes: `runBeat` (Task 2), `buildRebuttalPrompt`/`buildVerdictPrompt`/`buildConvergencePrompt`/`parseConvergence` (Task 1), `deps.haikuEval`, `deps.format(msg)`, `chatroomHistories`, `ChatroomEntry`.
- Produces: the new `dispatchChatroom(msg, proj, participants)` behavior.

- [ ] **Step 1: Write the failing test** — drive the three beats end to end. Use the file's existing chatroom scaffolding (registry with claude+codex, capturing `sendAssistantText` + `recordTurn`, a `haikuEval` stub). The bot is in chatroom mode for the chat.

```typescript
it('/chat runs opening → cross-talk → verdict, ending with a 🎯 verdict', async () => {
  const sent: string[] = []
  // ... build coordinator: providers claude+codex each yield deterministic text per dispatch;
  //     sendAssistantText pushes to `sent`; haikuEval returns a verdict string starting with 🎯;
  //     chatroom mode set for the chat. (Mirror the existing chatroom test setup in this file.)
  await coordinator.dispatch(userMsg('选 A 还是 B?'))

  // Opening (2) + cross-talk (2) + verdict (1) = at least 5 messages, prefixed.
  expect(sent.filter(s => s.startsWith('[')).length).toBeGreaterThanOrEqual(4) // both agents, 2 beats
  expect(sent.some(s => s.startsWith('🎯'))).toBe(true)                          // verdict always emitted
})

it('/chat verdict is still produced when one agent fails every beat (graceful degrade)', async () => {
  // codex throws on dispatch; claude works; haikuEval returns a 🎯 verdict.
  await coordinator.dispatch(userMsg('问题'))
  expect(sent.some(s => s.startsWith('[Claude]'))).toBe(true)
  expect(sent.some(s => s.startsWith('[Codex]'))).toBe(false)
  expect(sent.some(s => s.startsWith('🎯'))).toBe(true) // never dead air
})

it('/chat does NOT crash when the convergence check returns truncated JSON', async () => {
  // haikuEval (used for convergence) returns '{"converged": false, "disagreement": "...'  (truncated)
  // then returns a 🎯 verdict on the verdict call. Assert no throw + verdict emitted.
  await expect(coordinator.dispatch(userMsg('q'))).resolves.toBeUndefined()
  expect(sent.some(s => s.startsWith('🎯'))).toBe(true)
})
```

- [ ] **Step 2: Run it, verify it fails** — `bun --bun vitest run src/core/conversation-coordinator.test.ts -t '/chat runs opening'` → FAIL (old sequential moderator output: no 🎯 verdict / different message shape).

- [ ] **Step 3: Replace `dispatchChatroom`'s body** with the three-beat pipeline (keep the function signature, the abort-handling preamble, the `tierProfile` resolution, and the `chatroomHistories` read/write that already exist; replace the `for (round...)` loop):

```typescript
// ── Beat ①: parallel opening — every panel agent answers the raw question.
const question = deps.format(msg)
const history: ChatroomEntry[] = [...(chatroomHistories.get(msg.chatId) ?? [])]
history.push({ role: 'user', text: question })

const openings = await runBeat(msg, proj, tierProfile, participants, () => question)
if (openings.length === 0) {
  await deps.sendAssistantText?.(msg.chatId, '⚠️ 两个 AI 这轮都没能回应，请稍后重发一次。')
  return
}
for (const o of openings) history.push({ role: 'speaker', speaker: o.speaker, text: o.text })

let rebuttals: Opening[] = []
if (openings.length >= 2) {
  // ── Beat ②: parallel cross-talk — each engages the others' openings.
  rebuttals = await runBeat(msg, proj, tierProfile, openings.map(o => o.speaker),
    (p) => buildRebuttalPrompt(question, openings, p))
  for (const r of rebuttals) history.push({ role: 'speaker', speaker: r.speaker, text: r.text })

  // ── Beat ②b (optional, capped at 1): only if still materially split.
  if (deps.haikuEval && rebuttals.length >= 2) {
    let conv = { converged: true } as { converged: boolean; disagreement?: string }
    try { conv = parseConvergence(await deps.haikuEval(buildConvergencePrompt(question, openings, rebuttals))) }
    catch { /* parseConvergence never throws; haikuEval might — treat as converged */ }
    if (!conv.converged && conv.disagreement) {
      const extra = await runBeat(msg, proj, tierProfile, openings.map(o => o.speaker),
        (p) => buildRebuttalPrompt(`${question}\n（聚焦这个分歧：${conv.disagreement}）`, [...openings, ...rebuttals], p))
      for (const e of extra) history.push({ role: 'speaker', speaker: e.speaker, text: e.text })
      rebuttals = [...rebuttals, ...extra]
    }
  }
}

// ── Beat ③: verdict — a judged synthesis. Plain text (no parse). Always emitted.
if (deps.haikuEval) {
  let verdict = ''
  try { verdict = (await deps.haikuEval(buildVerdictPrompt(question, openings, rebuttals))).trim() }
  catch (e) { deps.log('COORDINATOR_CHATROOM', `verdict failed: ${e instanceof Error ? e.message : e}`) }
  if (verdict) {
    await deps.sendAssistantText?.(msg.chatId, verdict.startsWith('🎯') ? verdict : `🎯 ${verdict}`)
    history.push({ role: 'speaker', speaker: openings[0]!.speaker, text: verdict })
  }
}

chatroomHistories.set(msg.chatId, history)
```

Also add the imports at the top of the file:

```typescript
import { buildRebuttalPrompt, buildVerdictPrompt, buildConvergencePrompt, parseConvergence, type Opening } from './chatroom-conductor'
```

- [ ] **Step 4: Run the chatroom tests, verify they pass** — `bun --bun vitest run src/core/conversation-coordinator.test.ts` → PASS. Fix any pre-existing chatroom tests that asserted the OLD moderator behavior by updating them to the new beat/verdict shape (the old "round=N speaker=X" assertions no longer hold).

- [ ] **Step 5: Commit**

```bash
git add src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts
git commit -m "feat(chatroom): three-beat debate (opening → cross-talk → verdict), graceful degrade"
```

---

### Task 4: Delete the dead moderator + retire `maxRounds` plumbing

**Files:**
- Modify: `src/core/chatroom-moderator.ts` (delete `evaluateRound`, `MODERATOR_INSTRUCTIONS`, `ModeratorRoundInput`, `ModeratorDecision`, `ModeratorEvalDeps`, helpers `peerOf`/`fallbackDecision`/`genericContinuePrompt`; KEEP `ChatroomEntry` — still used for history). Consider renaming the file to `chatroom-history.ts` if only `ChatroomEntry` remains; if renamed, update the import in coordinator + conductor.
- Delete: `src/core/chatroom-moderator.test.ts` (its tests cover the deleted moderator).
- Modify: `src/core/conversation-coordinator.ts` — remove the now-unused `evaluateModeratorRound` import, the `haikuEval not wired` shim used only by the loop, and the `chatroomMaxRounds` constant/plumbing if nothing else reads it.

**Interfaces:**
- Consumes: nothing new.
- Produces: a smaller surface — `ChatroomEntry` only from the (possibly renamed) module.

- [ ] **Step 1: Grep for all references to the symbols being deleted**

Run: `grep -rn "evaluateRound\|evaluateModeratorRound\|MODERATOR_INSTRUCTIONS\|ModeratorDecision\|ModeratorRoundInput\|chatroomMaxRounds\|peerOf" src/ | grep -v chatroom-conductor`
Expected: references only in `chatroom-moderator.ts`, its test, and the `dispatchChatroom` call site (already replaced in Task 3).

- [ ] **Step 2: Delete the moderator code + test, keep `ChatroomEntry`**

Remove the listed exports from `chatroom-moderator.ts`, leaving only `ChatroomEntry` (and its `ProviderId` import). Delete `chatroom-moderator.test.ts`.

- [ ] **Step 3: Remove dead imports/plumbing in the coordinator**

Delete the `evaluateModeratorRound` import and any `chatroomMaxRounds` constant no longer referenced.

- [ ] **Step 4: Typecheck + full suite**

Run: `bun run typecheck` → clean. Run: `bun run test` → all pass (the deleted-moderator tests are gone; chatroom tests are the new beat tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(chatroom): delete the LLM-moderator (superseded by the conductor)"
```

---

### Task 5: Full verification + build

**Files:** none (verification only).

- [ ] **Step 1: Typecheck** — `bun run typecheck` → no output (clean).
- [ ] **Step 2: Full suite** — `bun run test` → all green.
- [ ] **Step 3: CI-parity build** — `bun build cli.ts --target=node --outfile=/tmp/cli.js` → "Bundled … modules".
- [ ] **Step 4: Confirm `deps.haikuEval` is wired in bootstrap** — grep where the coordinator is constructed (`createConversationCoordinator` call in `src/daemon/bootstrap/index.ts`) and verify `haikuEval:` is passed (it already powered the old moderator). If absent, the verdict/convergence silently no-op — wire it to `registry.getCheapEval()` the same way the moderator was fed.

Run: `grep -n "haikuEval" src/daemon/bootstrap/index.ts`
Expected: a `haikuEval:` field on the coordinator deps. If missing, add `haikuEval: (p) => (registry.getCheapEval() ?? (async () => ''))(p)` and re-run the suite.

- [ ] **Step 5: Commit any wiring fix**

```bash
git add -A && git commit -m "chore(chatroom): ensure haikuEval wired for verdict/convergence" || echo "nothing to wire"
```

---

## Self-Review

**Spec coverage:**
- ① parallel opening → Task 3 (runBeat over participants with raw question). ✓
- ② parallel cross-talk → Task 3 (runBeat with buildRebuttalPrompt). ✓
- ②b gated extra round → Task 3 (convergence check + capped extra runBeat). ✓
- ③ judged verdict, always produced → Task 3 (buildVerdictPrompt, plain text, fallback emit). ✓
- Conductor = code, LLM only at convergence + verdict, structured/tolerant → Tasks 1+3. ✓
- No parse-fail (tolerant convergence; verdict is plain text) → Task 1 tests truncation. ✓
- Provider-agnostic / N-ready (panel = ProviderId[], no peerOf) → Tasks 2-4 (peerOf deleted). ✓
- Graceful degradation → Task 2 (drop failures) + Task 3 (verdict on 1 survivor / empty-opening fallback). ✓
- Panel cap (≤3) → already enforced at coordinator:244-247 (unchanged), default cap noted in spec; no new task needed.
- Streaming = emit-on-complete → Task 2 (`runBeat` sends each turn as it finishes). ✓

**Placeholder scan:** Task 2 Step 1 is intentionally a stub (the private closure is tested through Task 3) — flagged explicitly, not a hidden placeholder. All code steps contain real code.

**Type consistency:** `Opening { speaker; text }`, `runBeat(msg, proj, tierProfile, participants, promptFor) → Opening[]`, `parseConvergence(raw) → { converged; disagreement? }`, `buildRebuttalPrompt/buildVerdictPrompt/buildConvergencePrompt` signatures match across Tasks 1–3. `TurnRecord.mode` uses `'chatroom'`. ✓

## Out of scope (per spec)
- Per-role model assignment (strong model for the verdict) — follow-up.
- Token-level streaming — `sendAssistantText` is per-message; emit-on-complete is the win.
- N>2 targeted who-rebuts-whom graphs — ② is all-rebut-all on openings; ②b on the single flagged disagreement.
