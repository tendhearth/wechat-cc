import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { prePushProblems, recordVerified, workingTree } from './verify-stamp'

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

describe('推之前跑过 verify(scripts/verify-stamp.ts)', () => {
  let dir: string
  const push = (sha: string) => prePushProblems(dir, `refs/heads/x ${sha} refs/heads/x 0000000000000000000000000000000000000000\n`, 'base')
  const commit = (msg: string) => { sh(dir, 'add', '-A'); sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return sh(dir, 'rev-parse', 'HEAD') }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vstamp-'))
    sh(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    commit('base')
    sh(dir, 'branch', 'base')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('改了代码、没跑 verify ⇒ 拦下', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    expect(push(commit('change'))).toHaveLength(1)
  })
  it('commit 之前跑 verify(记下的是工作区那棵树)⇒ 提交后放行', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    writeFileSync(join(dir, 'new.ts'), 'export const b = 1\n') // 没跟踪的文件也算进树
    recordVerified(dir, workingTree(dir))
    expect(push(commit('change'))).toEqual([])
  })
  it('和上一次 commit 同一秒里改了、长度没变,过了一秒才算树 ⇒ 照样算进去(拷来的 index 带原来的 mtime,racy-git)', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n') // 和 base 里那份一样长
    const s = Math.floor(Date.now() / 1000)
    while (Math.floor(Date.now() / 1000) === s) { /* 等到下一秒:CI 慢机上自然会这样 */ }
    recordVerified(dir, workingTree(dir))
    expect(push(commit('change'))).toEqual([])
  })
  it('verify 之后又改了 ⇒ 拦下', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    recordVerified(dir, workingTree(dir))
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3\n')
    expect(push(commit('change'))).toHaveLength(1)
  })
  it('只改 Markdown、删分支 ⇒ 不查', () => {
    writeFileSync(join(dir, 'README.md'), '# hi\n')
    expect(push(commit('docs'))).toEqual([])
    expect(push('0000000000000000000000000000000000000000')).toEqual([])
  })
  it('算树不动真的 index', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    workingTree(dir)
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('')
  })
})
