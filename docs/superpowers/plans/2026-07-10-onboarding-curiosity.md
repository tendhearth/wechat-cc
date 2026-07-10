# 冷启动懂你 (Onboarding Curiosity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New-relationship curiosity prompt section (auto-retires by message count, tier-gated) + empty-persona seed-question nudge.

**Architecture:** Two prompt-builder changes + one sync count helper + one bootstrap thunk + main wiring. Zero new tools/stores/routes.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-onboarding-curiosity-design.md`. Threshold const `NEW_RELATIONSHIP_MSG_COUNT = 50` (in main.ts wiring or messages-store — pick messages-store, exported, single source). Sync count (buildInstructions is sync). Byte-identical prompts when gates off. newRelationship requires `tierProfile.allow.has('memory_write')` (bootstrap AND, like careEnabled). Deterministic onboarding untouched.
- TDD; tsc clean; explicit `git add`.

### Task 1: prompt sections

**Files:** `src/core/prompt-builder.ts` (+test)

- `export function newRelationshipSection(): string` — heading `## 刚认识(了解 ta)`: 你们还在刚认识的阶段。回复之余,自然地带一点好奇——一次最多一个问题,了解 ta 是做什么的、在意什么、作息和忙闲、喜欢被怎么称呼和怎么说话。听到值得记的就写进 memory(notes/observations)。别像查户口:有自然话头才问,没有就不问;别每条回复都带问题。等你对 ta 足够了解,这个阶段就过去了。
- `BuildSystemPromptArgs.newRelationship?: boolean`; appended when `=== true`, placed after `careSection`'s slot (relationship guidance cluster).
- `personaCultivationSection(opts?: { personaEmpty?: boolean })` — signature change (existing callers pass nothing = no nudge; update buildSystemPrompt call to pass `{ personaEmpty: args.personaEmpty === true }`); when personaEmpty, append line: persona.md 现在还是空的——找一个早期的自然时机问一句:「想要我是什么风格/性格吗?有想对标的人也行」,把答案整理进 persona.md(没答也没关系,从相处里慢慢长)。New arg `BuildSystemPromptArgs.personaEmpty?: boolean`.
- Tests (mirror careSection tests): section content; gating byte-identical (`toBe`) for newRelationship absent/false AND personaEmpty absent/false (with personaCultivate true — nudge line absent); nudge line present when both cultivate+empty.
- Commit: `feat(onboarding): new-relationship curiosity section + empty-persona seed nudge`.

### Task 2: count helper + wiring + verification

**Files:** `src/lib/messages-store.ts` (+test), `src/daemon/bootstrap/index.ts`, `src/daemon/main.ts` (+bootstrap.test.ts)

- messages-store: `export const NEW_RELATIONSHIP_MSG_COUNT = 50` + `export function countMessagesSync(db: Db, chatId: string): number` (prepared `SELECT COUNT(*) as n FROM messages WHERE chat_id = ?` — statement can be module-level-per-call or prepared inside; match file style; it must be SYNC — bun:sqlite `.get()` is sync). Tests: 0 for unknown; counts both directions; other chats isolated.
- bootstrap: `BootstrapDeps.newRelationshipFor?: (chatId: string) => boolean`; buildInstructions: `newRelationship: (deps.newRelationshipFor?.(chatId) ?? false) && tierProfile.allow.has('memory_write')`; `personaEmpty: !(p?.content && p.content.trim().length > 0)` — CAREFUL: personaEmpty must only matter when personaCultivate is true (nudge lives inside cultivation section) so no extra gating needed beyond passing it through.
- main.ts: `newRelationshipFor: (c) => countMessagesSync(db, c) < NEW_RELATIONSHIP_MSG_COUNT` (db in scope; comment: sync because buildInstructions is sync; cheap indexed COUNT).
- bootstrap.test.ts cases: fresh+trusted ⇒ section present; fresh+guest ⇒ absent; old chat (thunk false) ⇒ absent; cultivate+empty persona ⇒ nudge; cultivate+content ⇒ no nudge.
- FULL verification: tsc; full suite (git-stash triage); e2e (fresh admin chats WILL now carry the section — e2e asserts dispatch/reply behavior not prompt equality; if any e2e breaks on prompt content STOP and report).
- Commit: `feat(onboarding): wire new-relationship gate (message count) + persona-empty nudge`.

## Self-Review notes

Spec §1→T1, §2 gates/threshold/sync→T2. personaEmpty threading verified nested-inside-cultivate (no separate gate needed). Names flow: NEW_RELATIONSHIP_MSG_COUNT/countMessagesSync T2-internal; newRelationship/personaEmpty T1↔T2.
