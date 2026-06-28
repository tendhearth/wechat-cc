# Ambient file survey folded into `_overview` synthesis

**Date:** 2026-06-28
**Status:** approved
**Related:** [[positioning-and-differentiation]] (memory is the spine; the
`_overview` synthesis must span work AND life as one whole person),
`docs/superpowers/specs/2026-06-28-locate-file-on-demand-design.md` (sub-project
1 — the on-demand `locate_file` tool + `locations.md` this builds on),
`src/lib/memory-synthesis.ts` (the synthesis this extends),
`src/lib/locate-files.ts` (the bounded-walk pattern this mirrors).

## What this is

This is **sub-project 2 of 2** ("ambient understanding"; sub-project 1
"on-demand retrieval" shipped). Today `synthesizeOverview()` runs one LLM pass
over two signals — **work** (the admin's per-project Claude memory) and **life**
(WeChat observations / milestones / memory notes) — and writes a distilled
`_overview.md`. It has never looked at the actual files on the computer.

This adds a **third signal**: a cheap, scripted survey of the admin's files (a
shallow directory map — folders, file counts, a sample of filenames; no
contents), folded into that same synthesis pass so the distilled overview
reflects "roughly what's on this person's computer, and what it says about what
they're doing."

### The two-stage split (why the LLM is still needed, and only once)

- **Gather (script, zero tokens):** walking the dirs and building the map is a
  deterministic bounded walk — no LLM.
- **Understand (LLM, marginal cost):** turning a file listing into "this person
  rents an apartment, is doing Q3 budgets, looks like they're job-hunting" is
  inference only the LLM does — and it is the entire point of `_overview`. The
  survey is **one extra section in the synthesis prompt that already runs**, not
  a new LLM call.

The raw directory map is **never** kept in per-turn context. The existing design
feeds only the distilled `_overview.md` to the bot each turn (raw project memory
is deliberately excluded to save tokens); the file survey follows the same rule
— distilled in, raw out. Per-turn prompt size is unchanged. When the bot needs a
specific file's details at conversation time, that is sub-project 1's
`locate_file`, not this.

### Explicit non-goals (YAGNI)

- No file **contents** read; no embeddings; no background index.
- No new trigger — the survey runs only when synthesis already runs (desktop
  "刷新" / admin asking in WeChat). No background crawl / timer (honors the
  低负担 / "别后台爬全盘" principle).
- Per-turn snapshot injection logic (`buildMemorySnapshot`) is untouched — the
  raw tree never becomes resident memory.
- No multi-user / non-admin survey (synthesis is admin-only by construction).

## Components

### a) `surveyFiles()` — pure scripted gather (`src/lib/file-survey.ts`)

Pure function, no daemon/cli imports (layering rule), mirroring
`locate-files.ts`'s bounded-walk discipline but with a different job: a **shallow
directory map**, not a file search. Signature roughly:

```
interface FolderSummary {
  path: string        // absolute folder path
  fileCount: number   // files directly in this folder
  subdirs: string[]   // immediate child directory names
  sample: string[]    // up to `samplePerFolder` representative filenames
}
interface SurveyLimits {
  maxDepth: number        // default 3
  maxFolders: number      // default 200 — total folders to include before truncating
  samplePerFolder: number // default 8 — filenames sampled per folder
  totalBytes: number      // default 12_000 — cap on rendered survey size
}
interface SurveyResult { folders: FolderSummary[]; truncated: boolean }
function surveyFiles(opts: { roots: string[]; limits?: Partial<SurveyLimits> }): SurveyResult
```

- Bounded walk to `maxDepth`; skip `node_modules` / `.git` / `Library` /
  `.Trash` / `.cache` and dotdirs/dotfiles (reuse the same skip set as
  `locate-files.ts`).
- `sample` selection: most-recently-modified first (recency is the strongest
  "what they're working on now" signal), capped at `samplePerFolder`.
- Stop and set `truncated:true` at `maxFolders`. Missing/unreadable roots and
  subdirs are skipped (best-effort), never thrown.
- Fully unit-testable against a temp-dir fixture.

### b) `formatFileSurvey()` — render to a prompt section (`src/lib/file-survey.ts`)

Turns a `SurveyResult` into compact markdown, truncated at `limits.totalBytes`
with a "…(截断)" marker — same shape as the life block in `formatSynthesisPrompt`.
One folder per line: `- <相对路径>/ (<fileCount> 个文件): <sample, 逗号分隔>`.

### b2) Relocate `defaultLifeDirs` into lib (layering fix)

`defaultLifeDirs` currently lives in `src/daemon/internal-api/routes-files.ts`
(sub-project 1). `memory-synthesis.ts` is in `src/lib/` and **must not** import
from `src/daemon/` (layering rule). So move `defaultLifeDirs` into
`src/lib/file-survey.ts` as the single source of truth, and have
`routes-files.ts` import it from lib (`daemon → lib` is allowed). Behavior
identical; both consumers (the route and the survey) now share one definition.

### c) Synthesis integration (`src/lib/memory-synthesis.ts`)

Mirrors exactly how the **life** side is already folded in:

1. `gatherFileSurvey(opts: { roots: string[]; limits?: Partial<SurveyLimits> }):
   SurveyResult` — best-effort wrapper over `surveyFiles` (every source
   try/caught → empty on failure, like `gatherLifeContext`).
2. **Roots** = `defaultLifeDirs()` (now in `src/lib/file-survey.ts`, the single
   source of truth — see b2) **+** absolute dirs parsed from the admin's
   `locations.md`.
   Synthesis runs daemon/CLI-side and **knows `adminChatId`** (unlike the
   stateless sub-project-1 route), so it can read `locations.md` here — this is
   how sub-project 1's learned locations feed the ambient understanding. Reuse
   the existing `<stateDir>/memory/<adminChatId>/` access already in
   `gatherLifeContext`; parse lines for absolute paths (`/…`), de-duplicate.
3. `formatSynthesisPrompt(projects, life, survey?)` gains an optional `survey`
   param → renders a "C) 文件侧（本机文件概览）" block via `formatFileSurvey`,
   bounded by the existing `TOTAL_CAP` budget. The prompt header's instruction
   list gains one line: fold the file side into "这人在做什么/在意什么".
4. `synthesizeOverview` calls `gatherFileSurvey` after `gatherLifeContext` and
   passes `survey` into `formatSynthesisPrompt`. The "nothing to synthesize"
   guard (currently `projects.length === 0 && lifeIsEmpty(life)`) extends to also
   require the survey be empty before skipping.
5. `SynthesizeResult` gains a `foldersScanned: number` counter (parallels the
   existing `observationsFound` etc.), so the desktop "刷新" / CLI report can
   show the file side was included.

## Data flow

```
desktop "刷新" / admin: "整理下记忆"
  → synthesizeOverview
      → discoverProjectMemory (work)        [existing]
      → gatherLifeContext (WeChat life)     [existing]
      → gatherFileSurvey(roots = defaultLifeDirs() + locations.md dirs)  [NEW, scripted, 0 tokens]
      → formatSynthesisPrompt(projects, life, survey)   → one prompt
      → sdkEval(prompt)                     [the existing single LLM pass]
      → writeMemoryFile(_overview.md)       [existing]
  → per turn: buildMemorySnapshot feeds only _overview.md   [UNCHANGED — raw tree never resident]
Specific-file detail at chat time → locate_file (sub-project 1), not this.
```

## Error / edge handling

- Each of the three sides is independently try/caught; a missing dir / unreadable
  subdir / absent `locations.md` degrades that side to empty rather than failing
  the synthesis (matches `gatherLifeContext`).
- Survey rendering is byte-capped (`totalBytes`) and the whole survey block is
  additionally bounded by the synthesis `TOTAL_CAP`, so a huge disk can't blow
  the prompt.
- `truncated` is surfaced in the rendered block ("…(截断)") so the LLM knows the
  map is partial.
- All-three-empty → no synthesis (existing behavior, extended).

## Testing (TDD)

1. `file-survey.test.ts` (temp-dir fixtures): folder map levels + file counts +
   subdir listing; `sample` is recency-ordered and capped at `samplePerFolder`;
   skip rules (node_modules/.git/dotdirs); `maxFolders` → `truncated:true`;
   missing-root tolerance; `formatFileSurvey` byte-cap truncation marker.
2. `memory-synthesis.test.ts` (extend): `formatSynthesisPrompt` includes the
   "文件侧" block when a non-empty survey is passed and omits it when empty;
   `synthesizeOverview` with only a survey (no work/life) still synthesizes;
   all-three-empty still skips; `gatherFileSurvey` roots include dirs parsed from
   a fixture `locations.md`; existing mock `sdkEval` signature unchanged.

## Out of scope (restated)

- File contents / embeddings / background index / timer.
- Changes to per-turn snapshot injection.
- Non-admin / multi-user survey.
- On-demand specific-file lookup (that is sub-project 1).
