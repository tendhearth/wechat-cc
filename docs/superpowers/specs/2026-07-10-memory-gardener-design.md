# Design: 记忆园丁 (memory gardener)

Date: 2026-07-10
Status: approved design → implementation (single dispatch)
Origin: optimization direction #6 — memory is the spine; agents write notes
endlessly but nothing curates them. Quality of memory caps "懂你".

## 1. What

A daily curation pass (introspectTick) over each chat's freeform memory
files: merge duplicates, drop stale/superseded items, keep every still-valid
fact and impression, stay first-person mental-model voice, get tighter. Like
a gardener — prune, don't replant.

## 2. Locked decisions

- **Target files** per chat dir: `profile.md`, `preferences.md`, `notes/*.md`.
  EXCLUDED: `agenda.md` (own lifecycle), `persona.md` (slow cultivation),
  `_overview.md` (synthesized), anything under `archive/`.
- **When**: `introspectTick` (24h), after existing steps, using the SAME
  resolved cheapEval (absent ⇒ skip with log). Runs across ALL chat dirs
  under `<stateDir>/memory/`.
- **Change gate**: a file is gardened only when (a) ≥ `MIN_GARDEN_BYTES`
  (2048) AND (b) its content hash differs from the last-gardened hash —
  watermarks in `<stateDir>/garden_state.json` (state-store, key
  `<chatId>/<relPath>` → sha256 of content at last garden). Unchanged/small
  files cost zero LLM.
- **Cost bound**: ≤ `MAX_GARDEN_FILES_PER_TICK` (5) files per tick, oldest-
  watermark first; the rest wait for later ticks.
- **The pass** (one cheapEval per file): prompt = 园丁规则 — 合并重复、删掉
  已过期或被后来信息推翻的、保留所有仍然有效的事实/印象/偏好、保持第一人称
  mental-model 口吻、更紧凑;**不允许发明新信息**;输出整理后的完整文件。
- **Safety rails** (all mandatory):
  1. Original archived BEFORE overwrite to
     `<stateDir>/memory-archive/<chatId>/<relPath>.<YYYY-MM-DD>.md`
     (plain fs, OUTSIDE the agent-visible memory dir so `memory_list` stays
     clean).
  2. Output validation: non-empty; length ≤ original (gardening shrinks —
     a longer output means the model invented; skip + log); still ≤ the
     100KB fs cap by construction.
  3. Auth-fail screening via `assertNotAuthFailed` (consistent with other
     cheapEval callers).
  4. Skip (never delete) on ANY doubt; watermark updated only after a
     successful write.
- Zero prompt changes; agents keep writing memory exactly as today.

## 3. Non-goals

Observations curation (DB store has its own archive mechanism); agenda/
persona; cross-chat dedup; embeddings/semantic search; user-facing controls
(v1 always-on wherever cheapEval exists — it's maintenance, not presence).

## 4. Testing

Pure lib unit-tested with injected eval/fs/clock: gate math (size/hash/cap),
archive-before-write, validation skips (longer output / empty / auth-fail),
watermark update semantics, excluded files never touched. Tick integration:
step runs after existing ones, cheapEval-absent skip. Full + e2e green
(harness has no memory files ⇒ inert).
