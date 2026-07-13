# Knowledge Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** A prompt section that teaches the agent its full "knowledge of a person" landscape (its .md memory + the loaded wx knowledge plugins) + how they compose + name-based resolution — so it stops ignoring the plugins.

**Architecture:** One prompt section adaptive to loaded plugins + a static arg threaded from bootstrap's `loadPlugins()` result. Same shape as the shipped persona/core-memory sections. Zero plugin-repo change.

**Tech Stack:** daemon TypeScript, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-11-knowledge-orchestration-design.md`. Rules: adaptive (render a line only for each KNOWN knowledge plugin present); known map = wxgraph→关系画像(contact_profile/top_contacts) / wxfacts→结构化事实(contact_facts/find_facts) / wxsearch→消息检索(search) / wxmedia→语音图片文字; wxvault NOT routed to; name-centric resolution; byte-identical when no known plugin present; placed after `memorySection()`.
- TDD; tsc clean; explicit `git add`.

### Task 1: `knowledgeOrchestrationSection` + arg

**Files:** `src/core/prompt-builder.ts` (+test)

- `export function knowledgeOrchestrationSection(pluginNames: string[]): string` — heading `## 你怎么了解一个人（知识编排）`. Opening: 你对一个人的了解由几层组成——你自己的记忆是你的"看法"(第一人称、可能有偏见);下面这些是从真实数据算出来的源。**要真正懂一个人,把你的看法 + 关系 + 事实拼起来,别只靠一层。用人名找人(按微信联系人名解析,同名可能对不准)。** Then render a bullet ONLY for each present known plugin:
  - if `pluginNames.includes('wxgraph')`: - **关系画像**(`contact_profile`/`top_contacts`):你俩的量化关系——亲密度/最近联系/往来是否平衡。问"我们关系怎么样"用它。
  - if `'wxfacts'`: - **结构化事实**(`contact_facts`/`find_facts`):抽取出的事实、义务、关系(带出处)。问"关于 ta 的具体事实 / ta 欠我什么"用它。
  - if `'wxsearch'`: - **消息检索**(`search`):语义找"那次聊到 X 的消息"。回溯具体对话用它。
  - if `'wxmedia'`: - 语音/图片转出的文字也在检索范围内。
  - Compute the "any known present" = intersection of pluginNames with `['wxgraph','wxfacts','wxsearch','wxmedia']`. Keep a KNOWN set as a const.
- `BuildSystemPromptArgs.knowledgePlugins?: string[]`. In buildSystemPrompt sections array, append `args.knowledgePlugins && <any known present> ? knowledgeOrchestrationSection(args.knowledgePlugins) : ''` placed IMMEDIATELY AFTER `memorySection()`. Do not reorder.
- [ ] Failing tests: section content (compose framing + name-resolution note); `['wxgraph','wxsearch']` ⇒ contains 关系画像 + 消息检索, NOT 结构化事实/语音; `['wxfacts']` ⇒ only facts line; strict `toBe` byte-identical when `knowledgePlugins` absent, `[]`, AND `['some-unknown-plugin']` (no known ⇒ omitted); placement after memorySection, no other section moved.
- [ ] RED→GREEN. `bun --bun vitest run src/core/prompt-builder.test.ts` + `bunx tsc --noEmit`.
- [ ] Commit: `feat(memory): knowledge-orchestration prompt section (compose memory + plugin sources)`.

### Task 2: bootstrap wiring + verification

**Files:** `src/daemon/bootstrap/index.ts` (+ `bootstrap.test.ts`)

- In `buildBootstrap`, near the existing `loadPlugins(...)` call (~line 534), compute the loaded ENABLED plugin names once: `const loadedPluginNames = loadPlugins({stateDir, bundledDir: bundledPluginsDir()}).filter(p => p.enabled).map(p => p.name)` (reuse the already-loaded result if one is in scope rather than re-calling — check; if `pluginMcp` was built from a `loadPlugins` result, capture that result's names instead of re-loading). Thread it into `buildSystemPrompt({... , knowledgePlugins: loadedPluginNames})` (buildInstructions closes over the bootstrap scope — pass the static list; it's daemon-global, not per-chat, so NOT a `*For(chatId)` thunk).
- [ ] Failing test (bootstrap.test.ts, mirror an existing buildInstructions test): with loaded plugins including `wxsearch`/`wxfacts` ⇒ built instructions contain the 知识编排 heading + those sources' lines; with none ⇒ absent (byte-identical). If the test harness can inject the loaded-plugin list, use it; else assert via the `knowledgePlugins` arg path.
- [ ] RED→GREEN. `bun --bun vitest run src/daemon/bootstrap.test.ts src/core/prompt-builder.test.ts` → `bunx tsc --noEmit` → full `bun --bun vitest run` (git-stash triage) → e2e (harness has no wx plugins ⇒ inert).
- [ ] Commit: `feat(memory): wire loaded knowledge-plugin names into the orchestration prompt`.

## Self-Review notes

Spec §2 → T1 (adaptive section + known map) / T2 (wiring from loadPlugins). Same pattern as core-memory (shipped). Byte-identical-off pinned in T1 (absent/[]/unknown-only). Static (daemon-global) not per-chat — a plain arg, not a thunk. wxvault deliberately excluded from the known map. Phase-2 (person_brief plugin, flow-back) out of scope.
