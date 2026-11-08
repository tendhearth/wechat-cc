# CC UI Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the confirmed review findings and complete consistent minimal pages and real content rendering across native phone, desktop and existing lightweight PWA, then independently review the combined result.

**Architecture:** Reuse existing state, controllers, routes and design tokens. Native, desktop content and desktop secondary surfaces have separate file owners. PWA follows after the shared reading decision but retains its existing status-only capability. Root alone integrates into this owned dev-descended feature worktree; shared dev and installations stay outside execution.

**Tech Stack:** Existing React Native/Expo, JSDoc desktop modules/CSS, shared Marked package and generated bundle, inline PWA build, Vitest/Playwright and isolated iOS simulator.

**Spec:** `docs/superpowers/specs/2026-10-28-cc-ui-completion-design.md`

## Global Constraints

- Warm paper `#faf7f2`, deep green `#4f6b4f`, existing serif and400/500 weights. Purpose→hierarchy→function→consistency→restraint. Preserve canonical CC assets and Tendhearth naming.
- Preserve exact permission/cwd/scope, IDs, state truth, errors/unknown/partial reads, submission locks, background/queue/recovery consequences and accessible actions.
- Keep reading anchors/selection, explicit folds, drafts, preview instances and response ownership. No fake completion, summary, progress or attachment.
- Native controls≥44pt, bilingual copy; desktop keyboard/focus; reduced motion. No dependency/theme/protocol/migration expansion without evidence it is necessary.
- Markdown HTTP/S image-open is explicit; local/relative targets remain inert readable paths. No arbitrary file read, automatic external-image request, executable HTML or dangerous scheme. Keep original default parser compatible.
- Tests only increase; report conflicting old assertions before changing them. Use official Vitest entry and2workers; never native Bun test for DOM. No broad duplicate suite runs in task reviewers.
- Baseline combined existing approved phone3744ece6+desktop98bdbe13 via local feature merged5c40b4e; pinned dev ancestor dc4f8cf9. Only owned root/child workspaces; no shared dev merge/push/deploy/native install/production access.
- Isolated runtime state/ports: root4277; native Expo8277; desktop content4271; desktop secondary4272; PWA4273. A routed browser test need not bind a server.

## Review Focus

- No-file text answer and running progress are visible without opening technical process; old replies do not imply current completion.
- Real220pxQR, restored task entry and edge-anchored menus at low height remain visible/reachable with correct modal focus.
- Same h1–h6/code/table/link/image/file content is readable across chat/history/task/file entry, without discarded target information or unsafe navigation.
- Native actual layout and maximum font differ from mocked DOM; input/selection/preview/disclosure state survives content and navigation changes.
- Every reachable secondary surface is covered with valid normal data; error-only generic screenshots cannot establish page completion.

### Task 1: Native outcomes and reading completion

**Files:** Own `apps/app/src/app/`, `apps/app/src/ui/`, related App state/view tests, i18n and affected Maestro flows; no desktop/PWA/shared Markdown package edits. Keep root/docs and backend untouched. Existing24dailyroutefiles are the inventory; shell/deep-link/dev routes retain behavior.

**Interfaces:** Existing parseMarkdown tokens and safeMarkdownUrl remain available. Task2 may add desktop `renderReadingMarkdown(value:string):string`, which native does not need to import. Use existing file opener/hash/download backend and native links. No cross-task source writer.

- [ ] Reproduce text-only completed/replied result hidden under default-closed Process with real Matter+Provider; pin answered/no-file, answered/file, running progress, pending decision and old-round behavior.
- [ ] Keep actual assistant outcome/current progress readable before technical process; preserve per-task folds, return/comment drafts and all existing task actions.
- [ ] Complete native reading/file surfaces: all heading levels, code/table horizontal reading, HTTP/S image-open affordance and visible inert path, precise plain text vs Markdown file formats, aspect-correct images, clear supported open/share/failure paths. Retain ≥44pt, bilingual, keyboard/dynamic text/safe area.
- [ ] Audit all24daily routes and reachable sheets/readers against approved minimal hierarchy; remove remaining duplicate titles/prose/decorative containers where they interfere with actual content, retain essential disclosures/actions. Record changed/reused/verified mapping rather than claiming every file needs rewriting.
- [ ] Run focused RED/GREEN, App typecheck and appropriate component checks. Use isolated native demo only if needed for actual layout; coordinate root final simulator rather than duplicate full QA. Inspect normal/large-font matter/text/file views. Commit and report exact hash/tests/limitations.

### Task 2: Shared reading and desktop real-content completion

**Files:** Own `packages/markdown/src/index.ts`+tests, build output `apps/desktop/src/vendor/markdown.js`; desktop `modules/workbench-markdown.js`, `workbench.js`, `converse.js`, `dialogue-page.js`, `workbench-artifact-preview.js`, relevant attachment/reply/reader helpers, `styles/workbench.css` and focused tests/browser fixtures. No `index.html`, `styles.css`, secondary page modules or native/PWA source edits. Only if required to project already stored media metadata: narrow owner-chat read projection and related tests; report exact route/data decision before modification.

**Interfaces:** Preserve `renderMarkdown(value:string)` default output. If enhancing image/path behavior, produce exported `renderReadingMarkdown(value:string):string`, same escaping and http(s)-only link policy; explicit valid image link and inert visible local/relative target. Existing parseMarkdown token interface unchanged. Tell root when interface committed. PWA remains plain status/title and does not consume rich rendering.

- [ ] Reproduce task h6=10.72px and wide table vertical character wrap; add behavioral/rendered assertions for all headings, long code, wide tables, HTTP/S links, images and inert local paths across actual chat/task/history/file readers.
- [ ] Unify reading typography and semantic rendering; text/json/csv inputs show precise source, Markdown inputs/results render consistently with original source available. Preserve safe URL/HTML contracts, artifact preview/controller identity and failure/retry/download behavior.
- [ ] Supply explicit safe image-open actions and visible inert path information without remote auto-loading or new file-read permission; build generated bundle using `bun run build:markdown` and retain old default contract tests.
- [ ] Investigate owner-chat media history using existing stored references: restore authorized, valid persisted image/file/reply-extras on reload; old records without metadata are honest and usable. No stale object URL or guessed attachment. Add reload+mixed text/media+unknown/stale/failure coverage; coordinate any necessary read projection with root.
- [ ] Browser check same rich fixture in actual reading entries at1400×900,760×700,390×700; verify no outer overflow, table/code scroll, all source text reachable, link safety, selection/scroll and input/preview preservation. Run focused tests/typecheck, self-review, commit and report.

### Task 3: Desktop secondary pages and overlays

**Files:** Own `apps/desktop/src/index.html`, `styles.css`, `cc-surfaces.css`, optional new `styles/secondary-minimal.css`; `modules/phone-connect.js`, `dashboard.js`, `settings-drawer.js`, memory/evidence/line-edit, recollections/postcard/atelier/record-reader, todos, a2a/forage/people/wishes/journal, plugins/logs/wizard/setup modules and focused tests/browser fixtures. Do not edit Task2-owned workbench/converse/dialogue-page/Markdown files or workbench.css. Preserve existing dialogue content via shared reading styling. New page stylesheet linked here is this task's responsibility.

**Interfaces:** Existing module/controller hooks/routes preserved. Task2 owns shared reading; common layout selectors in styles.css must not override code/table reading contracts. Phone modal public open/close entry and provider selection behavior remain stable.

- [ ] Add RED repro for real220pxQR760×280 actions/close reachable, focus inside/contained/restored, and provider menu at1400×850/760×280 fitting or scrolling within viewport.
- [ ] Fix modal sizing/scroll/focus and menu placement/height/keyboard using existing semantics; preserve loading/QR-expiry/error/retry and setup/selection behavior.
- [ ] Apply approved minimal hierarchy to every reachable secondary surface listed in spec: recollections/readers, atelier/details/share, memory/profile/evidence/raw editing, todos/reminders/history, forage/network/mail, sessions/private content, plugins/logs, settings/providers and onboarding. Use actual content as main subject, reduce duplicated titles/prose and decorative card stacks; keep existing navigation and capabilities.
- [ ] Add valid-success fixture coverage and per-surface screenshots/checklist, including empty/error/loading, long content, narrow/low viewport and keyboard. Do not count dry-shim missing-route errors as success-page evidence. Inspect representative nested reader/dialog flows and preserve drafts/focus/locks.
- [ ] Run affected official tests/browser checks/typecheck, self-review and commit; report every reachable page and nested surface changed/reused/verified plus limitations.

### Task 4: Lightweight web/PWA visual alignment

**Files:** Own `apps/mobile/src/`, related mobile build/tests; `src/features/phone/settings-panel-html.ts` presentation only and related tests, relay settings HTML presentation if still reachable; generated `src/features/phone/mobile-page.generated.json` and relevant generated relay HTML via official builders. No protocol/routes/backend semantics/native/desktop edits.

**Interfaces:** Existing classic-script globals/order and inline512KB budget retained; `ccPlain` titles remain plain. PWA still only status list/detail, stop with confirmation and settings/pairing. No Markdown/chat/artifact features added, no expanded endpoint permission.

- [ ] Baseline existing mobile route/build/behavior tests; pin status, connection unknown/failure, stop confirmation and settings actions with current capabilities.
- [ ] Align existing home/together/status/settings/pairing layouts to warm paper, restrained typography, flat content rows, short labels/icons where unambiguous and primary action hierarchy. Show only truthful state; preserve limitations and request/location disclosures.
- [ ] Check390px and low-height, long labels, safe areas, modal/menu keyboard and current action semantics. Rebuild with `bun run build:mobile` and any actually needed official relay builder; verify generated-source guards and inline budget.
- [ ] Commit with RED/GREEN where behavior is fixed, relevant tests/typecheck/browser screenshots and complete reachable-surface inventory.

### Task 5: Combined verification and full review

**Files:** Root owns integration, docs/report, valid combined QA fixtures/checklists and durable evidence. Do not edit child source; route findings back to implementers. All three initial implementers use dedicated managed worktrees, no shared source writer.

- [ ] Per-task fresh spec+quality reviews from packaged BASE..HEAD diffs, targeted fix loops, then serially integrate own commits into root. Record any parked/ruling items.
- [ ] Run frozen combined `bun run verify --base dc4f8cf9a58a0195723045594c89f55c520b60fd`, App full suite with2workers, iOS/Android static exports, affected full desktop/PWA browser matrix. Do not run empty Node desktop suite or unrelated fullbackend suite.
- [ ] Use isolated iOS demo to check actual page transitions and normal/max font rich readers/outcomes/sheets; actual full desktop/PWA normal payloads at wide/narrow/low sizes. Complete per-page/content/state evidence matrix; explicitly name any platform-only behavior not actually run.
- [ ] Fresh most-capable whole-branch correctness review plus coverage/content review; resolve all known important findings, preserve logs/screenshots/review/rulings, stop owned fixtures, finish committed clean branch. No shared dev push/merge/deploy/native install or publishing.
