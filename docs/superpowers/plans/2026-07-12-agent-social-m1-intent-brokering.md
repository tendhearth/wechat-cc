# Agent Social M1 — Intent Brokering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two paired friends' CCs broker a latent "seek" match — my agent raises an intent, targets candidate friends via wxgraph, exchanges *policy-filtered derived intent* over a new `/a2a/intent` A2A capability, and surfaces the match only on dual human confirmation.

**Architecture:** A new A2A capability (`POST /a2a/intent`) separate from the bare `/a2a/exec` path. The **answering** side (`social-answer`) spawns a one-shot agent turn WITH the owner's wx* plugin MCP tools (to judge a match against the owner's derived facts) and runs every outbound payload through a **disclosure gate**. The **initiating** side (`social-broker`) discovers candidates, sends Intent Cards via the existing `A2AClient`, correlates receipts, and drives the dual-confirm. Consent model: autonomous within policy; the commit needs both humans' yes.

**Tech Stack:** TypeScript, Bun test runner (`bun test`, vitest-compatible `describe/it/expect`), `zod` v4 (already a dep), the existing A2A modules (`a2a-server/client/registry`), `ProviderRegistry.getCheapEval()` for cheap-model gate/relevance calls.

## Global Constraints

- **Invariant 1 — exchange intent, not raw data.** Intent Cards and Match Receipts carry short, policy-filtered natural language only. Never a chat excerpt or a fact-store dump.
- **Invariant 2 — third-party rule.** No information about any contact other than the two peers may leave. In M1 this is enforced by the disclosure **checker's prompt** (not policy text alone, and not — yet — a code-level backstop) as part of the fail-closed `gateOutbound` pass; a genuine code-level name strip (matching outbound text against the owner's contact list) is deferred to v1+ / the T7b judge, which has plugin access to that list.
- **Invariant 3 — low interruption.** A non-match is a silent no-op; humans are interrupted only for a confirmable match.
- **Invariant 4 — consent = (b).** Compose/judge (steps ③④) are autonomous *within policy*; the commit (step ⑤ reveal) requires **both** humans' explicit confirmation via the `confirmWithOwner` seam.
- **Disclosure is defence-in-depth:** LLM self-adherence to the policy PLUS a mandatory `gateOutbound` cheap-model checker pass on every outbound payload. A leak is catastrophic — the second pass is not optional.
- **New surface stays separate** from `a2a-delegate.ts` / bare exec — distinct trust model, permissions, audit.
- **TDD**: every task writes the failing test first, watches it fail, implements minimally, watches it pass, commits.
- **Tests use `bun test <file>`**; never modify `package.json`/`bun.lock` (revert any bun auto-bump before committing); no `git add -A`.
- **API keys are env-only** (`WECHAT_OPENAI_API_KEY` etc.); base_url/model/policy live in `agent-config.json`.
- Default branch is `master`; integration branch is `dev`. Work on `feat/agent-social-m1`.

## Source of truth

Design spec: `docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md`. Vision + invariants: `docs/design/agent-social-network.md`.

---

## File Structure

- Create `src/core/a2a-intent.ts` — Intent Card + Match Receipt types + zod schemas. Pure.
- Create `src/core/a2a-disclosure.ts` — `gateOutbound()` (cheap-model checker + code-level third-party strip). Pure logic + injected `CheapEval`.
- Modify `src/core/a2a-server.ts` — add `/a2a/intent` route + `onIntent?` opt + advertise the `intent` capability.
- Create `src/core/social-answer.ts` — the answering handler: judge match against owner facts (via wx* MCP tools) → gated Match Receipt.
- Create `src/core/social-broker.ts` — the initiating side: discover (wxgraph) → send Intent Cards → correlate receipts → dual-confirm.
- Create `src/mcp-servers/wechat/tools-social.ts` — the `social_seek` MCP tool the operator's agent calls to raise an intent.
- Modify `src/lib/agent-config.ts` — `social_disclosure_policy?: string`, `social_enabled?: boolean`.
- Modify `src/core/capability-matrix.ts` — gate `social_seek` (admin auto; trusted/guest deny).
- Modify `src/daemon/bootstrap/index.ts` — wire `onIntent → social-answer`, construct `social-broker`, register `tools-social`.
- Create `src/core/social-m1.e2e.test.ts` — the two-instance AC1–AC5 harness.

---

## Task 1: Intent Card + Match Receipt schemas

**Files:**
- Create: `src/core/a2a-intent.ts`
- Test: `src/core/a2a-intent.test.ts`

**Interfaces:**
- Produces: `IntentCard`, `MatchReceipt` types; `IntentCardSchema`, `MatchReceiptSchema` (zod); `newIntentId()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { IntentCardSchema, MatchReceiptSchema, newIntentId } from './a2a-intent'

describe('a2a-intent schemas', () => {
  it('accepts a valid seek Intent Card', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '找周末拍照搭子', city: '南京', expires_at: new Date(0).toISOString() }
    expect(IntentCardSchema.parse(card)).toMatchObject({ kind: 'seek', topic: '找周末拍照搭子' })
  })
  it('rejects an Intent Card with an empty topic', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '', expires_at: new Date(0).toISOString() }
    expect(() => IntentCardSchema.parse(card)).toThrow()
  })
  it('accepts a yes Match Receipt with a blurb and a no Receipt without', () => {
    const id = newIntentId()
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'yes', blurb: '我主人也爱摄影' }).match).toBe('yes')
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'no' }).match).toBe('no')
  })
  it('newIntentId returns a non-empty unique-ish string', () => {
    expect(newIntentId()).not.toBe(newIntentId())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/a2a-intent.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export const IntentCardSchema = z.object({
  intent_id: z.string().min(1),
  kind: z.literal('seek'),                 // M1: seek only
  topic: z.string().min(1).max(280),       // policy-filtered NL — the intent, not raw data
  city: z.string().max(64).optional(),
  expires_at: z.string().min(1),           // ISO-8601; peer drops stale ones
})
export type IntentCard = z.infer<typeof IntentCardSchema>

export const MatchReceiptSchema = z.object({
  intent_id: z.string().min(1),
  match: z.enum(['yes', 'no']),
  blurb: z.string().max(280).optional(),   // only on yes; policy-filtered; NO contact info
})
export type MatchReceipt = z.infer<typeof MatchReceiptSchema>

export function newIntentId(): string { return randomUUID() }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/a2a-intent.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-intent.ts src/core/a2a-intent.test.ts
git commit -m "feat(social): Intent Card + Match Receipt schemas (M1 T1)"
```

---

## Task 2: Disclosure gate

**Files:**
- Create: `src/core/a2a-disclosure.ts`
- Test: `src/core/a2a-disclosure.test.ts`

**Interfaces:**
- Consumes: `CheapEval = (prompt: string) => Promise<string>` from `./agent-provider`.
- Produces: `gateOutbound(text: string, opts: { policy: string; peerNames: string[]; cheapEval: CheapEval }): Promise<{ ok: boolean; redacted: string; violations: string[] }>`.

**Design:** a single enforcement layer for third parties — the checker prompt itself. There is no code-level name strip: M1 cannot cheaply enumerate the owner's full contact list, so the `CHECKER_PROMPT` instructs the checker LLM that mentioning ANY person other than the sender's own owner and the recipient is forbidden, and any text naming a third party is blocked on the checker's verdict. A genuine code-level strip (matching outbound text against the owner's contact list) is deferred to v1+ / the T7b judge, which has plugin access to that list. The checker returns a strict JSON verdict; parse defensively — **on any parse failure or checker error, fail CLOSED** (block).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { gateOutbound } from './a2a-disclosure'

const policy = '可透露:兴趣爱好、大致意向、所在城市。不透露:住址、收入、健康、第三方好友。'

describe('gateOutbound', () => {
  it('passes clean, policy-compliant text unchanged', async () => {
    const cheapEval = async () => JSON.stringify({ violation: false, redacted: '我主人也爱摄影,周末常拍' })
    const r = await gateOutbound('我主人也爱摄影,周末常拍', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(true)
    expect(r.redacted).toContain('摄影')
  })
  it('blocks/redacts a forbidden disclosure (home address)', async () => {
    const cheapEval = async () => JSON.stringify({ violation: true, redacted: '我主人也爱摄影', reasons: ['泄露住址'] })
    const r = await gateOutbound('我主人住玄武区XX路12号,爱摄影', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
    expect(r.redacted).not.toContain('XX路')
    expect(r.violations.length).toBeGreaterThan(0)
  })
  it('fails CLOSED when the checker returns unparseable output', async () => {
    const cheapEval = async () => 'not json at all'
    const r = await gateOutbound('anything', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker throws', async () => {
    const cheapEval = async () => { throw new Error('model down') }
    const r = await gateOutbound('anything', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/a2a-disclosure.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import type { CheapEval } from './agent-provider'

const CHECKER_PROMPT = (policy: string, text: string) => `你是一个隐私披露审查器。判断下面这段"要发给一位已配对好友的 agent"的文本是否违反主人的披露策略。
铁律(高于策略):绝不能提到除"我主人"和"收件方"以外的任何第三方(其他人的名字/事);绝不含联系方式。
披露策略:
${policy}

待审文本:
"""${text}"""

只输出一行 JSON,无解释:{"violation": <true|false>, "redacted": "<把违规内容删干净后的安全文本;若无违规则原样返回>", "reasons": ["<简短原因>"]}`

export async function gateOutbound(
  text: string,
  opts: { policy: string; peerNames: string[]; cheapEval: CheapEval },
): Promise<{ ok: boolean; redacted: string; violations: string[] }> {
  let raw: string
  try {
    raw = await opts.cheapEval(CHECKER_PROMPT(opts.policy, text))
  } catch (err) {
    // Fail CLOSED — a disclosure leak is worse than a dropped match.
    return { ok: false, redacted: '', violations: ['checker_error: ' + (err instanceof Error ? err.message : String(err))] }
  }
  let parsed: { violation?: unknown; redacted?: unknown; reasons?: unknown }
  try {
    const m = raw.match(/\{[\s\S]*\}/)   // tolerate stray prose around the JSON
    parsed = JSON.parse(m ? m[0] : raw)
  } catch {
    return { ok: false, redacted: '', violations: ['checker_unparseable'] }
  }
  const violation = parsed.violation === true
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
  const redacted = typeof parsed.redacted === 'string' ? parsed.redacted : ''
  return violation
    ? { ok: false, redacted, violations: reasons.length ? reasons : ['policy_violation'] }
    : { ok: true, redacted: redacted || text, violations: [] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/a2a-disclosure.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-disclosure.ts src/core/a2a-disclosure.test.ts
git commit -m "feat(social): fail-closed disclosure gate (M1 T2)"
```

---

## Task 3: `/a2a/intent` route on the A2A server

**Files:**
- Modify: `src/core/a2a-server.ts` (add route + `onIntent?` opt + advertise capability)
- Test: `src/core/a2a-server.test.ts` (add cases mirroring the `/a2a/exec` tests)

**Interfaces:**
- Produces: `IntentEvent { agent: A2AAgentRecord; card: IntentCard }`; `A2AServerOpts.onIntent?: (e: IntentEvent) => Promise<MatchReceipt>`.
- Mirror the `/a2a/exec` handler at `a2a-server.ts:203` exactly for method/auth/body-validation/error shape.

- [ ] **Step 1: Write the failing test** (add to `a2a-server.test.ts`)

```ts
it('POST /a2a/intent runs onIntent and returns the Match Receipt', async () => {
  const registry = createA2ARegistry({ stateDir: mkRegDir('cca', 'k'.repeat(16)) }) // helper as in existing exec tests
  const srv = createA2AServer({
    host: '127.0.0.1', port: 0, registry, onNotify: async () => {},
    onIntent: async (e) => ({ intent_id: e.card.intent_id, match: 'yes', blurb: '也爱摄影' }),
    daemonInfo: { name: 'cc', version: '0' },
  })
  await srv.start()
  const res = await fetch(srv.baseUrl() + '/a2a/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'k'.repeat(16) },
    body: JSON.stringify({ agent_id: 'cca', card: { intent_id: 'i1', kind: 'seek', topic: '找摄影搭子', expires_at: new Date(Date.now()+60000).toISOString() } }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ intent_id: 'i1', match: 'yes' })
  await srv.stop()
})

it('POST /a2a/intent 401s without a valid bearer', async () => { /* mirror the exec missing_bearer test */ })
it('POST /a2a/intent 501s when onIntent is not wired', async () => { /* mirror exec_not_supported */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/a2a-server.test.ts`
Expected: FAIL (route returns 404 / onIntent undefined).

- [ ] **Step 3: Write minimal implementation**

In `a2a-server.ts`: add to `A2AServerOpts`:
```ts
  /** Optional. When wired, enables POST /a2a/intent — judge a peer's Intent
   *  Card against the owner's derived facts and return a Match Receipt.
   *  Undefined → /a2a/intent returns 501. */
  onIntent?: (event: IntentEvent) => Promise<MatchReceipt>
```
Add the types + import:
```ts
import { IntentCardSchema, type IntentCard, type MatchReceipt } from './a2a-intent'
export interface IntentEvent { agent: A2AAgentRecord; card: IntentCard }
```
Advertise (in `agentCard.capabilities`, guarded like exec):
```ts
      ...(opts.onIntent ? [{
        name: 'intent', description: 'Broker a "seek" intent: judge a match against my owner and return a policy-filtered Match Receipt.',
        endpoint: '/a2a/intent', method: 'POST',
        request_schema: { agent_id: 'string', card: 'IntentCard' },
      }] : []),
```
Add the route (mirror `/a2a/exec` auth block verbatim, then):
```ts
    if (url.pathname === '/a2a/intent') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onIntent) return new Response(JSON.stringify({ error: 'intent_not_supported' }), { status: 501 })
      let body: { agent_id?: unknown; card?: unknown }
      try { body = await req.json() as typeof body } catch { return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 }) }
      if (typeof body.agent_id !== 'string') return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      const claimedId = body.agent_id
      // ...COPY the exec Bearer/verifyBearer/id-mismatch/paused block verbatim (a2a-server.ts:218-232)...
      const parsed = IntentCardSchema.safeParse(body.card)
      if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid_card' }), { status: 400 })
      try {
        const receipt = await opts.onIntent({ agent, card: parsed.data })
        return new Response(JSON.stringify(receipt), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'intent_failed', detail: msg }), { status: 500 })
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/a2a-server.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/core/a2a-server.ts src/core/a2a-server.test.ts
git commit -m "feat(social): POST /a2a/intent capability (M1 T3)"
```

---

## Task 4: `social-answer` — the answering handler

**Files:**
- Create: `src/core/social-answer.ts`
- Test: `src/core/social-answer.test.ts`

**Interfaces:**
- Produces: `makeAnswerIntent(deps: AnswerDeps): (e: IntentEvent) => Promise<MatchReceipt>`.
- `AnswerDeps = { judge: (card: IntentCard) => Promise<{ match: 'yes'|'no'; blurb?: string }>; policy: string; cheapEval: CheapEval; peerNames?: string[] }`.
  - `judge` is the injected agent-turn seam (real one built in Task 7 from the provider registry WITH wx* plugin MCP tools so it reads the owner's derived facts; a fake in tests). This keeps social-answer pure + unit-testable with NO network.

**Behaviour:** call `judge(card)`. If `match==='no'` → return `{ intent_id, match:'no' }` (no blurb, silent). If `'yes'` → run the blurb through `gateOutbound`; if the gate blocks, DOWNGRADE to `match:'no'` (never leak) rather than sending a partial; if it passes, return `{ intent_id, match:'yes', blurb: gated.redacted }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { makeAnswerIntent } from './social-answer'

const base = { policy: '兴趣可说;住址不可', cheapEval: async () => JSON.stringify({ violation: false, redacted: '我主人也爱摄影' }) }
const card = { intent_id: 'i1', kind: 'seek' as const, topic: '找摄影搭子', expires_at: new Date(Date.now()+60000).toISOString() }

describe('makeAnswerIntent', () => {
  it('yes + clean blurb passes through the gate', async () => {
    const answer = makeAnswerIntent({ ...base, judge: async () => ({ match: 'yes', blurb: '我主人也爱摄影' }) })
    const r = await answer({ agent: { id: 'cca' } as any, card })
    expect(r).toMatchObject({ intent_id: 'i1', match: 'yes' })
    expect(r.blurb).toContain('摄影')
  })
  it('non-match returns a silent no with no blurb', async () => {
    const answer = makeAnswerIntent({ ...base, judge: async () => ({ match: 'no' }) })
    expect(await answer({ agent: { id: 'cca' } as any, card })).toEqual({ intent_id: 'i1', match: 'no' })
  })
  it('DOWNGRADES to no when the gate blocks the blurb (never leak)', async () => {
    const answer = makeAnswerIntent({
      ...base,
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['住址'] }),
      judge: async () => ({ match: 'yes', blurb: '我主人住XX路,爱摄影' }),
    })
    const r = await answer({ agent: { id: 'cca' } as any, card })
    expect(r).toEqual({ intent_id: 'i1', match: 'no' })   // gate block => no leak, no match
  })
})
```

- [ ] **Step 2: Run** `bun test src/core/social-answer.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { CheapEval } from './agent-provider'
import type { IntentCard, MatchReceipt } from './a2a-intent'
import type { IntentEvent } from './a2a-server'
import { gateOutbound } from './a2a-disclosure'

export interface AnswerDeps {
  judge: (card: IntentCard) => Promise<{ match: 'yes' | 'no'; blurb?: string }>
  policy: string
  cheapEval: CheapEval
  peerNames?: string[]
}

export function makeAnswerIntent(deps: AnswerDeps): (e: IntentEvent) => Promise<MatchReceipt> {
  return async (e) => {
    const id = e.card.intent_id
    const verdict = await deps.judge(e.card)
    if (verdict.match !== 'yes' || !verdict.blurb) return { intent_id: id, match: 'no' }
    const gated = await gateOutbound(verdict.blurb, { policy: deps.policy, peerNames: deps.peerNames ?? [], cheapEval: deps.cheapEval })
    if (!gated.ok) return { intent_id: id, match: 'no' }   // never leak a partial — downgrade
    return { intent_id: id, match: 'yes', blurb: gated.redacted }
  }
}
```

- [ ] **Step 4: Run** `bun test src/core/social-answer.test.ts` → PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/core/social-answer.ts src/core/social-answer.test.ts
git commit -m "feat(social): answering handler with gate-or-downgrade (M1 T4)"
```

---

## Task 5: `social-broker` — the initiating side

**Files:**
- Create: `src/core/social-broker.ts`
- Test: `src/core/social-broker.test.ts`

**Interfaces:**
- Produces: `makeBroker(deps: BrokerDeps): { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }`.
- `BrokerDeps = { discover: (topic: string) => Promise<A2AAgentRecord[]>; send: (hand: A2AAgentRecord, card: IntentCard) => Promise<MatchReceipt | null>; confirmWithOwner: (summary: string) => Promise<boolean>; confirmPeer: (hand: A2AAgentRecord, card: IntentCard) => Promise<boolean>; policy: string; cheapEval: CheapEval; ttlMs?: number }`.
  - `send` = `delegateToHand`-style wrapper over `A2AClient` hitting the peer's `/a2a/intent` (real one in Task 7; fake in tests).
  - `confirmPeer` asks the matched peer's owner to confirm — in M1 this is the SAME `/a2a/intent` peer being asked (via a second A2A round or a flag); model it as an injected seam so the broker logic is testable. (Impl in Task 7 reuses the peer's confirm surface.)
- `SeekOutcome = { intent_id: string; matched: Array<{ hand: string; blurb?: string }>; lit: string[] }` (`lit` = peers where BOTH confirmed).

**Behaviour:**
1. Build an `IntentCard` (topic gated through `gateOutbound` before it leaves; if the gate blocks the topic, abort with empty outcome — never send a leaky intent).
2. `discover(topic)` → candidates (targeted).
3. `send` the card to each; collect `match:'yes'` receipts.
4. For each yes: `confirmWithOwner(「<hand> 也<blurb>,牵个线?」)` AND `confirmPeer(...)`. Only when BOTH true → add to `lit`.
5. Return the outcome. Never reveal anything for a peer not in `lit`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { makeBroker } from './social-broker'

const cheapEval = async () => JSON.stringify({ violation: false, redacted: '找摄影搭子' })
const peerB = { id: 'ccb', name: 'CC-B' } as any

describe('makeBroker.seek', () => {
  it('AC1 happy path: yes receipt + both confirms → lit', async () => {
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'yes', blurb: '也爱摄影' }),
      confirmWithOwner: async () => true,
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找摄影搭子')
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
    expect(out.lit).toEqual(['ccb'])
  })
  it('AC5 no reveal if either side declines', async () => {
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'yes', blurb: '也爱摄影' }),
      confirmWithOwner: async () => true,
      confirmPeer: async () => false,          // peer's owner declines
    })
    const out = await broker.seek('找摄影搭子')
    expect(out.lit).toEqual([])                // matched but NOT lit
  })
  it('AC2 non-match → nothing matched, nobody asked to confirm', async () => {
    let askedOwner = 0
    const broker = makeBroker({
      policy: 'p', cheapEval,
      discover: async () => [peerB],
      send: async () => ({ intent_id: 'x', match: 'no' }),
      confirmWithOwner: async () => { askedOwner++; return true },
      confirmPeer: async () => true,
    })
    const out = await broker.seek('找打篮球的')
    expect(out.matched).toEqual([])
    expect(askedOwner).toBe(0)
  })
  it('aborts (sends nothing) if the gate blocks the intent topic', async () => {
    let sent = 0
    const broker = makeBroker({
      policy: 'p',
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['leak'] }),
      discover: async () => [peerB],
      send: async () => { sent++; return { intent_id: 'x', match: 'yes' } },
      confirmWithOwner: async () => true, confirmPeer: async () => true,
    })
    const out = await broker.seek('涉密意图')
    expect(sent).toBe(0)
    expect(out.matched).toEqual([])
  })
})
```

- [ ] **Step 2: Run** `bun test src/core/social-broker.test.ts` → FAIL.

- [ ] **Step 3: Implement** (`social-broker.ts`)

```ts
import type { CheapEval } from './agent-provider'
import type { A2AAgentRecord } from '../lib/agent-config'
import { newIntentId, type IntentCard, type MatchReceipt } from './a2a-intent'
import { gateOutbound } from './a2a-disclosure'

export interface BrokerDeps {
  discover: (topic: string) => Promise<A2AAgentRecord[]>
  send: (hand: A2AAgentRecord, card: IntentCard) => Promise<MatchReceipt | null>
  confirmWithOwner: (summary: string) => Promise<boolean>
  confirmPeer: (hand: A2AAgentRecord, card: IntentCard) => Promise<boolean>
  policy: string
  cheapEval: CheapEval
  ttlMs?: number
}
export interface SeekOutcome { intent_id: string; matched: Array<{ hand: string; blurb?: string }>; lit: string[] }

export function makeBroker(deps: BrokerDeps) {
  return {
    async seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> {
      const intent_id = newIntentId()
      // Gate the OUTBOUND intent topic before it ever leaves.
      const gated = await gateOutbound(topic, { policy: deps.policy, peerNames: [], cheapEval: deps.cheapEval })
      if (!gated.ok) return { intent_id, matched: [], lit: [] }
      const ttl = deps.ttlMs ?? 10 * 60_000
      const card: IntentCard = { intent_id, kind: 'seek', topic: gated.redacted, ...(opts?.city ? { city: opts.city } : {}), expires_at: new Date(Date.now() + ttl).toISOString() }
      const candidates = await deps.discover(gated.redacted)
      const matched: Array<{ hand: A2AAgentRecord; blurb?: string }> = []
      for (const hand of candidates) {
        const r = await deps.send(hand, card)
        if (r && r.match === 'yes') matched.push({ hand, blurb: r.blurb })
      }
      const lit: string[] = []
      for (const m of matched) {
        const mine = await deps.confirmWithOwner(`${m.hand.name}${m.blurb ? ' ' + m.blurb : ''},牵个线?`)
        const theirs = mine ? await deps.confirmPeer(m.hand, card) : false
        if (mine && theirs) lit.push(m.hand.id)
      }
      return { intent_id, matched: matched.map(m => ({ hand: m.hand.id, blurb: m.blurb })), lit }
    },
  }
}
```

Note (Date.now): daemon runtime allows `Date.now()`; only workflow scripts forbid it. Fine here.

- [ ] **Step 4: Run** `bun test src/core/social-broker.test.ts` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add src/core/social-broker.ts src/core/social-broker.test.ts
git commit -m "feat(social): initiating broker — discover/send/dual-confirm (M1 T5)"
```

---

## Task 6: `social_seek` MCP tool + tier gating

**Files:**
- Create: `src/mcp-servers/wechat/tools-social.ts` (mirror `tools-a2a.ts` shape at `src/mcp-servers/wechat/tools-a2a.ts:11`)
- Modify: `src/core/capability-matrix.ts` (gate `social_seek`: admin auto; trusted/guest deny — mirror the `a2a_send` gating rows)
- Test: `src/core/capability-matrix.test.ts` (add `social_seek` gating cases mirroring `a2a_send`)

**Interfaces:**
- Produces MCP tool `social_seek({ topic: string, city?: string })` → calls internal-api `POST /v1/social/seek` (route added in Task 7) → returns the `SeekOutcome`.

- [ ] **Step 1:** Write the failing capability-matrix test: `social_seek` is in admin `allow`, and in trusted/guest `deny`. Run → FAIL.
- [ ] **Step 2:** Add the gating rows in `capability-matrix.ts` mirroring `a2a_send`; add `tools-social.ts` registering the tool (mirror `registerA2ASendTool`). Run → PASS.
- [ ] **Step 3: Commit**

```bash
git add src/mcp-servers/wechat/tools-social.ts src/core/capability-matrix.ts src/core/capability-matrix.test.ts
git commit -m "feat(social): social_seek MCP tool + admin-only gating (M1 T6)"
```

---

## Task 7: Bootstrap wiring + config + internal-api route

**Files:**
- Modify: `src/lib/agent-config.ts` — add `social_enabled?: boolean` + `social_disclosure_policy?: string` to the schema (mirror the existing optional string fields).
- Modify: `src/daemon/bootstrap/index.ts` — construct the real `judge`, `send`, `confirm*`, `discover` seams and wire them.
- Modify: `src/daemon/internal-api/routes-a2a.ts` (or a new `routes-social.ts`) — `POST /v1/social/seek` → `broker.seek(topic, { city })`.
- Test: `src/daemon/bootstrap.test.ts` — add: `onIntent` wired iff `social_enabled` + policy present; `/v1/social/seek` returns 503 when broker not wired.

**Real seam construction (in bootstrap, only when `social_enabled` + `social_disclosure_policy`):**
- `cheapEval = registry.getCheapEval()`.
- `judge`: a one-shot turn against the daemon's provider WITH the wx* plugin MCP tools so it reads the owner's derived facts. Construct like the main openai provider block (`bootstrap/index.ts:917`) but via `buildOpenaiMcpSpecs({ wechat: null, delegate: null, pluginMcp })` — plugin tools ONLY, NO wechat tools (the answerer must not be able to send as the owner). System prompt: "You represent <owner>. Read their facts via the wx* tools; decide if they match this seek intent; output ONLY {match, blurb}. Never reveal raw facts; obey the disclosure policy: <policy>." Parse the model's final JSON into `{match, blurb}`.
- `answerIntent = makeAnswerIntent({ judge, policy, cheapEval })`; wire `createA2AServer({ ..., onIntent: answerIntent })`.
- `send`: `async (hand, card) => { const r = await client.send({ url: intentUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SELF_ID, card } }); return r.ok ? MatchReceiptSchema.parse(r.response) : null }` (add `intentUrl()` next to `handExecUrl` in `a2a-delegate.ts`, deriving `/a2a/intent`).
- `confirmWithOwner`: `async (summary) => askOperatorYesNo(summary)` — surface via `sendAssistantText(operatorChatId, '🤝 ' + summary + '(回复 是/否)')` and capture the operator's next 1:1 reply through the coordinator inbound pipeline. **Sub-step 7a** builds `askOperatorYesNo` as a small pending-question map keyed by operator chatId (resolve on next inbound; timeout → false). Unit-test it in isolation.
- `confirmPeer`: `async (hand, card) => { const r = await client.send({ url: intentUrl(hand.url) + '/confirm', bearer: hand.outbound_api_key, body: { agent_id: SELF_ID, intent_id: card.intent_id } }); return r.ok && (r.response as any)?.ok === true }`. Add a `/a2a/intent/confirm` sub-route (Task 3 pattern) whose handler calls the peer's own `confirmWithOwner`.
- `discover`: `async (topic) => rankByWxgraph(registry.list(), topic, cheapEval)` — query the wxgraph plugin MCP for top contacts, keep only those that are also paired A2A peers (`registry.list()`), cheap-eval topical relevance, cap at N=5; fallback to all paired peers if wxgraph absent.

- [ ] Steps: write the bootstrap wiring test first (FAIL), implement the seam construction + route + `askOperatorYesNo` (with its own unit test), verify the bootstrap test + `bun test src/daemon/bootstrap.test.ts` PASS, commit.

```bash
git commit -m "feat(social): bootstrap wiring, config, /v1/social/seek + owner-confirm capture (M1 T7)"
```

---

## Task 8: Two-instance end-to-end verification (AC1–AC5)

**Files:**
- Create: `src/core/social-m1.e2e.test.ts` (marked `describe.skipIf(!process.env.WECHAT_OPENAI_API_KEY)` so CI without a model key skips it — mirror the plugin suite's integration-gating)

**Behaviour:** stand up two real `createA2AServer` instances (like `scratchpad/cc2cc-spike.ts`), each with a persona-injected `judge` and a disclosure policy, cross-registered for auth, `confirmWithOwner`/`confirmPeer` as injected callbacks. Drive `broker.seek` on instance A and assert the ACs against instance B.

- [ ] **AC1**: A `seek('找摄影搭子')`, B judges yes (persona: photography) → `out.lit === ['ccb']`, blurb present.
- [ ] **AC2**: A `seek('找打篮球的')`, B judges no → `out.matched === []`, B's owner never asked.
- [ ] **AC3**: B's persona facts include a home address; force a scenario; assert NO outbound receipt over the wire contains the address (inspect the HTTP body B returns).
- [ ] **AC4**: intent whose answer would name a mutual friend → the third party never appears in any receipt.
- [ ] **AC5**: `confirmPeer` returns false → `out.lit === []`, nothing revealed.
- [ ] **Commit**

```bash
git add src/core/social-m1.e2e.test.ts
git commit -m "test(social): two-instance AC1-AC5 e2e harness (M1 T8)"
```

---

## Self-review checklist (done)

- **Spec coverage:** ①intent→②discover→③card→④judge/receipt→⑤dual-confirm all mapped (T5 broker + T4/T7 answer). Disclosure gate (T2) enforced on every outbound (T4 blurb, T5 topic). Third-party rule in the checker prompt + AC4. Consent=(b): T5 requires both `confirmWithOwner` + `confirmPeer`; AC5. New capability separate from exec (T3). Non-goals honored (seek-only schema T1; no pairing/strangers/calendar).
- **Type consistency:** `IntentCard`/`MatchReceipt` from T1 used identically in T3/T4/T5/T7; `IntentEvent` defined in T3, consumed in T4. `CheapEval` signature matches `agent-provider.ts:73`.
- **Placeholders:** none — integration tasks (T7) name the exact functions to mirror (`bootstrap/index.ts:917`, `buildOpenaiMcpSpecs`, `handExecUrl`, `getCheapEval`, `sendAssistantText`) with concrete signatures.
