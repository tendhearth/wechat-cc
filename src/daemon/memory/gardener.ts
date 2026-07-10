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
 *  2. Output validated: non-empty, length <= original (gardening shrinks;
 *     a longer output means the model invented — skip, never trust).
 *  3. Auth-fail screening via assertNotAuthFailed.
 *  4. Skip (never delete) on any doubt; watermark updated only after a
 *     successful write.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertNotAuthFailed } from '../../core/agent-provider'

export const MIN_GARDEN_BYTES = 2048
export const MAX_GARDEN_FILES_PER_TICK = 5

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
}

type WatermarkState = Record<string, Watermark>

interface EligibleFile {
  chatId: string
  relPath: string
  fullPath: string
  content: string
  watermarkKey: string
  /** Last-gardened timestamp (YYYY-MM-DD), or '' when never gardened — sorts oldest-first. */
  at: string
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
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

      eligible.push({ chatId, relPath, fullPath, content, watermarkKey, at: entry?.at ?? '' })
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

      if (curated.length === 0) {
        log('GARDEN', `skip ${item.watermarkKey}: empty output`)
        skipped++
        continue
      }
      if (curated.length > item.content.length) {
        log('GARDEN', `skip ${item.watermarkKey}: output longer than original (${curated.length} > ${item.content.length} bytes) — possible invention`)
        skipped++
        continue
      }

      // Safety rail 1: archive BEFORE overwrite.
      archiveOriginal(archiveRoot, item.chatId, item.relPath, today, item.content)
      // Then the atomic overwrite.
      atomicWriteFile(item.fullPath, curated)

      // Watermark only after a successful write (safety rail 4).
      state[item.watermarkKey] = { hash: sha256(curated), at: today }
      writeState(stateFile, state)

      gardened++
      log('GARDEN', `gardened ${item.watermarkKey} (${item.content.length} -> ${curated.length} bytes)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('GARDEN', `skip ${item.watermarkKey}: ${msg}`)
      skipped++
    }
  }

  return { gardened, skipped }
}
