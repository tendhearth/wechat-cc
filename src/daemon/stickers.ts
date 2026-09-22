import { materializeCcStarterPack } from './cc-starter-pack'
/**
 * stickers — tagged sticker library. Files live under `<stateDir>/stickers/`;
 * a state-store index (`stickers.json`, write-through per
 * architecture-conventions #5) maps filename → {tags, desc?}. Mirrors the
 * chat-prefs store pattern: injectable store seam, corrupt-value handling
 * (skip, never throw).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, basename, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompiledBundle } from '../lib/runtime-info'
import { makeStateStore, type StateStore } from './state-store'
import { readJsonFile } from '../lib/read-json-file'

const LEGACY_BEAR_DESCRIPTIONS: Record<string, string> = {
  'bear-complete.png': '小熊够到了小蜜蜂,开心',
  'onboarding-success.png': '小熊看着满满的鱼缸,大功告成',
  'onboarding-missing.png': '小熊拎着袋装小鱼要送给你',
  'moment-ai-offline.png': '小熊安静地坐着看鱼缸,陪着你',
}

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export interface StickerEntry {
  file: string
  tags: string[]
  desc?: string
}

/** A mood with this many local stickers no longer needs online search. */
export const ONLINE_STICKER_K = 5

export function countForTag(entries: StickerEntry[], tag: string): number {
  const target = tag.trim().toLowerCase()
  return entries.filter((entry) => entry.tags.some((item) => item.trim().toLowerCase() === target)).length
}

export interface StickerLib {
  /** Copies sourcePath into the library. Throws Error('invalid_extension') / Error('empty_tags') / Error('invalid_tag'). */
  save(sourcePath: string, tags: string[], desc?: string): { file: string; tags: string[] }
  /** ABSOLUTE path of a random match; trim+case-insensitive tag compare. */
  resolve(tag: string, chatId?: string): string | null
  list(): StickerEntry[]
  /** Unique, sorted. */
  allTags(): string[]
}

interface IndexValue {
  tags: string[]
  desc?: string
}

// Forbidden anywhere in a (trimmed) tag: control chars (incl. newline/CR),
// backtick, #, [, ], <, > — these are the characters that let a tag escape
// its plain-text slot in stickerSection() and land as markdown/injection
// inside a chat's system prompt. save_sticker is trusted-tier but the
// resulting tags fan out into EVERY chat's prompt via allTags(), so a
// malicious/careless trusted-tier tag would be a cross-tier injection.
const FORBIDDEN_TAG_CHARS = /[`#[\]<>\x00-\x1f\x7f]/

/**
 * Normalizes a single tag: trim, collapse internal whitespace to single
 * spaces, then reject (Error('invalid_tag')) if empty, >20 chars, or
 * containing any forbidden character (checked pre-collapse so embedded
 * newlines/control chars are never silently turned into spaces).
 */
function normalizeTag(raw: string): string {
  const trimmed = raw.trim()
  if (FORBIDDEN_TAG_CHARS.test(trimmed)) throw new Error('invalid_tag')
  const normalized = trimmed.replace(/\s+/g, ' ')
  if (normalized.length === 0 || normalized.length > 20) throw new Error('invalid_tag')
  return normalized
}

function parseIndexValue(raw: string): IndexValue | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const obj = v as Record<string, unknown>
    if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === 'string')) return null
    if (obj.desc !== undefined && typeof obj.desc !== 'string') return null
    return { tags: obj.tags as string[], desc: obj.desc as string | undefined }
  } catch {
    return null
  }
}

export function makeStickerLib(stateDir: string, deps?: { store?: StateStore; random?: () => number; feedback?: { weight(chatId: string, file: string): number } }): StickerLib {
  const dir = join(stateDir, 'stickers')
  const store = deps?.store ?? makeStateStore(join(dir, 'stickers.json'), { debounceMs: 0 })
  const random = deps?.random ?? Math.random

  function entries(): StickerEntry[] {
    const all = store.all()
    const result: StickerEntry[] = []
    for (const file of Object.keys(all)) {
      if (!existsSync(join(dir, file))) continue
      const parsed = parseIndexValue(all[file]!)
      if (!parsed) continue
      result.push({ file, tags: parsed.tags, desc: parsed.desc })
    }
    return result
  }

  return {
    save(sourcePath, tags, desc) {
      const ext = extname(sourcePath).slice(1).toLowerCase()
      if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error('invalid_extension')
      if (!Array.isArray(tags) || tags.length === 0 || !tags.every((t) => typeof t === 'string' && t.trim().length > 0)) {
        throw new Error('empty_tags')
      }
      // Normalize + validate each tag at the source (before it ever reaches
      // stickerSection()'s prompt injection), then dedupe.
      const normalizedTags = [...new Set(tags.map(normalizeTag))]

      mkdirSync(dir, { recursive: true })

      const base = basename(sourcePath, extname(sourcePath))
      let candidate = `${base}.${ext}`
      let n = 0
      while (existsSync(join(dir, candidate))) {
        n += 1
        candidate = `${base}-${n}.${ext}`
      }

      copyFileSync(sourcePath, join(dir, candidate))
      store.set(candidate, JSON.stringify({ tags: normalizedTags, desc }))
      return { file: candidate, tags: normalizedTags }
    },

    resolve(tag, chatId?: string) {
      const target = tag.trim().toLowerCase()
      let matches = entries()
        .filter((e) => e.tags.some((t) => t.trim().toLowerCase() === target))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      // Retain legacy bundled art in collections, but prefer CC for automatic replies.
      if (matches.some(e => e.file.startsWith('cc-ink-v1-'))) {
        matches = matches.filter(e => !(Object.hasOwn(LEGACY_BEAR_DESCRIPTIONS, e.file) && LEGACY_BEAR_DESCRIPTIONS[e.file] === e.desc))
      }
      if (matches.length === 0) return null
      if (!chatId || !deps?.feedback) {
        const idx = Math.floor(random() * matches.length)
        return resolvePath(dir, matches[idx]!.file)
      }
      const weighted = matches.map((entry) => ({ entry, weight: deps.feedback!.weight(chatId, entry.file) }))
      const total = weighted.reduce((sum, item) => sum + item.weight, 0)
      let cursor = random() * total
      for (const item of weighted) { cursor -= item.weight; if (cursor <= 0) return resolvePath(dir, item.entry.file) }
      return resolvePath(dir, weighted[weighted.length - 1]!.entry.file)
    },

    list() {
      return entries()
    },

    allTags() {
      const set = new Set<string>()
      for (const e of entries()) for (const t of e.tags) set.add(t)
      return [...set].sort()
    },
  }
}

/**
 * 初始表情包 (2026-08-25, owner: 用户一开始不知道有表情包,给个初始) —
 * Versioned CC packs add missing entries without deleting collections.
 * Legacy unversioned packs still seed only an empty library.
 */
export function starterStickersDir(): string | null {
  if (isCompiledBundle()) return materializeCcStarterPack()
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')   // src/daemon → repo
  if (!root) return null
  const dir = join(root, 'assets', 'starter-stickers')
  return existsSync(dir) ? dir : null
}

/** Returns how many stickers were seeded (0 = library non-empty / pack absent / bad manifest). */
export function seedStarterStickers(lib: StickerLib, packDir: string, log?: (tag: string, line: string) => void): number {
  try {
    const existing = lib.list()
    const manifest = readJsonFile(join(packDir, 'manifest.json')) as unknown
    if (!Array.isArray(manifest)) return 0
    const versioned = manifest.length > 0 && manifest.every(e => e?.pack === 'cc-ink-v1' && /^cc-ink-v1-[a-z-]+\.png$/.test(e.file))
    if (existing.length > 0 && !versioned) return 0
    const present = new Set(existing.map(e => e.file))
    let seeded = 0
    for (const entry of manifest) {
      const e = entry as { file?: unknown; tags?: unknown; desc?: unknown }
      if (typeof e.file !== 'string' || !Array.isArray(e.tags) || present.has(e.file)) continue
      try {
        lib.save(join(packDir, e.file), e.tags as string[], typeof e.desc === 'string' ? e.desc : undefined)
        present.add(e.file)
        seeded++
      } catch (err) {
        log?.('STICKERS', `starter seed skipped ${e.file}: ${String(err)}`)
      }
    }
    if (seeded > 0) log?.('STICKERS', `starter pack seeded: ${seeded} sticker(s)`)
    return seeded
  } catch {
    return 0
  }
}
