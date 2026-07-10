/**
 * stickers — tagged sticker library. Files live under `<stateDir>/stickers/`;
 * a state-store index (`stickers.json`, write-through per
 * architecture-conventions #5) maps filename → {tags, desc?}. Mirrors the
 * chat-prefs store pattern: injectable store seam, corrupt-value handling
 * (skip, never throw).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve as resolvePath } from 'node:path'
import { makeStateStore, type StateStore } from './state-store'

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export interface StickerEntry {
  file: string
  tags: string[]
  desc?: string
}

export interface StickerLib {
  /** Copies sourcePath into the library. Throws Error('invalid_extension') / Error('empty_tags') / Error('invalid_tag'). */
  save(sourcePath: string, tags: string[], desc?: string): { file: string; tags: string[] }
  /** ABSOLUTE path of a random match; trim+case-insensitive tag compare. */
  resolve(tag: string): string | null
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

export function makeStickerLib(stateDir: string, deps?: { store?: StateStore; random?: () => number }): StickerLib {
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

    resolve(tag) {
      const target = tag.trim().toLowerCase()
      const matches = entries()
        .filter((e) => e.tags.some((t) => t.trim().toLowerCase() === target))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      if (matches.length === 0) return null
      const idx = Math.floor(random() * matches.length)
      return resolvePath(dir, matches[idx]!.file)
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
