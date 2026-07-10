# Design: image stickers (图片表情包)

Date: 2026-07-10
Status: approved design → implementation
Roadmap: Phase 3a (adapted). See `docs/design/companion-liveness-layer.md` §1①.

## 1. Motivation & the protocol finding

Native WeChat stickers are NOT sendable — ilink's `sendmessage` supports only
types 1=text/2=image/3=voice/4=file/5=video (`src/lib/ilink.ts:42`). But
`sendFile` already auto-detects image extensions and sends `type:2 image_item`
(inline picture, CDN upload included — `src/daemon/media.ts:229-243`). So:
**a tagged local image library + a pick-by-tag tool = stickers.** The user's
direction: collect sticker images (download / save from chat), TAG them so the
agent knows when each fits.

## 2. Scope decisions (locked)

- Image stickers sent as inline images via the EXISTING sendFile path. No new
  protocol work; no native stickers (blocked upstream); no auto image-matching
  ML — tag lookup only.
- **Sourcing is AI-native, no downloader feature**: the owner asks CC to
  download+tag stickers (CC has shell/network), and anyone can send an image
  in chat + ask CC to save it (inbound images already land on disk via
  `[image:/path]` markers).
- Sticker use is part of a REPLY (agent judgment during a turn), NOT a
  proactive send — it does not go through `shouldSpeak`. Restraint comes from
  prompt guidance + the per-chat toggle.
- Per-chat toggle `/set 表情|stickers on|off` (chat_prefs `stickers?: boolean`,
  default ON — presence dial, consistent with `split`).

## 3. Sticker library (`src/daemon/stickers.ts`)

- Files: `<stateDir>/stickers/<name>.<png|jpg|jpeg|gif|webp>`.
- Index: `<stateDir>/stickers/stickers.json` via `makeStateStore(..., {debounceMs:0})`
  — key = filename, value = JSON `{ tags: string[], desc?: string }`.
- API (`makeStickerLib(stateDir, deps?: { store?, random? })`):
  - `save(sourcePath, tags, desc?)` → copies the file into the stickers dir
    (name-collision-safe), writes index; validates image extension + tags
    non-empty; returns `{ file, tags }`.
  - `resolve(tag)` → filenames whose tags include `tag` (trim/case-insensitive
    match), pick ONE at random (injectable `random` for tests) → absolute
    path, or null.
  - `list()` → `[{ file, tags, desc? }]`; `allTags()` → unique sorted tags.
  - Index entries whose file no longer exists are skipped by resolve/list
    (self-healing against manual deletion).

## 4. Tools + routes

| MCP tool (wechat server) | Route | Tier | classifyToolUse |
|---|---|---|---|
| `send_sticker(chat_id, tag)` | `POST /v1/wechat/send_sticker` | same as send_file's route tier | `reply` |
| `save_sticker(path, tags[], desc?)` | `POST /v1/stickers` | trusted | `memory_write` |
| `list_stickers()` | `GET /v1/stickers` | guest-readable | `memory_read` |

- `send_sticker` route: resolve tag → null ⇒ `{ok:false, reason:'no_sticker_for_tag', tags:<available>}`
  (agent falls back to text gracefully); else send via the existing
  `ilink.sendFile` path, return `{ok:true, file}`.
- Routes inline-validated (no schema-table churn). Deps: `stickers?` on
  `InternalApiDeps` (absent ⇒ 503), backed by the shared lib instance.
- **`send_sticker` joins `REPLY_TOOLS`** (`src/core/agent-provider.ts`) so
  `replyToolCalled` detection counts it as a reply — and chatroom beats deny
  it like other reply tools (correct: no un-prefixed sticker leaks).

## 5. Prompt + settings

- `stickerSection(tags: string[])` in prompt-builder: available tags listed;
  guidance — 情绪强/庆祝/安慰的时刻才用,一次最多一张,配合文字不是替代文字;
  用 `send_sticker(tag)`;没有合适 tag 就不用。Gated per-chat:
  `BuildSystemPromptArgs.stickerTags?: string[]` (empty/absent ⇒ section omitted).
- Bootstrap: `BootstrapDeps.stickerTagsFor?: (chatId) => string[]` — main.ts
  wires: prefs.stickers !== false && lib has stickers ⇒ `allTags()`, else `[]`.
- `/set` gains key `stickers|表情` (on|off|开|关), same pattern as `split`.

## 6. Testing

Lib unit (save/resolve-random-injectable/list/missing-file-skip/collision);
route tests (503/400/no-tag-fallback/happy incl. sendFile call); classification
+ REPLY_TOOLS membership; prompt section gating (byte-identical when absent);
`/set` tests; full suite + e2e green (no stickers dir in harness ⇒ inert).

## 7. Non-goals (v1)

Native stickers; auto image-content matching; sticker sync/sharing; animated-
gif guarantees (sent as-is; rendering is WeChat's business); desktop UI for
the library (AI-native management via chat instead); proactive stickers.
