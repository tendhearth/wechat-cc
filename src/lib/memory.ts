/**
 * Memory inspector — read-only view of Companion v2's per-user .md store at
 *   ~/.claude/channels/wechat/memory/<userId>/...
 *
 * Why a separate top-level module (vs reusing src/adapters/store/memory-fs.ts):
 * memory-fs is per-user — it gets a single `rootDir` and serves Claude through
 * MCP. The desktop GUI / CLI need to enumerate ACROSS users, so this layer
 * sits one level up. Path-traversal protection mirrors memory-fs's logic.
 */
import { invalidateDerivedMemory, type InvalidationReason } from './memory-derived-state'
import { memoryArtifactKind } from './memory-artifacts'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { writeFileAtomic } from './json-file'
import { dirname, join, relative, resolve } from 'node:path'
import { isDerivedMemoryStale } from './memory-derived-state'
import { OWNER_FILENAME } from './memory-owner'

export interface MemoryFileEntry {
  name: string
  path: string  // relative to user dir
  size: number
  mtime: string  // ISO timestamp
}

export interface MemoryUserEntry {
  userId: string
  fileCount: number
  totalBytes: number
  files: MemoryFileEntry[]
}

// Refuse anything that could escape `<stateDir>/memory/`. wechat user ids
// look like `o9cq80abc...@im.wechat` — alnum, dash, underscore, @, dot.
const USER_ID_RE = /^[a-zA-Z0-9._@-]+$/

export function listAllMemory(stateDir: string): MemoryUserEntry[] {
  const memoryRoot = join(stateDir, 'memory')
  if (!existsSync(memoryRoot)) return []
  const out: MemoryUserEntry[] = []
  for (const entry of readdirSync(memoryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!USER_ID_RE.test(entry.name)) continue
    const files = listMdFiles(join(memoryRoot, entry.name), '')
    out.push({
      userId: entry.name,
      fileCount: files.length,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      files,
    })
  }
  out.sort((a, b) => a.userId.localeCompare(b.userId))
  return out
}

export function readMemoryFile(stateDir: string, userId: string, relPath: string): string {
  const target = resolveSafe(stateDir, userId, relPath)
  if (!existsSync(target)) {
    throw new Error(`file not found: ${userId}/${relPath}`)
  }
  return readFileSync(target, 'utf8')
}

const MAX_BYTES = 100 * 1024  // matches src/adapters/store/memory-fs.ts MemoryFS
const PROFILE_FILENAME = '_profile.json'

// Atomic write of a memory file. Body must be UTF-8 string (callers
// decode base64 etc upstream). Mirrors the sandboxing of memory-fs.ts:
// .md only, ≤100KB, path-traversal blocked, parent dirs auto-created
// inside the user root, atomic via lib/json-file(tmp 名以 . 开头,下面的列目录会跳过)。
//
// Why this lives at top level (vs memory-fs): the per-user MemoryFS in
// src/adapters/store/memory-fs.ts is bound to a single rootDir at construction
// and is what Claude's MCP tools call. The CLI / GUI need to write any
// user's file by id, so this top-level helper composes resolveSafe +
// MemoryFS-equivalent atomic write logic without instantiating one
// MemoryFS per user.
export function writeMemoryFile(stateDir: string, userId: string, relPath: string, body: string, opts: { reason?: InvalidationReason } = {}): { bytesWritten: number; created: boolean } {
  const target = resolveSafe(stateDir, userId, relPath)
  // 主人原话只经记忆编辑写(lib/memory-owner),整份覆盖会绕过「删 = 更正、加 = 原话」那一步。
  if (relative(resolve(join(stateDir, 'memory', userId)), target).split('\\').join('/').toLowerCase() === OWNER_FILENAME) {
    throw new Error('owner.md 是主人亲手写的原话,只能经记忆编辑改')
  }
  // 写的是源 ⇒ 先让这个对话的生成物过期(3e 记忆第 2 步)。主人在桌面编辑可能是删改 ⇒ 缺省 'retracted';
  // 合成写回 _overview.md 是生成物,不触发。
  if (memoryArtifactKind(relPath) === 'source') invalidateDerivedMemory(join(stateDir, 'memory', userId), opts.reason ?? 'retracted')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_BYTES) {
    throw new Error(`body too large: ${bytes}B exceeds ${MAX_BYTES}B`)
  }
  const created = !existsSync(target)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileAtomic(target, body, { mode: 0o600 })
  return { bytesWritten: bytes, created }
}

export function readMemoryProfileFile(stateDir: string, userId: string): string {
  const target = resolveProfileSafe(stateDir, userId)
  if (!existsSync(target)) {
    throw new Error(`file not found: ${userId}/${PROFILE_FILENAME}`)
  }
  const content = readFileSync(target, 'utf8')
  if (!isDerivedMemoryStale(dirname(target), 'profile')) return content
  return JSON.stringify({ ...JSON.parse(content), needsRefresh: true })
}

export function writeMemoryProfileFile(stateDir: string, userId: string, body: string): { bytesWritten: number; created: boolean } {
  const target = resolveProfileSafe(stateDir, userId)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_BYTES) {
    throw new Error(`body too large: ${bytes}B exceeds ${MAX_BYTES}B`)
  }
  const created = !existsSync(target)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileAtomic(target, body, { mode: 0o600 })
  return { bytesWritten: bytes, created }
}

// Shared sandbox check for read/write. Refuses non-.md, traversal, null
// byte, oversized path. Returns the resolved absolute path.
function resolveSafe(stateDir: string, userId: string, relPath: string): string {
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`invalid user id: ${userId}`)
  }
  if (!relPath || relPath.includes('\0') || relPath.length > 500) {
    throw new Error(`invalid path: ${relPath}`)
  }
  if (!relPath.endsWith('.md')) {
    throw new Error(`only .md files are allowed (got: ${relPath})`)
  }
  const userRoot = resolve(join(stateDir, 'memory', userId))
  const target = resolve(userRoot, relPath)
  const rel = relative(userRoot, target)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`path escapes user memory root: ${relPath}`)
  }
  return target
}

function resolveProfileSafe(stateDir: string, userId: string): string {
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`invalid user id: ${userId}`)
  }
  return resolve(join(stateDir, 'memory', userId, PROFILE_FILENAME))
}

function listMdFiles(root: string, sub: string): MemoryFileEntry[] {
  const here = sub ? join(root, sub) : root
  if (!existsSync(here)) return []
  const out: MemoryFileEntry[] = []
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.includes('.tmp-')) continue
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...listMdFiles(root, rel))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    let st: ReturnType<typeof statSync>
    try { st = statSync(join(here, entry.name)) } catch { continue }
    out.push({ name: entry.name, path: rel, size: st.size, mtime: st.mtime.toISOString() })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
