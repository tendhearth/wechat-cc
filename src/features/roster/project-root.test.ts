import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug, makeProjectRoot, SCRATCH_PREFIX, type RootFs } from './project-root'

function fakeFs(dirs: string[], files: Record<string, string>, extra: string[] = []): RootFs & { reads: number } {
  const all = [...dirs, ...Object.keys(files), ...extra]
  const f = {
    reads: 0,
    realpath: (p: string) => p,
    exists: (p: string) => all.some(x => x === p || x.startsWith(p + '/') || p.startsWith(x.replace(/\/\.git$/, '') + '/') || p === x.replace(/\/\.git$/, '')),
    isDir: (p: string) => dirs.includes(p),
    isFile: (p: string) => p in files,
    read: (p: string) => { f.reads++; return files[p]! },
  }
  return f
}
const HOME = '/Users/me'

describe('makeProjectRoot', () => {
  it('主仓库里的子目录 ⇒ 仓库根', () => {
    const root = makeProjectRoot({ fs: fakeFs(['/w/rici/.git'], {}, ['/w/rici/src/import']), home: HOME, path: posix })
    expect(root('/w/rici/src/import')).toBe('/w/rici')
  })

  it('链出去的工作区(.git 是文件) ⇒ 认回主仓库', () => {
    const fs = fakeFs(['/w/cc/.git'], {
      '/w/cc/.claude/worktrees/x/.git': 'gitdir: /w/cc/.git/worktrees/x',
      '/w/cc/.git/worktrees/x/commondir': '../..',
    }, ['/w/cc/.claude/worktrees/x/apps'])
    expect(makeProjectRoot({ fs, home: HOME, path: posix })('/w/cc/.claude/worktrees/x/apps')).toBe('/w/cc')
  })

  it('不是 git 仓库:取 ~/Documents 下第一层;主目录本身 / 根目录不算', () => {
    const root = makeProjectRoot({ fs: fakeFs([], {}, [`${HOME}/Documents/compassX/out/exp1`, `${HOME}/notes`]), home: HOME, path: posix })
    expect(root(`${HOME}/Documents/compassX/out/exp1`)).toBe(`${HOME}/Documents/compassX`)
    expect(root(`${HOME}/notes`)).toBe(`${HOME}/notes`)
    expect(root(HOME)).toBeNull()
    expect(root('/')).toBeNull()
  })

  it('路径已经不在(删掉的工作区) ⇒ 不算', () => {
    expect(makeProjectRoot({ fs: fakeFs([], {}), home: HOME, path: posix })(`${HOME}/Documents/tendhearth/wt-gone`)).toBeNull()
  })

  it('Claude Code 的临时目录 ⇒ 带编码的标记;别的临时目录不算', () => {
    const root = makeProjectRoot({ fs: fakeFs([], {}), home: HOME, path: posix })
    expect(root('/private/tmp/claude-501/-Users-me-Documents-1in8b/abc/scratchpad/oce')).toBe(`${SCRATCH_PREFIX}-Users-me-Documents-1in8b`)
    expect(root('/private/tmp/tmp.hNQwzCfDf8')).toBeNull()
    expect(root('/var/folders/x/y')).toBeNull()
    expect(claudeProjectSlug('/Users/me/Documents/1in8b')).toBe('-Users-me-Documents-1in8b')
    expect(claudeProjectSlug('/Users/nategu_mac_company/Documents/claude_杂事')).toBe('-Users-nategu-mac-company-Documents-claude---')
  })

  it('相对路径 / 空 ⇒ null;同一个路径只算一次', () => {
    const fs = fakeFs(['/w/cc/.git'], { '/w/cc/wt/.git': 'gitdir: /w/cc/.git/worktrees/wt', '/w/cc/.git/worktrees/wt/commondir': '../..' })
    const root = makeProjectRoot({ fs, home: HOME, path: posix })
    expect(root('relative/x')).toBeNull()
    expect(root(null)).toBeNull()
    root('/w/cc/wt'); root('/w/cc/wt')
    expect(fs.reads).toBe(2)
  })
})
