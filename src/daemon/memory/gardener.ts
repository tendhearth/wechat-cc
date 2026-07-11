/**
 * memory/gardener.ts — 记忆园丁: daily curation pass over each chat's
 * freeform memory files (profile.md, preferences.md, notes/*.md).
 *
 * Design: docs/superpowers/specs/2026-07-10-memory-gardener-design.md
 *
 * Pure-ish lib — every dependency (paths, cheapEval, log, clock) is
 * injected so the whole thing is unit-testable without a real daemon.
 * Wired into introspectTick (src/daemon/wiring/tick-bodies.ts) behind the
 * same resolved cheapEval gate as the other 24h steps.
 *
 * Safety rails (all mandatory, see spec §2):
 *  1. Original archived BEFORE overwrite, outside the agent-visible memory
 *     dir (so memory_list stays clean).
 *  2. Output validated: non-empty, byte-length <= original and <=
 *     MAX_GARDEN_CURATED_BYTES, not below the shrink floor (curation
 *     tightens, it doesn't obliterate — see the over_shrunk check), not
 *     refusal-shaped (full-string scan, not just a prefix), and shares
 *     enough max-normalized vocabulary with the original (see
 *     validateCuration/contentOverlap) — a longer/invented/refused/
 *     degenerate output is never trusted.
 *  3. Auth-fail screening via assertNotAuthFailed.
 *  4. Re-hashed immediately before the overwrite to catch a live
 *     memory_write racing the LLM call (see the concurrency re-check).
 *  5. Skip (never delete) on any doubt; watermark updated only after a
 *     successful write; repeated validation failures on the same content
 *     back off instead of retrying forever (see recordValidationFailure).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertNotAuthFailed } from '../../core/agent-provider'

export const MIN_GARDEN_BYTES = 2048
export const MAX_GARDEN_FILES_PER_TICK = 5
/** Mirrors fs-api.ts's default `maxFileBytes` (100_000) — the gardener writes
 * via raw fs (atomicWriteFile), bypassing memory/fs-api.ts entirely, so it
 * must enforce the same cap itself or it could write a file no memory_write
 * caller would ever have been allowed to create. */
export const MAX_GARDEN_CURATED_BYTES = 100_000
/** After this many consecutive validation-skips on the same content, stop
 * retrying every tick (livelock guard) — see `giving_up` below. */
const MAX_VALIDATION_FAILS = 3

const REFUSAL_RE = /(我不能|我无法|抱歉[,，]|无法帮助|不能协助|as an AI|I can['’]t help|I['’]m sorry)/i

export interface GardenerDeps {
  /** `<stateDir>/memory` — one subdir per chatId. */
  memoryRoot: string
  /** `<stateDir>/memory-archive` — pre-overwrite snapshots, outside memoryRoot. */
  archiveRoot: string
  /** `<stateDir>/garden_state.json` — watermarks, keyed `<chatId>/<relPath>`. */
  stateFile: string
  cheapEval: (prompt: string) => Promise<string>
  log: (tag: string, line: string) => void
  /** YYYY-MM-DD, injected — no `new Date()` inside this module. */
  today: string
}

export interface GardenResult {
  gardened: number
  skipped: number
}

interface Watermark {
  hash: string
  at: string
  /** Consecutive validation-skip count for the CURRENT (unsuccessfully
   * curated) content version. Reset to 0 (and hash advanced) once it hits
   * MAX_VALIDATION_FAILS — see `giving_up`. Absent/undefined == 0. */
  fails?: number
}

type WatermarkState = Record<string, Watermark>

interface EligibleFile {
  chatId: string
  relPath: string
  fullPath: string
  content: string
  /** sha256 of `content` as read during listing — used to detect a live
   * memory_write landing between listing and the post-LLM overwrite. */
  originalHash: string
  watermarkKey: string
  /** Last-gardened timestamp (YYYY-MM-DD), or '' when never gardened — sorts oldest-first. */
  at: string
  /** Consecutive validation-fails carried over from the watermark state. */
  fails: number
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** True for CJK ideographs/kana/hangul — languages that don't use whitespace
 * to separate words, so we tokenize them one character at a time instead. */
function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul syllables
  )
}

function tokenize(text: string): string[] {
  const tokens: string[] = []
  let word = ''
  const flush = () => {
    if (word) {
      tokens.push(word.toLowerCase())
      word = ''
    }
  }
  for (const ch of text) {
    if (isCJKChar(ch)) {
      flush()
      tokens.push(ch)
    } else if (/[\s\p{P}\p{S}]/u.test(ch)) {
      flush()
    } else {
      word += ch
    }
  }
  flush()
  return tokens
}

/**
 * Fraction of shared vocabulary between `original` and `curated`, normalized
 * by the LARGER of the two distinct-token sets (not just `curated`'s).
 * Gardening is supposed to REUSE the original's words (merge, trim, dedupe)
 * — real curation keeps most of the original's vocabulary, so this ratio
 * stays high whichever side it's normalized against. Normalizing by
 * `curated` alone is gameable: a tiny, mostly-unrelated output (e.g. one
 * short sentence) can still score high if every one of its FEW tokens
 * happens to appear somewhere in a large original — max-normalization
 * requires the curated output to actually cover a large fraction of the
 * original's vocabulary too, not just avoid contradicting it. Returns 0 for
 * an empty curated input.
 */
export function contentOverlap(original: string, curated: string): number {
  const originalTokens = new Set(tokenize(original))
  const curatedTokens = new Set(tokenize(curated))
  if (curatedTokens.size === 0) return 0
  let hits = 0
  for (const t of curatedTokens) {
    if (originalTokens.has(t)) hits++
  }
  return hits / Math.max(originalTokens.size, curatedTokens.size)
}

function readState(stateFile: string): WatermarkState {
  if (!existsSync(stateFile)) return {}
  try {
    const raw = readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as WatermarkState
    }
  } catch {
    // corrupt JSON — start empty, same as state-store.ts.
  }
  return {}
}

function writeState(stateFile: string, data: WatermarkState): void {
  const dir = dirname(stateFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, stateFile)
}

/** Candidate relPaths for one chat dir: profile.md, preferences.md, notes/*.md
 * (existing only, non-recursive under notes/). Anything not explicitly
 * listed here (agenda.md, persona.md, _overview.md, archive/**) is simply
 * never a candidate — the inclusion list IS the exclusion rule. */
function candidateRelPaths(chatDir: string): string[] {
  const out: string[] = []
  for (const name of ['profile.md', 'preferences.md']) {
    if (existsSync(join(chatDir, name))) out.push(name)
  }
  const notesDir = join(chatDir, 'notes')
  if (existsSync(notesDir)) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(notesDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.') || entry.name.includes('.tmp-') || entry.name.includes('.deleted-')) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      out.push(`notes/${entry.name}`)
    }
  }
  return out
}

function buildGardenPrompt(content: string): string {
  return (
    '你是这份记忆文件的园丁。请整理下面的内容：\n' +
    '- 合并重复的内容\n' +
    '- 删除已经过期、或被后来信息推翻的内容\n' +
    '- 保留所有仍然有效的事实、印象、偏好\n' +
    '- 保持第一人称的 mental model 口吻\n' +
    '- 让内容更紧凑\n' +
    '不允许发明新信息——只能合并、删减、精炼已有内容。\n' +
    '直接输出整理后的完整文件内容，不要解释、不要加任何说明或前后缀。\n\n' +
    '--- 原文件内容 ---\n' +
    content
  )
}

function atomicWriteFile(fullPath: string, content: string): void {
  const dir = dirname(fullPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${fullPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, { mode: 0o600, encoding: 'utf8' })
  renameSync(tmp, fullPath)
}

function archiveOriginal(archiveRoot: string, chatId: string, relPath: string, today: string, content: string): void {
  const archivePath = join(archiveRoot, chatId, `${relPath}.${today}.md`)
  const archiveDir = dirname(archivePath)
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  writeFileSync(archivePath, content, { mode: 0o600, encoding: 'utf8' })
}

interface InvalidCuration {
  reason: string
  detail: string
}

/** All the ways a curated output can be rejected before it's ever written
 * to disk. Order matters only for which `reason` gets reported when
 * multiple checks would fail — cheapest/hardest invariants first. */
function validateCuration(original: string, curated: string): InvalidCuration | null {
  if (curated.length === 0) {
    return { reason: 'empty', detail: 'empty output' }
  }

  const curatedBytes = Buffer.byteLength(curated, 'utf8')
  const originalBytes = Buffer.byteLength(original, 'utf8')

  // Absolute cap — mirrors fs-api.ts's maxFileBytes default. The gardener
  // writes via raw fs (atomicWriteFile), bypassing fs-api.ts entirely, so
  // nothing else would stop it writing a file no memory_write caller could
  // ever have created.
  if (curatedBytes > MAX_GARDEN_CURATED_BYTES) {
    return { reason: 'too_large', detail: `output exceeds ${MAX_GARDEN_CURATED_BYTES} byte cap (${curatedBytes} bytes)` }
  }

  // Byte length, not JS string `.length` (UTF-16 code units) — a curated
  // string can have FEWER chars than the original yet MORE utf8 bytes
  // (e.g. CJK expansion), which `.length` would miss entirely.
  if (curatedBytes > originalBytes) {
    return { reason: 'longer', detail: `output longer than original (${curatedBytes} > ${originalBytes} bytes) — possible invention` }
  }

  // Shrink floor: curation TIGHTENS content, it doesn't obliterate it. A
  // curated output far smaller than the original is more consistent with a
  // refusal/degenerate output that also happened to pass the (gameable, see
  // contentOverlap) vocabulary check than with real curation. The relative
  // bound (20% of original) is a floor, not a ceiling, for aggressive-but-
  // legitimate tightening; the absolute 512-byte bound keeps that relative
  // bound from being trivially satisfied by near-MIN_GARDEN_BYTES originals.
  const shrinkFloor = Math.min(512, 0.2 * originalBytes)
  if (curatedBytes < shrinkFloor) {
    return { reason: 'over_shrunk', detail: `output far smaller than original (${curatedBytes} < ${shrinkFloor.toFixed(0)} byte floor) — possible refusal/degenerate output` }
  }

  // Scan the FULL string, not just a prefix — a refusal appended after
  // mostly-verbatim content (e.g. "<original text...> I'm sorry, I can't
  // include some of the sensitive details.") would slip past a prefix-only
  // scan. The false-positive risk (original content that legitimately
  // contains a refusal-shaped phrase, e.g. "抱歉," in a quote, and survives
  // curation) is acceptable: the failure mode here is SKIP, not corruption —
  // worst case we retry/back off on legitimate content, we never write bad
  // content. Slice to 80 chars only for the log line, not the check itself.
  if (REFUSAL_RE.test(curated)) {
    return { reason: 'refusal_shape', detail: `output looks like a refusal: "${curated.slice(0, 80)}"` }
  }

  const overlap = contentOverlap(original, curated)
  if (overlap < 0.5) {
    return { reason: 'low_overlap', detail: `low vocabulary overlap with original (${(overlap * 100).toFixed(0)}%) — possible invention` }
  }

  return null
}

/**
 * Records a validation-skip against the watermark state and persists it
 * immediately (each `runGarden` call is one daemon tick — an in-memory-only
 * counter would never survive to the next tick). `hash: ''` is a sentinel
 * that can never equal a real sha256 hex digest, so gate (b) in the next
 * listing pass keeps this file eligible (i.e. it WILL be retried) until
 * either it's gardened successfully or it hits MAX_VALIDATION_FAILS.
 *
 * Livelock guard: once `fails` reaches MAX_VALIDATION_FAILS, stop retrying
 * this content version every tick — advance the watermark hash to the
 * CURRENT (still-original) content and reset fails to 0. Gate (b) then
 * skips it silently on future ticks; it only becomes eligible again once
 * the file's content actually changes.
 */
function recordValidationFailure(
  state: WatermarkState,
  stateFile: string,
  item: EligibleFile,
  invalid: InvalidCuration,
  log: (tag: string, line: string) => void,
  today: string,
): void {
  log('GARDEN', `skip ${item.watermarkKey}: ${invalid.detail} (reason=${invalid.reason})`)
  const fails = item.fails + 1
  if (fails >= MAX_VALIDATION_FAILS) {
    state[item.watermarkKey] = { hash: item.originalHash, at: today, fails: 0 }
    log('GARDEN', `giving_up ${item.watermarkKey}: ${fails} consecutive validation fails (last reason=${invalid.reason}) — watermark advanced past current content, will not retry until it changes`)
  } else {
    state[item.watermarkKey] = { hash: '', at: today, fails }
  }
  writeState(stateFile, state)
}

export async function runGarden(deps: GardenerDeps): Promise<GardenResult> {
  const { memoryRoot, archiveRoot, stateFile, cheapEval, log, today } = deps
  let gardened = 0
  let skipped = 0

  if (!existsSync(memoryRoot)) return { gardened, skipped }

  const state = readState(stateFile)

  let chatDirs: string[]
  try {
    chatDirs = readdirSync(memoryRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch (err) {
    log('GARDEN', `failed to list memoryRoot: ${err instanceof Error ? err.message : String(err)}`)
    return { gardened, skipped }
  }

  const eligible: EligibleFile[] = []

  for (const chatId of chatDirs) {
    const chatDir = join(memoryRoot, chatId)
    const relPaths = candidateRelPaths(chatDir)
    for (const relPath of relPaths) {
      const fullPath = join(chatDir, relPath)
      let content: string
      try {
        content = readFileSync(fullPath, 'utf8')
      } catch {
        continue // vanished/unreadable between listing and read — skip quietly
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes < MIN_GARDEN_BYTES) continue // gate (a): too small, zero LLM cost

      const hash = sha256(content)
      const watermarkKey = `${chatId}/${relPath}`
      const entry = state[watermarkKey]
      if (entry && entry.hash === hash) continue // gate (b): unchanged since last garden

      eligible.push({
        chatId,
        relPath,
        fullPath,
        content,
        originalHash: hash,
        watermarkKey,
        at: entry?.at ?? '',
        fails: entry?.fails ?? 0,
      })
    }
  }

  // Oldest-watermark-first; missing `at` (never gardened) sorts as oldest
  // ('' < any 'YYYY-MM-DD' string lexicographically).
  eligible.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  const selected = eligible.slice(0, MAX_GARDEN_FILES_PER_TICK)

  for (const item of selected) {
    try {
      const prompt = buildGardenPrompt(item.content)
      const raw = await cheapEval(prompt)
      assertNotAuthFailed(raw, log, 'gardener')
      const curated = raw.trim()

      const invalid = validateCuration(item.content, curated)
      if (invalid) {
        skipped++
        recordValidationFailure(state, stateFile, item, invalid, log, today)
        continue
      }

      // Safety rail 2 (concurrency): re-read + re-hash the file immediately
      // before the overwrite. The LLM call above can take seconds; a live
      // memory_write may have landed on this exact file in the meantime.
      // If so, skip WITHOUT touching the watermark — the next tick lists
      // fresh content and re-evaluates it from scratch.
      let onDisk: string
      try {
        onDisk = readFileSync(item.fullPath, 'utf8')
      } catch {
        log('GARDEN', `skip ${item.watermarkKey}: file vanished before overwrite (reason=concurrent_write)`)
        skipped++
        continue
      }
      if (sha256(onDisk) !== item.originalHash) {
        log('GARDEN', `skip ${item.watermarkKey}: file changed since listing (reason=concurrent_write)`)
        skipped++
        continue
      }

      // Safety rail 1: archive BEFORE overwrite.
      archiveOriginal(archiveRoot, item.chatId, item.relPath, today, item.content)
      // Then the atomic overwrite.
      atomicWriteFile(item.fullPath, curated)

      gardened++
      log('GARDEN', `gardened ${item.watermarkKey} (${item.content.length} -> ${curated.length} bytes)`)

      // Watermark only after a successful write (safety rail 4). If
      // persisting it fails, the write already happened — this is NOT a
      // skip, just an unfortunate watermark miss (worst case: re-gardened
      // next tick, which is safe, just wasted LLM cost).
      try {
        state[item.watermarkKey] = { hash: sha256(curated), at: today, fails: 0 }
        writeState(stateFile, state)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('GARDEN', `gardened_but_watermark_failed ${item.watermarkKey}: ${msg}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('GARDEN', `skip ${item.watermarkKey}: ${msg}`)
      skipped++
    }
  }

  return { gardened, skipped }
}
