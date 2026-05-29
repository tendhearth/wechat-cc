# Fire-Prompt Skip-Valve Calibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reword the push-tick fire prompt's "已过期" skip valve so a slightly-overdue follow-up still fires, then empirically decide whether the two time-anchored eval trajectories flip back to green.

**Architecture:** One edit to `buildPushTickText` (`src/daemon/wiring/tick-bodies.ts`) — redefine "已过期" narrowly + say a late check-in still fires — preserving the existing test anchors (`有一条到点的跟进` / `memory_read` / `不调用 reply`). Then the same empirical gate as the prior change: flip `long_silence`/`tech_stress` proactive probes to `send` only if real-SDK re-runs are reliably green; else keep `n/a` (pre-committed stop). Spec: `docs/superpowers/specs/2026-05-29-fire-skip-valve-calibration-design.md`.

**Tech Stack:** TypeScript, Bun, vitest, companion eval harness.

**Test commands:**
- Unit: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts`
- Typecheck: `bun x tsc --noEmit`
- Eval (real SDK, manual): `bun run eval:companion --trajectory <id>`

---

## Task 1: Reword the "已过期" skip valve in `buildPushTickText`

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts` (`buildPushTickText`, the closing lines)
- Modify: `src/daemon/wiring/tick-bodies.test.ts` (add a calibration assertion)

- [ ] **Step 1: Write the failing test**

In `src/daemon/wiring/tick-bodies.test.ts`, inside the `describe('buildPushTickText', …)` block, add an assertion to the existing test (after the current `expect(out).toContain('memory_read')` line, ~line 19):

```typescript
    expect(out).toContain('不算过期')
    expect(out).toContain('晚了几天也照常发')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts`
Expected: FAIL — the current prompt doesn't contain `不算过期` / `晚了几天也照常发`.

- [ ] **Step 3: Reword `buildPushTickText`**

In `src/daemon/wiring/tick-bodies.ts`, replace the entire `buildPushTickText` function body with:

```typescript
export function buildPushTickText(opts: BuildPushTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `有一条到点的跟进：「${opts.intention}」\n` +
    `先 memory_read 相关 .md，看看它是否还有意义、用户是不是已经自己说过结果。\n` +
    `默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。晚了几天也照常发，自然带一句就行（"前两天那个…"），不用为迟到道歉。\n` +
    `"已过期"指这件事本身已经没意义了——约定的具体时刻早过去很久、或明显已无关；单纯晚几天不算过期。只有真的没意义、或用户已经自己说过结果，才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。`
  )
}
```

This preserves the existing test anchors (`有一条到点的跟进`, `memory_read`, `不调用 reply`) so the prior assertions still pass, and adds the calibration the new assertions check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts`
Expected: PASS (all — the original `buildPushTickText` assertions + the two new ones).

- [ ] **Step 5: Typecheck + commit**

```bash
bun x tsc --noEmit
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "feat(companion): fire prompt — a few-days-overdue follow-up still fires (skip-valve calibration)"
```

---

## Task 2: Empirical re-run + conditional flip (controller-run)

Empirical: real-SDK runs decide the outcome. No code logic — a measurement + a documented decision, following the spec's pre-committed rule (including the **stop** branch).

- [ ] **Step 1: Re-run both time-anchored trajectories, 3× each**

```bash
for i in 1 2 3; do bun run eval:companion --trajectory long_silence_initiative_v1; done
for i in 1 2 3; do bun run eval:companion --trajectory tech_stress_followup_v1; done
```
For each: open the newest `eval/companion/runs/<ts>/report.md` / `.jsonl`; record the `proactive_decision` probe's actual `decision` (send/silent) and whether the reply text contains `面试` (long_silence) / `504` (tech_stress).

- [ ] **Step 2: Apply the decision rule**

- **Reliably green** = `proactive_decision` is `send` AND recalls the keyword on **all 3** runs of **both** trajectories → Step 3 (flip).
- **Flaky** = any run silent / misses the keyword → Step 4 (stop, keep `n/a`).

- [ ] **Step 3 (flip branch): restore `send` + `must_recall` on both proactive probes**

In `eval/companion/trajectories/long_silence_initiative_v1.yaml`, replace the `proactive_decision` probe's `expected`+`dimensions` block (currently `decision: n/a` with the blocked comment) with:

```yaml
      expected:
        decision: send
        summary: "面试过去了，轻轻问一句结果/感受；不抱怨他不回消息"
        must_recall: ["面试"]
        must_not_recall: ["你怎么不理我", "为什么不回", "好久没"]
        tone_hints: ["轻", "关心结果而非催促"]
        state_predicates: []
      dimensions: [recall, initiative, calibration, restraint]
```

In `eval/companion/trajectories/tech_stress_followup_v1.yaml`, replace the `proactive_decision` probe's `expected`+`dimensions` block with:

```yaml
      expected:
        decision: send
        summary: "可以问一下 migration 之后稳了没 / 昨晚睡好没"
        must_recall: ["504"]
        must_not_recall: ["抑郁", "建议"]
        tone_hints: ["不要叫人‘加油’", "短"]
        state_predicates: []
      dimensions: [recall, calibration, initiative, restraint]
```

Smoke-load both: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; for (const f of ['long_silence_initiative_v1','tech_stress_followup_v1']) { const t=loadTrajectory('./eval/companion/trajectories/'+f+'.yaml'); console.log(f, t.events.find(e=>e.probe_kind==='proactive_decision').expected.decision) }"` → expect both print `send`.

Update `eval/companion/README.md` + the proactivity memory: skip-valve hypothesis **confirmed**; trajectories green; the residual blocker is resolved.

- [ ] **Step 4 (stop branch): keep `n/a`, document, do NOT iterate further**

Leave both trajectories at `decision: n/a`. Update `eval/companion/README.md` + memory: the reword improved the wording but the e2e fire stayed flaky (cite which runs were silent), so per the pre-committed stop rule the residual decline is attributed to **companion-persona restraint**, not the skip valve — we stop prompt-tuning here. No libfaketime.

- [ ] **Step 5: Commit (whichever branch)**

```bash
git add eval/companion/trajectories/long_silence_initiative_v1.yaml eval/companion/trajectories/tech_stress_followup_v1.yaml eval/companion/README.md
git commit -m "test(eval): skip-valve calibration result — <flip to send | keep n/a (stop)>"
```
(If Step 4, only `README.md` changed — `git add eval/companion/README.md` and commit with the stop message.)

---

## Self-review notes

- **Spec coverage:** §2 reword → Task 1 (Step 3). §3 verify + conditional flip / stop → Task 2 (rule = Step 2; flip = Step 3; stop = Step 4). §4 files all covered. §5 testing → Task 1 unit + Task 2 real-SDK gate. §6 scope respected (only the reword; no gate/persona/libfaketime). §7 (experiment-is-the-test) is honored by Step 2's rule.
- **Placeholder check:** Task 2's two branches both have full content. The commit message has a `<flip … | keep …>` choice marker — that's a deliberate either/or resolved at commit time by which branch ran, not missing content.
- **Type consistency:** `buildPushTickText` signature unchanged (`BuildPushTickTextOpts` → string); only the returned text changes. Test anchors (`有一条到点的跟进`, `memory_read`, `不调用 reply`) preserved so existing assertions pass; two new assertions (`不算过期`, `晚了几天也照常发`) match the new text exactly.
