# Image Stickers (图片表情包) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tagged local sticker-image library the agent sends from by tag (`send_sticker`), collects into from chat (`save_sticker`), guided by a prompt section listing available tags, per-chat `/set 表情 on|off`.

**Architecture:** `stickers.ts` lib (state-store index over `<stateDir>/stickers/`), three inline-validated routes + wechat MCP tools, `send_sticker` joins `REPLY_TOOLS`, prompt section gated by `stickerTagsFor` bootstrap thunk, `stickers` key on chat_prefs. Sending reuses `ilink.sendFile` (auto image type:2).

**Tech Stack:** TypeScript, vitest (`bun --bun vitest run <file>`), existing state-store / internal-api / prompt-builder / mode-commands / chat-prefs patterns.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-image-stickers-design.md`.
- Tiers/classification (grounded): `send_sticker` route tier `'guest'` + classify `'reply'` (it sends only from the curated lib to the caller's chat — no exfil surface, unlike `send_file` which is trusted for arbitrary paths); `POST /v1/stickers` `'trusted'` + `save_sticker` → `'memory_write'`; `GET /v1/stickers` `'guest'` + `list_stickers` → `'memory_read'`. All classify mappings explicit, BEFORE the wechat `fs_read` fallback.
- `REPLY_TOOLS` (single site `src/core/agent-provider.ts:283`) gains `'send_sticker'`.
- Image extensions: `png|jpg|jpeg|gif|webp` only; `save` rejects others.
- Injectable `random` in the lib (no `Math.random()` in tests' path); no `Date.now()` needed.
- Inline route validation (no schema-table entries). Absent `stickers` dep ⇒ 503 `stickers_not_wired`.
- Prompt byte-identical when `stickerTags` absent/empty. e2e inert (harness has no stickers dir / prefs).
- TDD; tsc clean per commit; explicit `git add` only (tree may hold unrelated WIP).

---

### Task 1: sticker library

**Files:** Create `src/daemon/stickers.ts`, `src/daemon/stickers.test.ts`

**Interfaces (exact — later tasks compile against):**
```ts
export interface StickerEntry { file: string; tags: string[]; desc?: string }
export interface StickerLib {
  save(sourcePath: string, tags: string[], desc?: string): { file: string; tags: string[] }  // throws Error('invalid_extension') / Error('empty_tags')
  resolve(tag: string): string | null        // ABSOLUTE path of a random match; trim+case-insensitive tag compare
  list(): StickerEntry[]
  allTags(): string[]                        // unique, sorted
}
export function makeStickerLib(stateDir: string, deps?: { store?: StateStore; random?: () => number }): StickerLib
```
Impl notes: dir `<stateDir>/stickers/` (mkdir recursive on save); index `makeStateStore(join(stateDir,'stickers','stickers.json'), {debounceMs:0})`, key=filename, value=JSON `{tags, desc?}`; `save` copies with `copyFileSync`, on name collision appends `-1`, `-2`…; `resolve`/`list` skip entries whose file is missing on disk (`existsSync`); `random` defaults to `Math.random`.

- [ ] Failing tests: save copies file + writes index + returns entry; save rejects `.txt` (`invalid_extension`) and `[]` tags (`empty_tags`); collision renames (save same basename twice ⇒ two files, both listed); resolve picks deterministically with injected `random` (two matches, random=0 ⇒ first, random=0.99 ⇒ second) and matches case/whitespace-insensitively (`resolve(' 开心 ')`); resolve unknown tag ⇒ null; missing-file entries skipped by resolve+list (delete the file, keep index); allTags unique+sorted. Use `mkdtempSync` temp dirs + tiny real files.
- [ ] RED → implement → GREEN; tsc clean.
- [ ] Commit: `feat(stickers): tagged sticker library (save/resolve/list, state-store index)` — explicit paths.

### Task 2: routes + deps

**Files:** Modify `src/daemon/internal-api/types.ts`, `src/daemon/internal-api/routes.ts`, `src/daemon/internal-api/route-tiers.ts`; test `src/daemon/internal-api.test.ts`

- `InternalApiDeps` gains:
```ts
stickers?: {
  resolve(tag: string): string | null
  save(sourcePath: string, tags: string[], desc?: string): { file: string; tags: string[] }
  list(): { file: string; tags: string[]; desc?: string }[]
  allTags(): string[]
}
```
- `'POST /v1/wechat/send_sticker'` (tier `'guest'`): validate `chat_id` non-empty, `tag` non-empty string; deps.stickers absent ⇒ 503 `stickers_not_wired`; `resolve(tag)` null ⇒ 200 `{ok:false, reason:'no_sticker_for_tag', tags: deps.stickers.allTags()}`; else `await deps.ilink.sendFile(chat_id, path)` (ilink absent ⇒ 503 like siblings) ⇒ `{ok:true, file:<basename>}`; try/catch ⇒ `{ok:false, error}`.
- `'POST /v1/stickers'` (tier `'trusted'`): validate `path` non-empty string, `tags` non-empty string[]; lib errors (`invalid_extension`/`empty_tags`/fs) ⇒ 400 `{error:<message>}`; happy ⇒ `{ok:true, ...saved}`.
- `'GET /v1/stickers'` (tier `'guest'`): `{ok:true, stickers: list(), tags: allTags()}`.
- Tests mirror the existing fixture style: 503s, 400s, no-tag fallback (includes available tags), happy send (sendFile vi.fn called with resolved path), save happy + invalid ext, list. Route-tiers tally auto-covers (verify no frozen count breaks).
- [ ] RED → implement → GREEN; tsc clean. Commit: `feat(stickers): send_sticker/save/list routes (inline-validated)`.

### Task 3: MCP tools + classification + REPLY_TOOLS

**Files:** Modify `src/mcp-servers/wechat/tools-messaging.ts` (send_sticker — it's a message-family tool) and `src/mcp-servers/wechat/tools-companion.ts` OR a fitting home for save/list (follow file organization — save/list are library management, `tools-files.ts` may fit better; pick by reading headers); `src/core/user-tier.ts` (+test); `src/core/agent-provider.ts` (+test)

- Tools (existing zod+client.request+passthrough pattern), Chinese descriptions:
  - `send_sticker(chat_id, tag)`: 发一张表情包图(按 tag 从本地表情库选)。情绪强/庆祝/安慰时刻用,一次最多一张;tag 没有匹配会返回可用 tags。
  - `save_sticker(path, tags, desc?)`: 把一张图片存进表情库并打 tag(用户发来的表情图路径,或本地图片)。
  - `list_stickers()`: 列出表情库(文件、tags)。
- `classifyToolUse`: `send_sticker → 'reply'`, `save_sticker → 'memory_write'`, `list_stickers → 'memory_read'` — explicit, before fallback (+tests).
- `REPLY_TOOLS` gains `'send_sticker'` (+test: `isReplyToolCall({kind:'tool_call',server:'wechat',tool:'send_sticker'})` true; `isReplyToolName('mcp__wechat__send_sticker')` true).
- [ ] RED → implement → GREEN (user-tier, agent-provider, wechat integration tests); tsc clean. Commit: `feat(stickers): MCP tools + reply classification (send_sticker in REPLY_TOOLS)`.

### Task 4: prompt section + `/set 表情` + chat_prefs key

**Files:** Modify `src/core/prompt-builder.ts` (+test), `src/daemon/bootstrap/index.ts`, `src/daemon/chat-prefs.ts` (+test), `src/daemon/mode-commands.ts` (+test)

- `ChatPrefs` gains `stickers?: boolean` (default ON = undefined).
- prompt-builder: `stickerSection(tags: string[]): string` — lists tags (comma-joined), guidance per spec §5 (强情绪时刻/一次最多一张/配合文字/没有合适 tag 就不用/用 send_sticker). `BuildSystemPromptArgs.stickerTags?: string[]`; appended only when `stickerTags && stickerTags.length > 0` (byte-identical otherwise — strict `toBe` test like careEnabled's).
- bootstrap: `BootstrapDeps.stickerTagsFor?: (chatId: string) => string[]`; buildInstructions passes `stickerTags: deps.stickerTagsFor?.(chatId) ?? []`.
- `/set` gains key `stickers|表情` values `on|off|开|关` (same shape as split; bare `/set` shows it; help line mentions 表情).
- [ ] RED → implement → GREEN; tsc clean. Commit: `feat(stickers): sticker prompt section + /set 表情 toggle`.

### Task 5: wiring + full verification

**Files:** Modify `src/daemon/main.ts` (+ `wiring/index.ts` if threading needed)

- main.ts: `const stickerLib = makeStickerLib(stateDir)` (single production instance — grep-verify). Wire: `stickers: stickerLib` into registerInternalApi deps; `stickerTagsFor: (c) => (chatPrefs.get(c).stickers !== false ? stickerLib.allTags() : [])` into bootstrap deps.
- [ ] `bunx tsc --noEmit` clean; FULL suite green (git-stash triage for any failure); e2e suite green (no stickers dir ⇒ allTags()=[] ⇒ prompt inert; no tool calls in fakes).
- [ ] Commit: `feat(stickers): wire sticker library into routes + prompt`.

## Self-Review notes

Spec §3→T1, §4→T2+T3 (incl. REPLY_TOOLS + tier/classify decisions grounded in Global Constraints), §5→T4, wiring→T5. Names flow: `StickerLib` T1→T2 deps shape→T5; `stickerTags` T4 prompt↔bootstrap; `stickers` pref T4↔T5 thunk. send_sticker guest-tier rationale documented (curated lib = no exfil). No placeholders; the only judgment left to implementers is test-fixture mirroring (explicitly instructed) and save/list tool home (explicitly delegated with criteria).
