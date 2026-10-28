/**
 * memory-fs.ts(原 daemon/memory/fs-api.ts;架构终态 A5 记忆搬家时归到通用 store:社交、伙伴、信、提示词素材都在读写)— sandboxed filesystem for Claude's long-term memory.
 *
 * Design philosophy: Claude is given a scratch directory it owns. We don't
 * prescribe file layout, names, or schema. We only enforce safety:
 *   - All paths resolve under a single root; `..` / absolute / symlink
 *     escapes are rejected.
 *   - Only `.md` extension — keeps content human-readable, renders in the
 *     future web UI, prevents accidental binary/exec surface.
 *   - Single file capped at 100 KB — protects against runaway writes.
 *   - Atomic writes via tmp + rename.
 *
 * Everything else (subfolders per chat_id, index files, consolidation
 * strategies) is Claude's decision, reflected at runtime via its own
 * memory_write calls, not wired into this module.
 */

import type { DerivedFence, InvalidationReason } from '../../lib/derived-fence'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { memoryArtifactKind } from '../../lib/memory-artifacts'
import { OWNER_FILENAME } from '../../lib/memory-owner'
import { writeFileAtomic } from '../../lib/json-file'

export interface MemoryFS {
  /** Read a memory file. Returns null if not present (no throw). */
  read(relPath: string): string | null
  /**
   * Write (atomic). Creates parent dirs as needed. 写的是源(lib/memory-artifacts)⇒ 先让这个对话的生成物过期:
   * `reason` 说为什么 —— CC 自己记笔记是 'added';缺省 'retracted'(往藏的方向兜底,3e 记忆第 2 步)。
   */
  write(relPath: string, content: string, opts?: { reason?: InvalidationReason }): void
  /** List all files (recursive). When `relDir` is given, lists under that subdir. */
  list(relDir?: string): string[]
  /** Delete a file. No-op if absent. */
  delete(relPath: string): void
  /**
   * Soft-delete: rename `relPath` to `relPath.deleted-<ISO>` in place.
   * Returns the new tombstone path (POSIX-normalised, relative to root)
   * on success, or null if the source file didn't exist.
   *
   * Like `delete`, runs the realpath sandbox check. Unlike `delete`,
   * never destroys data — the operator can restore by `mv`-ing the
   * tombstone back. `list()` skips `.deleted-*` so the agent doesn't
   * see them on subsequent calls.
   */
  softDelete(relPath: string): string | null
  /** Absolute root dir — for diagnostics only, not for Claude. */
  rootDir(): string
}

export interface MemoryFSOptions {
  rootDir: string
  maxFileBytes?: number      // default 100_000
  /**
   * root 是一个对话的记忆目录('chat',缺省)还是所有对话的上一层('all-chats',路径形如 `<chat>/profile.md`)。
   * 写源时要找到「这个对话」那一层去记生成物过期(3e 记忆第 2 步);明说,不从目录名猜。
   */
  layout?: 'chat' | 'all-chats'
  allowedExt?: string[]      // default ['.md']
  /**
   * 这个对话生成物的过期围栏(架构终态 G8:在主库,`makeMemoryFactsStore(db).fence`)。写源时记过期、读 _overview.md 时看它
   * 是不是该藏 / 贴标签。必须明说:null = 这一份既不写源、也不读总览(只读 agenda / knowledge.md 之类),给了 null 却去写源 ⇒ 抛错。
   */
  fences: ((chatId: string) => DerivedFence) | null
}

export class MemoryPathError extends Error {
  constructor(msg: string) {
    super(`memory: ${msg}`)
    this.name = 'MemoryPathError'
  }
}

export function makeMemoryFS(opts: MemoryFSOptions): MemoryFS {
  const fences = opts.fences
  const root = resolve(opts.rootDir)
  const maxBytes = opts.maxFileBytes ?? 100_000
  const exts = new Set((opts.allowedExt ?? ['.md']).map(s => s.toLowerCase()))

  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })

  // Resolve root through any symlinks ONCE at construction. All
  // realpath-based checks compare against this anchor so that if the
  // operator's memory/ dir is itself a symlink, files written through
  // it still pass.
  const realRoot = realpathSync(root)

  function resolveSafe(relPath: string): string {
    if (!relPath || typeof relPath !== 'string') throw new MemoryPathError('path is required')
    if (relPath.length > 500) throw new MemoryPathError('path too long (max 500 chars)')
    if (relPath.startsWith('/') || relPath.startsWith('\\')) {
      throw new MemoryPathError('absolute paths not allowed')
    }
    if (/^[a-zA-Z]:[\\/]/.test(relPath)) {
      throw new MemoryPathError('absolute paths not allowed')
    }
    if (relPath.includes('\0')) throw new MemoryPathError('null byte in path')

    const joined = resolve(root, relPath)
    const rel = relative(root, joined)
    // `rel.startsWith('..')` already covers both `..` alone and any
    // `..<anything>` prefix (e.g. `../foo`, `..\foo`). The prior third
    // condition `rel.startsWith(\`..${...}\`)` was a strict subset of
    // that — dead code. Removed.
    if (rel === '' || rel.startsWith('..')) {
      throw new MemoryPathError(`escape attempt: ${relPath}`)
    }
    return joined
  }

  /**
   * Symlink-aware second-stage check. Runs AFTER `resolveSafe` (which
   * is purely lexical) to catch the case where the lexical path is
   * inside root but resolves through a symlink to somewhere outside.
   *
   * Threat: an agent with Bash access (or a compromised account dir)
   * plants `memory/leak.md → /etc/passwd`. Lexical resolve happily
   * accepts the read; realpath check rejects it.
   *
   * `mustExist=false` is for the write path: the file doesn't exist
   * yet, so we realpath the PARENT directory and rebuild the candidate
   * full path against the real parent. If even the parent doesn't
   * exist yet, walk up until we find an existing ancestor and
   * realpath that.
   */
  function assertWithinRealRoot(joinedPath: string, mustExist: boolean): void {
    let real: string
    try {
      if (mustExist || existsSync(joinedPath)) {
        real = realpathSync(joinedPath)
      } else {
        // Walk up to the nearest existing ancestor, realpath it, then
        // rebuild the candidate path. Handles arbitrarily deep
        // not-yet-created subdirs in write paths.
        let cursor = joinedPath
        const suffixParts: string[] = []
        while (!existsSync(cursor)) {
          const parent = dirname(cursor)
          if (parent === cursor) throw new MemoryPathError(`unable to resolve ancestor: ${joinedPath}`)
          suffixParts.unshift(cursor.slice(parent.length + 1))
          cursor = parent
        }
        const realAncestor = realpathSync(cursor)
        real = suffixParts.length > 0 ? join(realAncestor, ...suffixParts) : realAncestor
      }
    } catch (err) {
      if (err instanceof MemoryPathError) throw err
      // ELOOP, EACCES, other realpath failures — treat as escape.
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      throw new MemoryPathError(`realpath failed (${code}): ${joinedPath}`)
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new MemoryPathError(`escape via symlink: ${joinedPath} → ${real}`)
    }
  }

  function extOf(p: string): string {
    const m = p.match(/\.[^./\\]+$/)
    return m ? m[0].toLowerCase() : ''
  }

  function checkExt(p: string): void {
    const ext = extOf(p)
    if (!exts.has(ext)) {
      throw new MemoryPathError(`extension not allowed: ${ext || '(none)'}; allowed: ${[...exts].join(', ')}`)
    }
  }

  /** 生成物的过期标记记在「这个对话」那一层:layout 'chat' ⇒ root;'all-chats' ⇒ root/<第一段>(只有一段的就是 root)。 */
  function chatRootOf(full: string): string {
    if (opts.layout !== 'all-chats') return root
    const segs = relative(root, full).split(sep)
    return segs.length > 1 ? join(root, segs[0]!) : root
  }

  /**
   * 主人原话 owner.md 只经记忆编辑写(features/memory/memory-export 的 commitOwner):CC 不能替主人「说」话,也不能删主人说的。
   * 只认对话那一层的 owner.md(notes/owner.md 是普通笔记);不分大小写 —— macOS 默认卷上 Owner.md 是同一个文件。
   */
  function refuseOwnerFile(full: string): void {
    if (relative(chatRootOf(full), full).split(sep).join('/').toLowerCase() === OWNER_FILENAME) {
      throw new MemoryPathError('owner.md 是主人亲手写的原话,只能由主人在记忆页上改')
    }
  }

  /**
   * _overview.md 现在能不能给(3e 记忆第 2 步,整合者定):主人删了 / 改了东西以后的过期 ⇒ 藏(总览会进串门人设,带到别人的 CC
   * 那里,不能把主人撤掉的话说出去);只是源里多了东西 ⇒ 照常给,开头贴一句「这份是哪天整理的、之后又有变化」。
   */
  function overviewStatus(full: string): 'fresh' | 'added' | 'retracted' {
    const real = realpathSync(full)
    if (basename(real) !== '_overview.md') return 'fresh'
    if (!opts.fences) throw new MemoryPathError('reading _overview.md needs the derived fence (fences: null)')
    return opts.fences(basename(dirname(real))).status('overview')
  }
  /** 读的时候贴上去的那句。写回来时剥掉(可能叠了好几层),不然模型读完原样 memory_write 回去,标签就成了正文(整合者评审 #581)。 */
  const STALE_LABEL = /^> \(这份整体理解是[^\n]*整理的,之后记忆又有变化,可能不全。\)\n\n/
  function stripStaleLabels(text: string): string {
    while (STALE_LABEL.test(text)) text = text.replace(STALE_LABEL, '')
    return text
  }
  function staleLabel(full: string): string {
    let day = ''
    try { const d = new Date(statSync(full).mtimeMs); day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` } catch { /* 拿不到日期就不写 */ }
    return `> (这份整体理解是${day ? ` ${day} ` : '之前'}整理的,之后记忆又有变化,可能不全。)\n\n`
  }

  return {
    rootDir: () => root,

    read(relPath) {
      const full = resolveSafe(relPath)
      checkExt(full)
      if (!existsSync(full)) return null
      assertWithinRealRoot(full, true)
      const status = overviewStatus(full)
      if (status === 'retracted') return null
      const text = readFileSync(full, 'utf8')
      return status === 'added' ? staleLabel(full) + text : text
    },

    write(relPath, content, opts) {
      const full = resolveSafe(relPath)
      checkExt(full)
      if (typeof content !== 'string') throw new MemoryPathError('content must be a string')
      refuseOwnerFile(full)
      if (basename(full) === '_overview.md') content = stripStaleLabels(content)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > maxBytes) {
        throw new MemoryPathError(`file too large: ${bytes} bytes > ${maxBytes} limit`)
      }
      const dir = dirname(full)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Symlink check AFTER mkdirSync so the parent definitely exists
      // and realpathSync(parent) succeeds; check the candidate full
      // path (which may not yet exist).
      assertWithinRealRoot(full, false)
      const chatRoot = chatRootOf(full)
      if (memoryArtifactKind(relative(chatRoot, full)) === 'source') {
        if (!fences) throw new MemoryPathError('writing a memory source needs the derived fence (fences: null)')
        fences(basename(chatRoot)).invalidate(opts?.reason ?? 'retracted')
      }
      writeFileAtomic(full, content, { mode: 0o600 })
    },

    list(relDir) {
      const full = relDir ? resolveSafe(relDir) : root
      if (!existsSync(full)) return []
      // The starting directory must itself be within real root (handles
      // `relDir` pointing at a symlinked escape dir).
      try { assertWithinRealRoot(full, true) } catch { return [] }
      const out: string[] = []
      const stack: string[] = [full]
      while (stack.length > 0) {
        const dir = stack.pop()!
        let entries: import('node:fs').Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) } catch { continue }
        for (const entry of entries) {
          // Skip hidden entries, tmp files from interrupted atomic writes,
          // and soft-delete tombstones (recoverable by `mv` but invisible
          // to the agent — see softDelete).
          if (entry.name.startsWith('.') || entry.name.includes('.tmp-') || entry.name.includes('.deleted-')) continue
          const p = join(dir, entry.name)
          // Don't follow symlinks during list — a symlink inside root
          // pointing outside would surface paths that read() will
          // (now) reject. Quietly skip the entry rather than emit a
          // path that fails to fetch.
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) stack.push(p)
          else if (entry.isFile() && exts.has(extOf(entry.name))) {
            if (overviewStatus(p) === 'retracted') continue
            // Normalize to POSIX so the public API (paths shown to Claude
            // and consumed by `memory_read`) is identical on Windows + POSIX.
            out.push(relative(root, p).split(sep).join('/'))
          }
        }
      }
      return out.sort()
    },

    delete(relPath) {
      const full = resolveSafe(relPath)
      checkExt(full)
      refuseOwnerFile(full)
      if (!existsSync(full)) return
      assertWithinRealRoot(full, true)
      unlinkSync(full)
    },

    softDelete(relPath) {
      const full = resolveSafe(relPath)
      checkExt(full)
      refuseOwnerFile(full)
      if (!existsSync(full)) return null
      assertWithinRealRoot(full, true)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const tombstone = `${full}.deleted-${stamp}`
      renameSync(full, tombstone)
      return relative(root, tombstone).split(sep).join('/')
    },
  }
}
