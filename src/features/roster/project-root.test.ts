import { describe, expect, it } from 'vitest'
import { makeProjectRoot, type RootFs } from './project-root'

function fakeFs(dirs: string[], files: Record<string, string>): RootFs & { reads: number } {
  const f = {
    reads: 0,
    realpath: (p: string) => p,
    isDir: (p: string) => dirs.includes(p),
    isFile: (p: string) => p in files,
    read: (p: string) => { f.reads++; return files[p]! },
  }
  return f
}

describe('makeProjectRoot', () => {
  it('主仓库里的子目录 ⇒ 仓库根', () => {
    const root = makeProjectRoot(fakeFs(['/w/rici/.git'], {}))
    expect(root('/w/rici/src/import')).toBe('/w/rici')
  })

  it('链出去的工作区(.git 是文件) ⇒ 认回主仓库', () => {
    const fs = fakeFs(['/w/cc/.git'], {
      '/w/cc/.claude/worktrees/x/.git': 'gitdir: /w/cc/.git/worktrees/x',
      '/w/cc/.git/worktrees/x/commondir': '../..',
    })
    expect(makeProjectRoot(fs)('/w/cc/.claude/worktrees/x/apps')).toBe('/w/cc')
  })

  it('不是 git 仓库的文件夹 ⇒ 它自己;相对路径 / 空 ⇒ null', () => {
    const root = makeProjectRoot(fakeFs([], {}))
    expect(root('/notes/plain')).toBe('/notes/plain')
    expect(root('relative/x')).toBeNull()
    expect(root(null)).toBeNull()
  })

  it('同一个路径只算一次', () => {
    const fs = fakeFs(['/w/cc/.git'], { '/w/cc/wt/.git': 'gitdir: /w/cc/.git/worktrees/wt', '/w/cc/.git/worktrees/wt/commondir': '../..' })
    const root = makeProjectRoot(fs)
    root('/w/cc/wt'); root('/w/cc/wt')
    expect(fs.reads).toBe(2)
  })
})
