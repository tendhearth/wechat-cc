# 联网搜表情 (Online Sticker Search) — Design

**Date:** 2026-08-30
**Status:** Design approved (brainstorming); pending implementation-plan
**Prior art:** `2026-07-10-image-stickers-design.md` (local library, `send_sticker`/`save_sticker`, sticker-artist self-drawing)

## Problem

The sticker library today is populated only by (a) the bundled starter pack
(5 hand-drawn bears covering 开心/庆祝/送你/摸鱼/陪着), (b) the owner's
`save_sticker` on incoming images, and (c) CC's own self-drawn stickers
(sticker-artist, one per day/week). Two gaps follow:

1. **Cold start / uncovered moods** — for any mood outside the 5 starter
   moods, an empty-ish library means CC has nothing to send.
2. **No variety even for covered moods** — a strict "only when nothing
   local" trigger would send the same one hand-drawn bear for 开心 forever.

We want CC to **autonomously search the internet for a sticker and send it**
when its local library is thin for a mood, and to **grow the local library**
from what it sends so the reach-out converges.

## Goals

- CC can fetch a sticker from an online source and send it inline, on its own
  initiative, at emotionally-appropriate moments.
- Online reach-out is **local-first with a richness threshold**: it fires when
  a mood has fewer than **K** local stickers, and stops once the mood reaches
  K (converges — bounded traffic, predictable).
- Every online sticker that sends successfully is **auto-saved** into the local
  library (tagged by mood), so the library self-grows and future hits are local.
- Pluggable image source: ship Tenor first; adding a Chinese source later is a
  new implementation, not a rewrite.
- Zero-config-safe: no API key ⇒ the online capability is silently absent and
  CC falls back to text, exactly as other optional subsystems degrade.

## Non-Goals

- No Chinese scraping source in this iteration (发表情/搜狗). The `StickerSource`
  seam is designed so one can be added later without touching the main chain.
- No online **variety refresh once converged** — at K stickers a mood stops
  reaching out (the "偶尔换新鲜" and "每次都联网" options were declined).
- No changes to the sticker-artist self-drawing pipeline.
- No new UI surface; reuses the existing sticker on/off preference.

## Key Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Image source | **Tenor** (Google, official API) behind a pluggable `StickerSource` interface |
| Trigger | **Local-first** with richness threshold: reach online only when a mood has `< K` local stickers |
| Convergence | **Converge at K** — once a mood has K local stickers, never reach online for it again (K default 5) |
| Auto-save | **On successful send** — fetched sticker is saved to the local library, tagged by mood |
| Where the logic lives | **Method A — a dedicated `search_online_sticker` tool**; the daemon route owns the K-threshold + fetch + save, keeping the network egress an explicit, separately tier-gateable action |

## Architecture

New/changed pieces, following existing patterns (`stickers.ts` store seam,
env-var config, internal-api route + MCP tool):

```
                 emotion moment
                       │
         ┌─────────────┴──────────────┐
         │ send_sticker(tag)          │  (unchanged: send from what I have)
         │ search_online_sticker(...) │  (NEW: enrich + send when thin)
         └─────────────┬──────────────┘
                       │  POST /v1/wechat/search_online_sticker
                       ▼
        ┌──────────────────────────────────────────┐
        │ route handler (routes.ts)                 │
        │  1. count local stickers for `mood`       │  stickers.list()
        │  2. if count >= K  → resolve() local, send│  (no network)
        │  3. else → source.search(query)           │  StickerSource
        │       → download to temp file             │
        │       → ilink.sendFile(chat_id, tmp)      │
        │       → stickers.save(tmp, [mood], desc)  │  auto-grow
        │       → cleanup temp                       │
        └──────────────────────────────────────────┘
                       │
                       ▼
             StickerSource (interface)
                       │
                 TenorSource (impl, WECHAT_CC_TENOR_KEY)
```

### 1. `StickerSource` interface + `TenorSource`

New module `src/daemon/sticker-source.ts`:

```ts
export interface StickerHit {
  /** Direct URL of a raster sticker/GIF (already size-limited). */
  url: string
  /** Stable id from the source (for dedup / filename). */
  id: string
}

export interface StickerSource {
  /** Search the source; return best hits (may be empty). Never throws — network/parse errors ⇒ []. */
  search(query: string, opts?: { limit?: number }): Promise<StickerHit[]>
}

export interface TenorDeps {
  apiKey: string
  fetch?: typeof fetch      // injectable for tests
}
export function makeTenorSource(deps: TenorDeps): StickerSource
```

- Tenor v2 `search` endpoint. Params: `key`, `q`, `limit`, `media_filter`
  (request only a compact format — `tinygif`/`gif`), `contentfilter=high`
  (NSFW guard). Pick the GIF media object's URL from each result.
- Network failure, non-200, or malformed JSON ⇒ return `[]` (never throw),
  so the route degrades to "no online sticker" cleanly.
- Config: read `WECHAT_CC_TENOR_KEY` in `main.ts` wiring. Absent ⇒ no source
  wired ⇒ route reports the online capability unavailable and the tool nudges
  text fallback.

### 2. Richness-threshold helper (pure, unit-tested)

In `stickers.ts` (or a sibling), a small pure function over `list()`:

```ts
/** How many local stickers carry this mood tag (trim + case-insensitive). */
export function countForTag(entries: StickerEntry[], tag: string): number
```

`K` lives as a named constant (default **5**), documented next to it.

### 3. Route: `POST /v1/wechat/search_online_sticker`

In `internal-api/routes.ts`, inline-validated like the sibling sticker routes.
Requires `deps.stickers`, `deps.ilink`, and a new `deps.stickerSource`
(absent ⇒ `503 sticker_source_not_wired`, tool reports online-unavailable).

Body: `{ chat_id, mood, query }` — `mood` = Chinese emotion (the save tag),
`query` = search keyword (English recommended; CC supplies it).

Behavior:
1. Validate non-empty `chat_id`, `mood`, `query`.
2. `count = countForTag(stickers.list(), mood)`.
3. **If `count >= K`**: `path = stickers.resolve(mood)`; if found,
   `ilink.sendFile` it and return `{ ok:true, source:'local', file }`.
   (This makes the tool safe to call even for rich moods — it just sends local.)
4. **Else** (`count < K`): `hits = source.search(query)`.
   - Empty ⇒ fall back to local `resolve(mood)` if any, else
     `{ ok:false, reason:'no_online_result' }`.
   - Download first hit to a temp file under `<stateDir>/tmp-online-sticker/`
     (validate extension against the existing allow-list; cap byte size).
   - `ilink.sendFile(chat_id, tmp)`.
   - On send success: `stickers.save(tmp, [mood], 'CC 联网找的「mood」表情')`
     (save copies the file into the library — auto-grow). Cleanup temp.
   - Return `{ ok:true, source:'online', file }`.
5. All network/IO failures are non-fatal ⇒ `{ ok:false, error }`, never 5xx
   from the fetch itself.

`GET /v1/stickers` is unchanged; it already exposes counts via `list()`.

### 4. MCP tool `search_online_sticker`

In `tools-messaging.ts` (reply-family, next to `send_sticker`):

```
search_online_sticker(chat_id, mood, query)
  按情绪联网找一张表情包发到对话,并收进本地库(下次就能本地发)。
  mood: 中文情绪词(会作为本地 tag,如 安慰/摸鱼);
  query: 搜索关键词(英文效果最好,如 comforting hug)。
  本地这个情绪已经攒够时会直接发本地的,不联网。
```

Tier: reply-family (like `send_sticker`) — but it triggers a network egress +
a library write. Classify in `user-tier.ts` alongside `send_sticker`
(`'reply'`); the write it performs is the same trusted-tag path `save` already
guards. (Confirm during implementation whether it warrants a distinct tier;
default to `reply` to match `send_sticker`.)

### 5. Prompt nudges (`prompt-builder.ts`)

- **`stickerSection`** (library non-empty): add a line — when a mood's local
  stickers are thin or you want fresh variety, `search_online_sticker(mood, query)`
  finds one online, sends it, and saves it for next time; keep query English.
- **`emptyStickerSection`** (library empty): **add the online path here too** —
  "本地还没有时,可以用 `search_online_sticker` 联网找一张发过去" — otherwise
  cold-start users never learn the capability exists.

### 6. Gating & safety

- **Preference gate:** reuse the existing `stickers` chat-pref (undefined⇒ON,
  false⇒off). When off, the online path is off too (same as `send_sticker`).
  No new toggle.
- **Throttle:** a light per-chat cooldown on online reach-out (e.g. a small
  in-memory last-fetched-at map, or a state marker) so a burst of emotion
  doesn't fan out to many network fetches. Cooldown skips → send local or text.
- **Content filter:** Tenor `contentfilter=high`.
- **Size/format:** download cap (bytes) + extension against the existing
  `ALLOWED_EXTENSIONS`; gif already allowed. Temp files cleaned in `finally`.
- **Egress disclosure:** the search `query` leaves the machine to Tenor
  (Google). This is the only new external egress; it is opt-out via the
  sticker preference. Document in the tool description and spec.
- **No key ⇒ off:** `WECHAT_CC_TENOR_KEY` unset ⇒ `deps.stickerSource` absent
  ⇒ route 503 / tool reports online-unavailable ⇒ CC falls back to text.

## Data Flow (cold start example)

1. Owner (empty-ish library) says something sad; sticker pref ON.
2. `emptyStickerSection` told CC it can reach online → CC calls
   `search_online_sticker(chat_id, mood='安慰', query='comforting hug bear')`.
3. Route: `countForTag(list, '安慰') = 0 < 5` → `TenorSource.search('comforting hug bear')`.
4. First hit downloaded → `ilink.sendFile` → `stickers.save(tmp, ['安慰'], …)`.
5. Library now has 1 `安慰` sticker. The next four 安慰 moments repeat (→2…→5).
6. At 5 `安慰` stickers, `count >= K` → future 安慰 requests send **local**
   (random among the 5), no network. Converged.

## Error Handling

| Failure | Behavior |
|---------|----------|
| No `WECHAT_CC_TENOR_KEY` | source absent; route 503; tool tells CC online unavailable → text |
| Tenor network/HTTP/parse error | `search` returns `[]`; route falls back to local `resolve` or `no_online_result` |
| Download fails / oversized / bad ext | skip; fall back to local or `no_online_result`; temp cleaned |
| `ilink.sendFile` fails | `{ ok:false, error }`; **not** saved (save only after successful send) |
| Sticker pref off | route/tool refuse like `send_sticker` does today |
| Throttle cooldown active | no online fetch; send local if available, else defer to text |

## Testing

- **`countForTag` / K convergence** — pure unit tests (0<K online, ≥K local,
  boundary at K).
- **`TenorSource`** — injected `fetch`; assert query params (`contentfilter`,
  `media_filter`), hit extraction, and that network/parse errors ⇒ `[]`.
- **Route** — existing route-test harness with a fake `StickerSource`, fake
  `ilink`, and a temp `StickerLib`: assert local-first at ≥K (no source call),
  online path at <K (source called, sendFile called, save called, temp gone),
  and each failure row above.
- **Tool** — registration + passthrough shape, matching `send_sticker` tests.
- **Prompt** — `emptyStickerSection`/`stickerSection` include the online nudge.

## Rollout / Config

- New env var `WECHAT_CC_TENOR_KEY` (owner obtains a free Tenor/Google key).
- Feature is inert without the key; no migration, no schema change.
- `K` and the cooldown are named constants (tunable later; no config surface
  in v1 — YAGNI).

## Open Questions (resolve during implementation)

- `K` = **5** (locked); cooldown duration — pick a sane default, tune later.
- Whether `search_online_sticker` warrants a tier distinct from `send_sticker`
  given its network egress (default: same `reply` tier).
- Temp-dir location and byte cap constant.
