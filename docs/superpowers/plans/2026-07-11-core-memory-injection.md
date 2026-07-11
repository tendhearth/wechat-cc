# Core Memory Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject each chat's `profile.md` (capped) as an always-in-context "core memory" block into every reply turn's system prompt, so the CC always knows who it's talking to without a retrieval call.

**Architecture:** One prompt section + one bootstrap thunk + main wiring — identical shape to the already-shipped `personaFor`/`stickerTagsFor` pattern. Zero new tools/stores.

**Tech Stack:** daemon TypeScript, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-11-core-memory-injection-design.md`. Rules: source = `memory/<chatId>/profile.md` (the CHAT's own, per-chat); cap injected text at `CORE_MEMORY_MAX_CHARS = 1500` + truncation note if over; byte-identical prompt when core memory absent/empty; placed right AFTER the persona section; no tier gate; read FRESH per spawn; NO change to memory_read/gardener.
- TDD; tsc clean; explicit `git add`.

### Task 1: `coreMemorySection` prompt section + arg

**Files:** `src/core/prompt-builder.ts` (+test)

- `export const CORE_MEMORY_MAX_CHARS = 1500`.
- `export function coreMemorySection(content: string): string` — heading `## 核心记忆（你眼中的 ta）`, body: 这是你此刻对这个人最核心的了解(来自 profile),始终加载、不用查。更细的东西在长期记忆里,需要时用 `memory_read`。 then the content. The CALLER passes already-capped content (Task 2 caps it) — but as a belt, if `content.length > CORE_MEMORY_MAX_CHARS` slice to CORE_MEMORY_MAX_CHARS and append `\n（核心记忆已截断;完整 profile 用 memory_read）`.
- `BuildSystemPromptArgs.coreMemory?: string`; buildSystemPrompt appends `args.coreMemory && args.coreMemory.trim().length > 0 ? coreMemorySection(args.coreMemory) : ''`, placed immediately AFTER the persona section slot (identity cluster), before the tool/capability sections.
- [ ] Failing tests (mirror `personaSection` tests): section contains the 核心记忆 framing + the content; a 2000-char content ⇒ rendered section bounded (sliced to 1500 + the truncation note present); strict `toBe` byte-identical when coreMemory absent AND when `'  '`; placement — persona-only vs persona+core, and confirm NO other section moved (byte-identical for all non-core configs).
- [ ] RED→GREEN. `bun --bun vitest run src/core/prompt-builder.test.ts` + `bunx tsc --noEmit`.
- [ ] Commit: `feat(memory): core-memory prompt section (always-loaded profile block)`.

### Task 2: bootstrap thunk + main wiring + verification

**Files:** `src/daemon/bootstrap/index.ts`, `src/daemon/main.ts` (+ `bootstrap.test.ts`)

- `BootstrapDeps.coreMemoryFor?: (chatId: string) => string` (doc mirroring `personaFor`: reads the chat's own profile.md, capped; absent ⇒ core section omitted). buildInstructions: `coreMemory: deps.coreMemoryFor?.(chatId)`.
- main.ts (next to `personaFor`/`stickerTagsFor`): wire
```ts
coreMemoryFor: (c) => {
  const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
  const profile = fs.read('profile.md') ?? ''
  return profile.length > CORE_MEMORY_MAX_CHARS ? profile.slice(0, CORE_MEMORY_MAX_CHARS) : profile
},
```
(import `CORE_MEMORY_MAX_CHARS` from prompt-builder; verify `makeMemoryFS`'s exact import path + `read` signature — same as the persona wiring reads persona.md. Reads the CHAT's own dir `memory/<c>/`, NOT the owner's. If constructing makeMemoryFS per call is heavy, mirror whatever personaFor does.)
- [ ] Failing tests (bootstrap.test.ts, mirror the personaFor cases): `coreMemoryFor` returns "张三是产品经理" ⇒ instructions contain it + the 核心记忆 heading; absent dep ⇒ byte-identical (no core section). (main.ts's per-chat-dir read + cap: a targeted test if the harness allows, else covered by the wiring + Task-1 cap test.)
- [ ] RED→GREEN. `bun --bun vitest run src/daemon/bootstrap.test.ts src/core/prompt-builder.test.ts` → `bunx tsc --noEmit` → full `bun --bun vitest run` (git-stash triage) → e2e `bun --bun vitest run -c vitest.e2e.config.ts` (harness chats have no profile.md ⇒ inert).
- [ ] Commit: `feat(memory): wire per-chat core memory (profile.md) into every turn`.

## Self-Review notes

Spec §2 → T1 (section+cap) / T2 (thunk+wiring). Identical to the shipped personaFor pattern (read a memory file per-spawn, inject a gated section) — lowest-risk. Names: `coreMemory`/`coreMemoryFor`/`CORE_MEMORY_MAX_CHARS` T1↔T2. Per-chat dir (not owner) is the one thing to verify in T2's main wiring (persona reads owner dir; core reads the CURRENT chat's dir). Byte-identical-off pinned in T1. v2 (preferences/threads/semantic retrieval) explicitly out.
