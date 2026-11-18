/**
 * project-root.ts —— 一个路径属于哪个项目(「地方」按它归拢,设计稿 2026-11-18-cc-two-sides-design.md §3)。
 *
 *   - git 仓库:把链出去的工作区(.claude/worktrees/x、工作台的独立工作区)认回主仓库;
 *   - 不是 git 仓库:取 ~/Documents(~/Desktop、~/Downloads、~)下面第一层那个文件夹;
 *   - Claude Code 在临时目录里干活(/private/tmp/claude-<uid>/<编码过的原目录>/…):回 `claude-scratch:<编码>`,
 *     由调用方对回已知的项目(编码 = 原路径里非字母数字一律换成「-」,见 claudeProjectSlug);
 *   - 路径已经不在(删掉的工作区)、别的临时目录、主目录本身、根目录:不算一个地方,回 null。
 * 同步、只读几个小文件、不起 git 子进程;按路径缓存(地方每 3 秒被读一次)。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import nodePath from 'node:path'

export interface RootFs { realpath(p: string): string; exists(p: string): boolean; isDir(p: string): boolean; isFile(p: string): boolean; read(p: string): string }

const nodeFs: RootFs = {
  realpath: p => realpathSync(p),
  exists: p => { try { statSync(p); return true } catch { return false } },
  isDir: p => { try { return statSync(p).isDirectory() } catch { return false } },
  isFile: p => { try { const s = statSync(p); return s.isFile() && s.size <= 65536 } catch { return false } },
  read: p => readFileSync(p, 'utf8'),
}

/** Claude Code 给一个工作目录起的项目名:非字母数字一律换成「-」。 */
export const claudeProjectSlug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')
export const SCRATCH_PREFIX = 'claude-scratch:'

const TEMP_ROOTS = ['/private/tmp', '/tmp', '/private/var/folders', '/var/folders']
const SCRATCH = /^\/(?:private\/)?tmp\/claude-\d+\/(-[^/]+)(?:\/|$)/

/** `path`:拼路径用哪一套(默认按平台;测试用 POSIX 的假路径时给 path.posix,三个平台算出来一样)。 */
export interface ProjectRootOptions { fs?: RootFs; home?: string; maxCache?: number; path?: typeof nodePath.posix }

export function makeProjectRoot(opts: ProjectRootOptions = {}): (path: string | null | undefined) => string | null {
  const fs = opts.fs ?? nodeFs
  const { basename, dirname, isAbsolute, join, relative, resolve, sep } = opts.path ?? nodePath
  const home = resolve(opts.home ?? homedir())
  const containers = ['Documents', 'Desktop', 'Downloads'].map(d => join(home, d)).concat(home)
  const maxCache = opts.maxCache ?? 2000
  const cache = new Map<string, string | null>()
  const under = (p: string, base: string) => { const r = relative(base, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }

  const find = (path: string): string | null => {
    const scratch = path.match(SCRATCH)
    if (scratch) return SCRATCH_PREFIX + scratch[1]
    if (TEMP_ROOTS.some(t => path === t || path.startsWith(t + '/'))) return null
    if (!fs.exists(path)) return null
    let start: string
    try { start = fs.realpath(path) } catch { start = resolve(path) }
    if (start === home || dirname(start) === start) return null
    let dir = start
    for (let depth = 0; depth < 64; depth++) {
      const marker = join(dir, '.git')
      if (fs.isDir(marker)) return dir === home ? null : dir
      if (fs.isFile(marker)) {
        try {
          const m = fs.read(marker).trim().match(/^gitdir: (.+)$/)
          if (m) {
            const gitDir = resolve(dir, m[1]!)
            let common = gitDir
            const cd = join(gitDir, 'commondir')
            if (fs.isFile(cd)) common = resolve(gitDir, fs.read(cd).trim())
            try { common = fs.realpath(common) } catch { /* 用没解开的 */ }
            return basename(common) === '.git' ? dirname(common) : dir
          }
        } catch { /* 读不了就当这一层不是仓库 */ }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // 不是 git 仓库:取最近的「放项目的地方」下面第一层。
    for (const base of containers) {
      if (!under(start, base)) continue
      const first = relative(base, start).split(sep)[0]!
      return join(base, first)
    }
    return start
  }
  return path => {
    if (!path || !isAbsolute(path)) return null
    const hit = cache.get(path)
    if (hit !== undefined) return hit
    const root = find(path)
    if (cache.size >= maxCache) cache.clear()
    cache.set(path, root)
    return root
  }
}
