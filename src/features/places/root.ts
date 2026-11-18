/**
 * root.ts —— 一个路径属于哪个项目:把 git 工作区(.claude/worktrees/x、工作台的独立工作区)认回主仓库,
 * 不是 git 仓库的文件夹就是它自己。同步、只读几个小文件、不起 git 子进程;按路径缓存(地方每 3 秒被读一次)。
 * 和 features/terminal/project-memory.ts 的 projectIdentity 同一套认法(那个是异步的,还要算别名)。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export interface RootFs { realpath(p: string): string; isDir(p: string): boolean; isFile(p: string): boolean; read(p: string): string }

const nodeFs: RootFs = {
  realpath: p => realpathSync(p),
  isDir: p => { try { return statSync(p).isDirectory() } catch { return false } },
  isFile: p => { try { const s = statSync(p); return s.isFile() && s.size <= 65536 } catch { return false } },
  read: p => readFileSync(p, 'utf8'),
}

export function makeProjectRoot(fs: RootFs = nodeFs, maxCache = 2000): (path: string | null | undefined) => string | null {
  const cache = new Map<string, string | null>()
  const find = (path: string): string | null => {
    let start: string
    try { start = fs.realpath(path) } catch { start = resolve(path) }
    let dir = start
    for (let depth = 0; depth < 64; depth++) {
      const marker = join(dir, '.git')
      if (fs.isDir(marker)) return dir
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
