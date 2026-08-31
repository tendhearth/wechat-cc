# Online Sticker Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CC autonomously fetch a sticker from the internet (GIPHY) and send it when its local library is thin for a mood, auto-saving each sent sticker so the library self-grows and converges.

**Architecture:** A pluggable `StickerSource` (first impl: GIPHY) owns all network I/O (search + download). A new daemon route `POST /v1/wechat/search_online_sticker` owns the policy: count local stickers for the mood, send a local one when the mood already has ≥K (K=5), otherwise search online → download → send via ilink → `stickers.save` (auto-grow) → cleanup. A new MCP tool `search_online_sticker` exposes it to the agent; prompt nudges (including the empty-library section) teach when to use it. Everything degrades to text when no API key / on any network error.

**Tech Stack:** TypeScript, Bun + Vitest (`bun --bun vitest run`), MCP SDK, existing internal-api route table + `StickerLib` store seam.

**Spec:** `docs/superpowers/specs/2026-08-30-online-sticker-search-design.md`

## Global Constraints

- **K threshold = 5** (locked). Named constant, documented at definition.
- **Zero-config-safe:** no `WECHAT_CC_GIPHY_KEY` ⇒ `stickerSource` dep absent ⇒ route returns `503 sticker_source_not_wired` ⇒ tool tells the agent online is unavailable ⇒ text fallback. No crashes.
- **Never throw across the network boundary:** `StickerSource.search`/`download` return `[]`/`null` on any network/HTTP/parse error, never throw.
- **Auto-save only after a successful `ilink.sendFile`.** A failed send saves nothing.
- **Tenor content filter = `high`** on every search.
- **Extension allow-list:** downloaded files must pass the existing `ALLOWED_EXTENSIONS` set in `stickers.ts` (`png/jpg/jpeg/gif/webp`); reject others.
- **Tags rendered into prompts:** any mood used as a tag is already normalized by `stickers.ts` `save()`; do not bypass `save()`.
- **Runtime:** Bun; use `Bun`/`node:` APIs already used in the repo. Tests are Vitest (`describe/it/expect/vi`).

---

### Task 1: `countForTag` richness helper

**Files:**
- Modify: `src/daemon/stickers.ts` (add exported pure function + `ONLINE_STICKER_K` constant)
- Test: `src/daemon/stickers.test.ts` (add a `describe` block)

**Interfaces:**
- Produces: `export function countForTag(entries: StickerEntry[], tag: string): number` and `export const ONLINE_STICKER_K = 5`
- Consumes: existing `StickerEntry` type (`{ file: string; tags: string[]; desc?: string }`)

- [ ] **Step 1: Write the failing test**

Add to `src/daemon/stickers.test.ts`:

```ts
import { countForTag, ONLINE_STICKER_K } from './stickers'

describe('countForTag', () => {
  const entries = [
    { file: 'a.png', tags: ['安慰', '晚安'] },
    { file: 'b.png', tags: ['安慰'] },
    { file: 'c.png', tags: ['开心'] },
  ]
  it('counts entries carrying the tag (trim + case-insensitive)', () => {
    expect(countForTag(entries, '安慰')).toBe(2)
    expect(countForTag(entries, ' 安慰 ')).toBe(2)
    expect(countForTag(entries, '开心')).toBe(1)
  })
  it('is 0 for an absent tag', () => {
    expect(countForTag(entries, '生气')).toBe(0)
  })
  it('K is 5', () => {
    expect(ONLINE_STICKER_K).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/stickers.test.ts -t countForTag`
Expected: FAIL — `countForTag`/`ONLINE_STICKER_K` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/daemon/stickers.ts`, after the `StickerEntry` interface / near the top-level exports, add:

```ts
/** Richness threshold for online-sticker convergence (spec 2026-08-30):
 *  a mood with ≥ this many local stickers stops reaching online. */
export const ONLINE_STICKER_K = 5

/** How many entries carry `tag` (trim + case-insensitive), for the
 *  online-sticker local-first / convergence decision. */
export function countForTag(entries: StickerEntry[], tag: string): number {
  const target = tag.trim().toLowerCase()
  return entries.filter((e) => e.tags.some((t) => t.trim().toLowerCase() === target)).length
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/stickers.test.ts -t countForTag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/stickers.ts src/daemon/stickers.test.ts
git commit -m "feat(stickers): countForTag + K=5 threshold for online-sticker convergence"
```

---

### Task 2: `StickerSource` interface + `TenorSource`

**Files:**
- Create: `src/daemon/sticker-source.ts`
- Test: `src/daemon/sticker-source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StickerHit { url: string; id: string }
  export interface StickerSource {
    search(query: string, opts?: { limit?: number }): Promise<StickerHit[]>
    download(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>
  }
  export interface TenorDeps { apiKey: string; fetch?: typeof fetch; maxBytes?: number }
  export function makeTenorSource(deps: TenorDeps): StickerSource
  ```
  (Network is fully contained here so the route can be tested with a fake source — a deliberate refinement of the spec's "search only" interface: `download` is folded in for network isolation.)
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/sticker-source.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeTenorSource } from './sticker-source'

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('makeTenorSource.search', () => {
  it('calls Tenor v2 search with key, q, contentfilter=high and extracts gif hits', async () => {
    const fetch = vi.fn(async () => okJson({
      results: [
        { id: '111', media_formats: { gif: { url: 'https://media.tenor.com/111.gif' } } },
        { id: '222', media_formats: { gif: { url: 'https://media.tenor.com/222.gif' } } },
      ],
    })) as unknown as typeof globalThis.fetch
    const src = makeTenorSource({ apiKey: 'KEY', fetch })
    const hits = await src.search('comforting hug', { limit: 2 })
    expect(hits).toEqual([
      { id: '111', url: 'https://media.tenor.com/111.gif' },
      { id: '222', url: 'https://media.tenor.com/222.gif' },
    ])
    const calledUrl = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(calledUrl).toContain('key=KEY')
    expect(calledUrl).toContain('q=comforting+hug')
    expect(calledUrl).toContain('contentfilter=high')
    expect(calledUrl).toContain('limit=2')
  })

  it('returns [] on non-200', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch }).search('x')).toEqual([])
  })

  it('returns [] when fetch throws', async () => {
    const fetch = vi.fn(async () => { throw new Error('network') }) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch }).search('x')).toEqual([])
  })

  it('returns [] on malformed JSON shape', async () => {
    const fetch = vi.fn(async () => okJson({ nope: true })) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch }).search('x')).toEqual([])
  })
})

describe('makeTenorSource.download', () => {
  it('returns bytes + ext for an allowed gif under the cap', async () => {
    const buf = new Uint8Array([1, 2, 3])
    const fetch = vi.fn(async () => new Response(buf, { status: 200 })) as unknown as typeof globalThis.fetch
    const out = await makeTenorSource({ apiKey: 'K', fetch }).download('https://media.tenor.com/111.gif')
    expect(out?.ext).toBe('gif')
    expect(out?.bytes.length).toBe(3)
  })

  it('returns null for a disallowed extension', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch }).download('https://x/evil.svg')).toBeNull()
  })

  it('returns null when the body exceeds maxBytes', async () => {
    const big = new Uint8Array(11)
    const fetch = vi.fn(async () => new Response(big, { status: 200 })) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch, maxBytes: 10 }).download('https://x/a.gif')).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    const fetch = vi.fn(async () => { throw new Error('x') }) as unknown as typeof globalThis.fetch
    expect(await makeTenorSource({ apiKey: 'K', fetch }).download('https://x/a.gif')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/sticker-source.test.ts`
Expected: FAIL — module `./sticker-source` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/daemon/sticker-source.ts`:

```ts
/**
 * sticker-source — pluggable online sticker providers (spec 2026-08-30).
 * All network I/O (search + download) is contained here so the daemon route
 * can be tested with a fake source. First impl: Tenor (Google) v2 search.
 * Every method degrades to []/null on any network/HTTP/parse error; never
 * throws across this boundary.
 */
const ALLOWED_DOWNLOAD_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const DEFAULT_MAX_BYTES = 3_000_000

export interface StickerHit {
  url: string
  id: string
}

export interface StickerSource {
  /** Best hits for `query`; [] on any error. */
  search(query: string, opts?: { limit?: number }): Promise<StickerHit[]>
  /** Download an image; null on error / disallowed ext / oversized. */
  download(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>
}

export interface TenorDeps {
  apiKey: string
  fetch?: typeof fetch
  maxBytes?: number
}

/** Lowercased extension (no dot) from a URL path, or null. */
function extFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname
    const dot = path.lastIndexOf('.')
    if (dot < 0) return null
    const ext = path.slice(dot + 1).toLowerCase()
    return ext.length > 0 && ext.length <= 5 ? ext : null
  } catch {
    return null
  }
}

export function makeTenorSource(deps: TenorDeps): StickerSource {
  const doFetch = deps.fetch ?? fetch
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES

  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 8
      const url =
        'https://tenor.googleapis.com/v2/search?' +
        new URLSearchParams({
          key: deps.apiKey,
          q: query,
          limit: String(limit),
          contentfilter: 'high',
          media_filter: 'gif',
        }).toString()
      try {
        const resp = await doFetch(url)
        if (!resp.ok) return []
        const body = (await resp.json()) as unknown
        const results =
          body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)
            ? ((body as { results: unknown[] }).results)
            : null
        if (!results) return []
        const hits: StickerHit[] = []
        for (const r of results) {
          const rec = r as { id?: unknown; media_formats?: { gif?: { url?: unknown } } }
          const gifUrl = rec.media_formats?.gif?.url
          if (typeof gifUrl === 'string' && typeof rec.id === 'string') {
            hits.push({ id: rec.id, url: gifUrl })
          }
        }
        return hits
      } catch {
        return []
      }
    },

    async download(url) {
      const ext = extFromUrl(url)
      if (!ext || !ALLOWED_DOWNLOAD_EXTS.has(ext)) return null
      try {
        const resp = await doFetch(url)
        if (!resp.ok) return null
        const bytes = new Uint8Array(await resp.arrayBuffer())
        if (bytes.length === 0 || bytes.length > maxBytes) return null
        return { bytes, ext }
      } catch {
        return null
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/sticker-source.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sticker-source.ts src/daemon/sticker-source.test.ts
git commit -m "feat(stickers): TenorSource — search + download, error-safe network boundary"
```

---

### Task 3: Per-chat cooldown helper

**Files:**
- Modify: `src/daemon/sticker-source.ts` (add pure cooldown helper)
- Test: `src/daemon/sticker-source.test.ts` (add a `describe` block)

**Interfaces:**
- Produces: `export function makeCooldown(ms: number): { ready(key: string, now: number): boolean }` — `ready` returns true and stamps the key when the key is unseen or `ms` has elapsed since its last stamp; false otherwise. `ms <= 0` ⇒ always ready.

- [ ] **Step 1: Write the failing test**

Add to `src/daemon/sticker-source.test.ts`:

```ts
import { makeCooldown } from './sticker-source'

describe('makeCooldown', () => {
  it('first call ready, second within window blocked, after window ready', () => {
    const cd = makeCooldown(1000)
    expect(cd.ready('c@bot', 0)).toBe(true)
    expect(cd.ready('c@bot', 500)).toBe(false)
    expect(cd.ready('c@bot', 1000)).toBe(true)
  })
  it('tracks keys independently', () => {
    const cd = makeCooldown(1000)
    expect(cd.ready('a', 0)).toBe(true)
    expect(cd.ready('b', 0)).toBe(true)
    expect(cd.ready('a', 100)).toBe(false)
  })
  it('ms<=0 is always ready', () => {
    const cd = makeCooldown(0)
    expect(cd.ready('a', 0)).toBe(true)
    expect(cd.ready('a', 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/sticker-source.test.ts -t makeCooldown`
Expected: FAIL — `makeCooldown` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/daemon/sticker-source.ts`:

```ts
/** In-memory per-key cooldown (online-sticker throttle). `ready` stamps on
 *  success; ms<=0 disables throttling. Injectable `now` keeps it testable. */
export function makeCooldown(ms: number): { ready(key: string, now: number): boolean } {
  const last = new Map<string, number>()
  return {
    ready(key, now) {
      if (ms <= 0) return true
      const prev = last.get(key)
      if (prev !== undefined && now - prev < ms) return false
      last.set(key, now)
      return true
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/daemon/sticker-source.test.ts -t makeCooldown`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sticker-source.ts src/daemon/sticker-source.test.ts
git commit -m "feat(stickers): per-chat cooldown helper for online-sticker throttle"
```

---

### Task 4: Route `POST /v1/wechat/search_online_sticker` + dep + tier

**Files:**
- Modify: `src/daemon/internal-api/types.ts` (add `stickerSource?` to `InternalApiDeps`)
- Modify: `src/daemon/internal-api/routes.ts` (new route + cooldown instance)
- Modify: `src/daemon/internal-api/route-tiers.ts` (map new route → `'guest'`)
- Test: `src/daemon/internal-api.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `countForTag`, `ONLINE_STICKER_K` (Task 1); `StickerSource` (Task 2); `makeCooldown` (Task 3); existing `deps.stickers` (`resolve/save/list`), `deps.ilink.sendFile(chatId, path)`.
- Produces: route `POST /v1/wechat/search_online_sticker`, body `{ chat_id, mood, query }`, responses:
  - `503 { error: 'sticker_source_not_wired' }` (no source) / `503 { error: 'stickers_not_wired' }` / `503 { error: 'ilink_not_wired' }`
  - `400 { error }` on missing `chat_id`/`mood`/`query`
  - `200 { ok:true, source:'local', file }` when `countForTag(list, mood) >= K`
  - `200 { ok:true, source:'online', file }` on successful fetch+send+save
  - `200 { ok:false, reason:'throttled' | 'no_online_result', ... }` / `200 { ok:false, error }`

- [ ] **Step 1: Write the failing test**

Add to `src/daemon/internal-api.test.ts` (inside the same top-level describe as the existing sticker tests; reuse the `MockStickers` interface already declared there). Extend `MockStickers` locally is unnecessary — add a `stickerSource` fake and pass `list` returning controllable entries:

```ts
describe('POST /v1/wechat/search_online_sticker', () => {
  const source = () => ({
    search: vi.fn(async () => [{ id: '1', url: 'https://media.tenor.com/1.gif' }]),
    download: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), ext: 'gif' })),
  })

  it('503 when stickerSource not wired', async () => {
    const stickers: MockStickers = { resolve: vi.fn(() => null), save: vi.fn(), list: vi.fn(() => []), allTags: vi.fn(() => []) }
    api = createInternalApi({ stateDir, daemonPid: 1, stickers })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/search_online_sticker`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'c@bot', mood: '安慰', query: 'comfort' }),
    })
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: 'sticker_source_not_wired' })
  })

  it('400 on missing mood/query', async () => {
    const stickers: MockStickers = { resolve: vi.fn(() => null), save: vi.fn(), list: vi.fn(() => []), allTags: vi.fn(() => []) }
    api = createInternalApi({ stateDir, daemonPid: 1, stickers, stickerSource: source() })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const bad = await fetch(`http://127.0.0.1:${port}/v1/wechat/search_online_sticker`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'c@bot', mood: '安慰' }),
    })
    expect(bad.status).toBe(400)
  })

  it('mood already at ≥K ⇒ sends local, no network', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ file: `a${i}.png`, tags: ['安慰'] }))
    const stickers: MockStickers = { resolve: vi.fn(() => '/state/stickers/a0.png'), save: vi.fn(), list: vi.fn(() => five), allTags: vi.fn(() => ['安慰']) }
    const src = source()
    const sendFile = vi.fn(async () => {})
    api = createInternalApi({
      stateDir, daemonPid: 1, stickers, stickerSource: src,
      ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
    })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/search_online_sticker`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'c@bot', mood: '安慰', query: 'comfort' }),
    })
    expect(await resp.json()).toEqual({ ok: true, source: 'local', file: 'a0.png' })
    expect(src.search).not.toHaveBeenCalled()
    expect(sendFile).toHaveBeenCalledWith('c@bot', '/state/stickers/a0.png')
  })

  it('mood below K ⇒ searches, downloads, sends, saves, returns source:online', async () => {
    const stickers: MockStickers = {
      resolve: vi.fn(() => null),
      save: vi.fn(() => ({ file: 'saved.gif', tags: ['安慰'] })),
      list: vi.fn(() => []),
      allTags: vi.fn(() => []),
    }
    const src = source()
    const sendFile = vi.fn(async () => {})
    api = createInternalApi({
      stateDir, daemonPid: 1, stickers, stickerSource: src,
      ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
    })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/search_online_sticker`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'c@bot', mood: '安慰', query: 'comfort' }),
    })
    expect(await resp.json()).toEqual({ ok: true, source: 'online', file: 'saved.gif' })
    expect(src.search).toHaveBeenCalledWith('comfort', { limit: 8 })
    expect(src.download).toHaveBeenCalledWith('https://media.tenor.com/1.gif')
    expect(sendFile).toHaveBeenCalledTimes(1)
    expect(stickers.save).toHaveBeenCalledTimes(1)
    expect(stickers.save).toHaveBeenCalledWith(expect.any(String), ['安慰'], expect.stringContaining('安慰'))
  })

  it('below K but source finds nothing ⇒ ok:false no_online_result', async () => {
    const stickers: MockStickers = { resolve: vi.fn(() => null), save: vi.fn(), list: vi.fn(() => []), allTags: vi.fn(() => []) }
    const src = { search: vi.fn(async () => []), download: vi.fn() }
    api = createInternalApi({
      stateDir, daemonPid: 1, stickers, stickerSource: src,
      ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile: vi.fn(async () => {}), editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
    })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/search_online_sticker`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'c@bot', mood: '安慰', query: 'comfort' }),
    })
    expect(await resp.json()).toEqual({ ok: false, reason: 'no_online_result' })
    expect(stickers.save).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/daemon/internal-api.test.ts -t search_online_sticker`
Expected: FAIL — route 404/handler missing / `stickerSource` not a known dep.

- [ ] **Step 3a: Add the dep type**

In `src/daemon/internal-api/types.ts`, right after the `stickers?: { … }` block, add:

```ts
  /**
   * Online sticker source (spec 2026-08-30) — backs
   * POST /v1/wechat/search_online_sticker. Wired in main.ts from
   * WECHAT_CC_TENOR_KEY. Absent ⇒ the route 503s sticker_source_not_wired.
   */
  stickerSource?: {
    search(query: string, opts?: { limit?: number }): Promise<{ url: string; id: string }[]>
    download(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>
  }
```

- [ ] **Step 3b: Add the route + cooldown**

In `src/daemon/internal-api/routes.ts`:

Add imports at the top (near the other `node:` and local imports):

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countForTag, ONLINE_STICKER_K } from '../stickers'
import { makeCooldown } from '../sticker-source'
```

Inside `makeRoutes(...)`, BEFORE the `return {`, add the cooldown instance (5-minute default):

```ts
  const onlineStickerCooldown = makeCooldown(5 * 60_000)
```

Add the route inside the returned object, right after the existing `'POST /v1/wechat/send_sticker'` handler block:

```ts
    'POST /v1/wechat/search_online_sticker': async (_q, body) => {
      if (!deps.stickerSource) return { status: 503, body: { error: 'sticker_source_not_wired' } }
      if (!deps.stickers) return { status: 503, body: { error: 'stickers_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; mood?: unknown; query?: unknown }
      if (typeof b.chat_id !== 'string' || b.chat_id.trim() === '') {
        return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      }
      if (typeof b.mood !== 'string' || b.mood.trim() === '') {
        return { status: 400, body: { error: 'mood required (non-empty string)' } }
      }
      if (typeof b.query !== 'string' || b.query.trim() === '') {
        return { status: 400, body: { error: 'query required (non-empty string)' } }
      }
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const mood = b.mood
      const chatId = b.chat_id

      // Local-first / convergence: at ≥K, just send a local one (no network).
      if (countForTag(deps.stickers.list(), mood) >= ONLINE_STICKER_K) {
        const local = deps.stickers.resolve(mood)
        if (local) {
          try {
            await deps.ilink.sendFile(chatId, local)
            return { status: 200, body: { ok: true, source: 'local', file: basename(local) } }
          } catch (err) {
            return { status: 200, body: { ok: false, error: errMsg(err) } }
          }
        }
        // Fall through to online if the count was stale/unmatched.
      }

      if (!onlineStickerCooldown.ready(chatId, Date.now())) {
        return { status: 200, body: { ok: false, reason: 'throttled' } }
      }

      let tmpDir: string | null = null
      try {
        const hits = await deps.stickerSource.search(b.query, { limit: 8 })
        if (hits.length === 0) return { status: 200, body: { ok: false, reason: 'no_online_result' } }
        const dl = await deps.stickerSource.download(hits[0]!.url)
        if (!dl) return { status: 200, body: { ok: false, reason: 'no_online_result' } }
        tmpDir = mkdtempSync(join(tmpdir(), 'online-sticker-'))
        const tmpFile = join(tmpDir, `${hits[0]!.id}.${dl.ext}`)
        writeFileSync(tmpFile, dl.bytes)
        await deps.ilink.sendFile(chatId, tmpFile)
        const saved = deps.stickers.save(tmpFile, [mood], `CC 联网找的「${mood}」表情`)
        return { status: 200, body: { ok: true, source: 'online', file: saved.file } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      } finally {
        if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* scratch only */ } }
      }
    },
```

Note: `basename` and `errMsg` are already imported in `routes.ts`; only add the new imports listed in Step 3b.

- [ ] **Step 3c: Map the route tier**

In `src/daemon/internal-api/route-tiers.ts`, next to `'POST /v1/wechat/send_sticker': 'guest',` add:

```ts
  // Online sticker search is a reply-family send (CC posts an inline image);
  // the auto-save writes a server-controlled temp path, not an arbitrary one,
  // so it stays guest like send_sticker (not trusted like POST /v1/stickers).
  'POST /v1/wechat/search_online_sticker': 'guest',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/daemon/internal-api.test.ts -t search_online_sticker`
Expected: PASS (all 5 cases).
Then: `bun --bun vitest run src/daemon/internal-api/route-tiers.test.ts` — Expected: PASS. **This test is exhaustive** — it asserts every route in the table has a `ROUTE_MIN_TIER` entry (`missing … toEqual([])`), so Step 3c's mapping is mandatory; without it this test fails with the new route listed as missing.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/types.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api.test.ts
git commit -m "feat(stickers): search_online_sticker route — local-first at K, online fetch+send+save"
```

---

### Task 5: Classify `search_online_sticker` in user-tier

**Files:**
- Modify: `src/core/user-tier.ts` (add sub-tool classification)
- Test: `src/core/user-tier.test.ts`

**Interfaces:**
- Consumes: existing wechat sub-tool classifier (the block with `if (sub === 'send_sticker') return 'reply'`); public entry `classifyToolUse(toolName, input)` (already imported in the test).
- Produces: `search_online_sticker` classified as `'reply'`.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('classifyToolUse', …)` block in `src/core/user-tier.test.ts` (the tool name is the MCP-prefixed form, matching the existing `mcp__wechat__send_sticker` cases):

```ts
it('search_online_sticker → reply (network egress send, like send_sticker)', () => {
  expect(classifyToolUse('mcp__wechat__search_online_sticker', {})).toBe('reply')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/user-tier.test.ts -t search_online_sticker`
Expected: FAIL — currently falls through to `fs_read`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/user-tier.ts`, in the sticker block, add the line directly after the `send_sticker` line:

```ts
    if (sub === 'send_sticker') return 'reply'
    if (sub === 'search_online_sticker') return 'reply'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/user-tier.test.ts -t search_online_sticker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/user-tier.ts src/core/user-tier.test.ts
git commit -m "feat(user-tier): classify search_online_sticker as reply-family"
```

---

### Task 6: Prompt nudges (both sticker sections)

**Files:**
- Modify: `src/core/prompt-builder.ts` (`stickerSection`, `stickerEmptyLibrarySection`)
- Test: `src/core/prompt-builder.test.ts`

**Interfaces:**
- Consumes: existing `stickerSection(tags: string[])` and `stickerEmptyLibrarySection()`.
- Produces: both strings mention `search_online_sticker`.

- [ ] **Step 1: Write the failing test**

Add to `src/core/prompt-builder.test.ts`:

```ts
import { stickerSection, stickerEmptyLibrarySection } from './prompt-builder'

describe('sticker sections mention online search', () => {
  it('non-empty section teaches search_online_sticker', () => {
    expect(stickerSection(['开心'])).toContain('search_online_sticker')
  })
  it('empty-library section teaches search_online_sticker (cold start)', () => {
    expect(stickerEmptyLibrarySection()).toContain('search_online_sticker')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts -t "online search"`
Expected: FAIL — strings don't contain `search_online_sticker` yet.

- [ ] **Step 3: Write minimal implementation**

In `stickerSection`, append to the returned string (after the existing `save_sticker` sentence):

```ts
本地没有合适的、或想换新鲜表情时，可以用 \`search_online_sticker(mood, query)\` 联网找一张发过去（mood 用中文情绪词，query 用英文关键词效果最好），发出去会自动收进库，下次就能本地发。
```

In `stickerEmptyLibrarySection`, change the return to include the online path:

```ts
  return '你还没有表情包。情绪强/庆祝/安慰的时刻，可以用 search_online_sticker(mood, query) 联网找一张表情发过去(mood 用中文情绪词,query 用英文关键词),发出去会自动收进库;聊天里遇到值得存的表情/梗图,也可以用 save_sticker 存进库。'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts -t "online search"`
Expected: PASS. Then run the full `prompt-builder.test.ts` to catch any snapshot/exact-string assertions on these sections and update them: `bun --bun vitest run src/core/prompt-builder.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts
git commit -m "feat(prompt): teach search_online_sticker in both sticker sections (incl. cold start)"
```

---

### Task 7: MCP tool `search_online_sticker`

**Files:**
- Modify: `src/mcp-servers/wechat/tools-messaging.ts`

**Interfaces:**
- Consumes: `server.registerTool`, `client.request`, `passthroughErrorResult` (all already imported in the file); route `POST /v1/wechat/search_online_sticker` (Task 4).
- Produces: MCP tool `search_online_sticker(chat_id, mood, query)`.

- [ ] **Step 1: Add the tool registration**

In `src/mcp-servers/wechat/tools-messaging.ts`, right after the `send_sticker` `registerTool` block, add:

```ts
  server.registerTool(
    'search_online_sticker',
    {
      title: 'Search the internet for a sticker and send it',
      description:
        '按情绪联网找一张表情包发到对话(内联图片),并自动收进本地库,下次就能本地发。mood: 中文情绪词(会作为本地 tag,如 安慰/摸鱼/开心);query: 搜索关键词,英文效果最好(如 comforting hug bear)。本地这个情绪已攒够时会直接发本地的,不联网;找不到会返回可改用文字。',
      inputSchema: { chat_id: z.string(), mood: z.string(), query: z.string() },
    },
    async ({ chat_id, mood, query }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/search_online_sticker', { chat_id, mood, query })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'search_online_sticker')
      }
    },
  )
```

- [ ] **Step 2: Typecheck (no dedicated unit test for tool registration in this file)**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-servers/wechat/tools-messaging.ts
git commit -m "feat(mcp): search_online_sticker tool (reply-family, auto-grows sticker lib)"
```

---

### Task 8: Wire `TenorSource` in main.ts from `WECHAT_CC_TENOR_KEY`

**Files:**
- Modify: `src/daemon/main.ts` (import + conditional wiring into `registerInternalApi` deps)

**Interfaces:**
- Consumes: `makeTenorSource` (Task 2); the existing `registerInternalApi({ … stickers: stickerLib, … })` call site (main.ts ~line 235) that already passes `stickers` and `ilink`.
- Produces: `stickerSource` dep present iff `WECHAT_CC_TENOR_KEY` is set.

- [ ] **Step 1: Add the import**

Near the other daemon imports at the top of `src/daemon/main.ts` (next to the `makeStickerLib` import):

```ts
import { makeTenorSource } from './sticker-source'
```

- [ ] **Step 2: Build the source next to the sticker lib**

Right after the `stickerLib` construction block (main.ts ~line 214, after `const stickerLib = makeStickerLib(stateDir)` and its starter-pack seeding), add:

```ts
    // Online sticker source (spec 2026-08-30) — present only when a Tenor key
    // is configured; absent ⇒ POST /v1/wechat/search_online_sticker 503s and
    // the tool tells CC online search is unavailable (text fallback).
    const tenorKey = process.env.WECHAT_CC_TENOR_KEY
    const stickerSource = tenorKey ? makeTenorSource({ apiKey: tenorKey }) : undefined
    if (tenorKey) log('STICKERS', 'online sticker source: Tenor (WECHAT_CC_TENOR_KEY set)')
```

- [ ] **Step 3: Pass it into registerInternalApi**

In the `registerInternalApi({ … })` call, next to the existing `stickers: stickerLib,` line, add:

```ts
      stickers: stickerLib,
      stickerSource,
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `bun run typecheck`
Expected: no errors.
Run: `bun --bun vitest run`
Expected: all pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(daemon): wire Tenor sticker source from WECHAT_CC_TENOR_KEY"
```

---

## Final Verification

- [ ] `bun run typecheck` clean.
- [ ] `bun --bun vitest run` green.
- [ ] Manual smoke (optional, needs a real key): set `WECHAT_CC_TENOR_KEY`, start the daemon, `curl -XPOST .../v1/wechat/search_online_sticker` with a low-count mood → observe a GIF sent + a new file in `<stateDir>/stickers/` + `stickers.json` updated. Repeat until the mood hits 5, then confirm `source:'local'` and no outbound Tenor call.
- [ ] Confirm no `WECHAT_CC_TENOR_KEY` ⇒ route 503 `sticker_source_not_wired`, chat still works (text fallback).

## Notes for the Executor

- **Self-review found no spec gaps.** Every spec section maps to a task: source/interface → T2; K-threshold → T1+T4; auto-save → T4; cold-start prompt → T6; gating/cooldown → T3+T4 (pref gate is inherited — the tool is reply-tier and the whole sticker capability already sits behind the `stickers` chat-pref via prompt inclusion, exactly like `send_sticker`); no-key degradation → T8; testing → per-task.
- **Preference gate:** there is no extra code to add for the on/off toggle — like `send_sticker`, the tool is only *offered* to the model through `stickerSection`/`stickerEmptyLibrarySection`, which already render only when the `stickers` pref is ON. The route itself is capability-plumbing, matching `send_sticker`'s posture.
- **`route-tiers.test.ts` is exhaustive** — it asserts every route has a `ROUTE_MIN_TIER` entry, so Task 4 Step 3c's mapping is required for that test to stay green (no separate assertion to add; the mapping itself satisfies it).
- **If `prompt-builder.test.ts` has exact-string/snapshot assertions** on the sticker sections, update them in Task 6 Step 4 to include the new sentence.
