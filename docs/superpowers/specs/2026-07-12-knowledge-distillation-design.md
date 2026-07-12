# Design: Knowledge distillation → always-on memory (D1 — unify the person model, v1)

Date: 2026-07-12
Status: approved design → implementation
Origin: architecture debt **D1** (`docs/architecture.md §5`). The person model is fragmented: the daemon's always-on memory (`profile.md`, injected as core memory) is the bot's *subjective take*, while the plugins' *computed data* (wxfacts obligations, wxgraph relationships) only reach the agent if it manually calls `person_brief`. The two knowledge systems never meet in the always-on path. This is v1 of closing that: the daemon **distills** the plugin's computed knowledge into a daemon-owned memory file that is injected every turn — so the objective facts sit beside the subjective take in every prompt. See [[architecture-direction-2026]], [[architecture]].

## 1. What

A daemon-owned `knowledge.md` per chat (distinct from the agent-authored `profile.md`), written by a **deterministic** (no-LLM) distillation of the plugin knowledge, and injected always-on via a new prompt section — mirroring the shipped core-memory-injection pattern exactly.

**v1 scope = the owner's social state** (no fragile chatId→contact-name join needed — the owner's social state is global): open obligations + key relationships + neglected relationships. `person_brief` remains the on-demand deep-dive for a *specific* contact; this is the always-present baseline.

## 2. Locked decisions

- **Separate file, daemon-owned.** `memory/<chatId>/knowledge.md` — NOT `profile.md` (that's the agent's authored take; the daemon must not clobber it). Naturally excluded from the gardener (its candidates are `profile.md`/`notes/`/`preferences.md`). profile.md = 主观看法; knowledge.md = 算出来的客观事实; both injected → composed in the prompt.
- **Deterministic distillation, no LLM.** The plugin outputs are already structured; format them directly (cheaper + no LLM-quality/refusal risk). `distillOwnerKnowledge(bridge)`:
  - obligations ← `wxfacts.find_facts({kind:'obligation', status:'active', limit:20})` → `.results`
  - close ← `wxgraph.top_contacts({by:'closeness', limit:5, kind:'person'})`
  - neglected ← `wxgraph.top_contacts({by:'neglected', limit:5, kind:'person'})`
  - Each source guarded (missing tool / parse fail → that subsection omitted). All empty → returns `''` (⇒ no file written, section omitted).
  - Output markdown, capped at `KNOWLEDGE_MEMORY_MAX_CHARS = 1500` (same belt as core memory):
    ```
    ## 你的社交状态（算出来的，非主观）
    **未了义务**
    - <predicate> <value>（<related/contact display>）
    **亲近的人**
    - 张三、李四、…
    **好久没联系**
    - 王五、…
    ```
- **Written by the ingest tick.** After `runIngestCycle` (facts/graph are freshest then), if `default_chat_id` is set AND the bridge has the tools, distill → write `memory/<ownerChatId>/knowledge.md` (or delete/skip if empty). Reuses the tick's existing `createResilientBridge` + `makeMemoryFS`. No new scheduler.
- **Injected always-on**, mirroring core memory: `BootstrapDeps.knowledgeMemoryFor?(chatId)` reads `memory/<chatId>/knowledge.md` capped → `buildInstructions` passes `knowledgeMemory` → `buildSystemPrompt` appends `knowledgeMemorySection(content)` **immediately after** `coreMemorySection` (the two memory halves together, before the knowledge-orchestration routing section). Byte-identical prompt when absent/empty.

## 3. Non-goals (v1)

- The chatId→contact-name join + per-contact `knowledge.md` (only the owner's global social state in v1).
- Feeding plugin data into the *gated* `synthesizeOverview` LLM narrative (a later, larger merge).
- Reconciling the two extraction pipelines (`threads` vs `wxfacts`) — separate debt item.
- Any LLM in the distillation; any change to `person_brief` / core-memory / the plugins.

## 4. Testing

- `distillOwnerKnowledge` (fake bridge): obligations+close+neglected present ⇒ markdown with all three subsections, values from the fake results; a missing tool (`hasTool` false) ⇒ that subsection omitted, others present; all-absent ⇒ `''`; output capped at 1500 + truncation note; a source returning malformed JSON ⇒ that subsection omitted, no throw.
- `knowledgeMemorySection`: heading + framing + content; `BuildSystemPromptArgs.knowledgeMemory` gated; byte-identical `toBe` when absent AND when whitespace; placed immediately after core memory, no other section moved.
- bootstrap: `knowledgeMemoryFor` returning content ⇒ built instructions contain it + the heading; absent ⇒ byte-identical.
- ingest-tick hook: with a fake bridge + a configured `default_chat_id`, a cycle writes `knowledge.md` with the distilled content; no `default_chat_id` ⇒ not written; empty distillation ⇒ not written (or removed).
- Full daemon suite + e2e green (e2e harness: no plugins ⇒ distill no-op ⇒ inert).
