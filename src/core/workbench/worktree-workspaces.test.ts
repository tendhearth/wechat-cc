import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { commitWorktree, copyIncludedFiles, ensureWorktree, git, mergeHint, mergeWorktree, planWorktree, removeWorktree, repoRootOf, worktreeDirty } from './worktree-workspaces'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })
const PID = 'p-0123456789abcdef0123'
function repo() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-wt-'))); dirs.push(root)
  const project = join(root, 'repo'), state = join(root, 'state')
  mkdirSync(join(project, 'pkg', 'app'), { recursive: true }); mkdirSync(state)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  writeFileSync(join(project, 'a.txt'), 'one\n'); writeFileSync(join(project, 'pkg', 'app', 'b.txt'), 'b\n')
  g('add', '-A'); g('commit', '-q', '-m', 'init')
  return { project, state }
}

describe('worktree workspaces (2026-10-07)', () => {
  it('plans, creates idempotently from HEAD (uncommitted changes stay behind), commits, and removes', () => {
    const { project, state } = repo()
    writeFileSync(join(project, 'a.txt'), 'uncommitted\n')
    const repoRoot = repoRootOf(project)!
    expect(repoRoot).toBe(project)
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'abcd1234' })
    expect(plan).toMatchObject({ branch: 'cc/abcd1234', root: join(state, 'worktrees', PID, 'abcd1234') })
    const path = ensureWorktree(plan)
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(ensureWorktree(plan)).toBe(path)
    expect(worktreeDirty(plan.root)).toBe(false)
    expect(commitWorktree(plan.root, 'nothing').committed).toBe(false)
    writeFileSync(join(path, 'new.txt'), 'hi\n')
    expect(() => removeWorktree(repoRoot, plan.root)).toThrow('worktree_dirty')
    const c = commitWorktree(plan.root, '整理周报')
    expect(c.committed).toBe(true)
    expect(git(project, ['log', '-1', '--format=%s', 'cc/abcd1234'])).toBe('整理周报')
    expect(git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    removeWorktree(repoRoot, plan.root)
    expect(existsSync(plan.root)).toBe(false)
    expect(git(project, ['rev-parse', '--verify', 'cc/abcd1234'])).toBe(c.sha)
  })
  it('a project inside a monorepo runs in the same relative folder of the worktree', () => {
    const { project, state } = repo()
    const sub = join(project, 'pkg', 'app')
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: sub, repoRoot: repoRootOf(sub)!, id: '00ff00ff' })
    const path = ensureWorktree(plan)
    expect(path).toBe(realpathSync.native(join(plan.root, 'pkg', 'app')))
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\n')
  })
  it('refuses an existing branch name, a foreign directory, bad ids, and non-git folders', () => {
    const { project, state } = repo()
    execFileSync('git', ['branch', 'cc/deadbeef'], { cwd: project })
    const repoRoot = repoRootOf(project)!
    expect(() => ensureWorktree(planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'deadbeef' }))).toThrow('worktree_branch_exists')
    const foreign = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: '11112222' })
    mkdirSync(foreign.root, { recursive: true })
    expect(() => ensureWorktree(foreign)).toThrow('worktree_conflict')
    expect(() => planWorktree({ stateDir: state, projectId: '../x', projectPath: project, repoRoot, id: 'abcd1234' })).toThrow('invalid_worktree')
    expect(() => planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: '../../x' })).toThrow('invalid_worktree')
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-plain-'))); dirs.push(plain)
    expect(repoRootOf(plain)).toBeNull()
  })
  it('merges back only by fast-forward (2026-10-08); everything else is left to the owner', () => {
    const { project, state } = repo()
    const repoRoot = repoRootOf(project)!
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'aaaa0001' })
    const path = ensureWorktree(plan)
    writeFileSync(join(path, 'new.txt'), 'hi\n')
    expect(() => mergeWorktree(repoRoot, plan.root, plan.branch)).toThrow('worktree_uncommitted')
    const c = commitWorktree(plan.root, 'add new')
    // 项目里已跟踪文件有没提交的改动 ⇒ 不动(未跟踪的不算)
    writeFileSync(join(project, 'a.txt'), 'local edit\n')
    expect(() => mergeWorktree(repoRoot, plan.root, plan.branch)).toThrow('project_dirty')
    execFileSync('git', ['checkout', '--', 'a.txt'], { cwd: project })
    writeFileSync(join(project, 'scratch.txt'), 'untracked\n')
    expect(mergeWorktree(repoRoot, plan.root, plan.branch)).toEqual({ merged: true, into: 'main' })
    expect(git(project, ['rev-parse', 'HEAD'])).toBe(c.sha)
    expect(readFileSync(join(project, 'new.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hi\n') // Windows:按主人的 autocrlf 检出
    // 再点一次:已经在里面了
    expect(mergeWorktree(repoRoot, plan.root, plan.branch)).toEqual({ merged: false, into: 'main' })
    // 项目往前走了 ⇒ 快进不了
    const other = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'aaaa0002' })
    writeFileSync(join(ensureWorktree(other), 'x.txt'), 'x\n'); commitWorktree(other.root, 'x')
    writeFileSync(join(project, 'main.txt'), 'm\n'); execFileSync('git', ['add', 'main.txt'], { cwd: project }); execFileSync('git', ['commit', '-q', '-m', 'main moved'], { cwd: project })
    expect(() => mergeWorktree(repoRoot, other.root, other.branch)).toThrow('worktree_not_ff')
    // 项目不在分支上 ⇒ 不动
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: project })
    expect(() => mergeWorktree(repoRoot, other.root, other.branch)).toThrow('project_detached')
  })
  it('a new worktree brings the ignored files .worktreeinclude lists (2026-10-08); tracked / unlisted / symlinked ones stay behind', () => {
    const { project, state } = repo()
    const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
    writeFileSync(join(project, '.gitignore'), '.env\n.env.*\nsecrets/\nbuild/\n')
    writeFileSync(join(project, '.worktreeinclude'), '.env\n.env.*\nsecrets/\nnot-ignored.txt\n')
    g('add', '.gitignore', '.worktreeinclude'); g('commit', '-q', '-m', 'ignore')
    writeFileSync(join(project, '.env'), 'KEY=1\n'); writeFileSync(join(project, '.env.local'), 'L=1\n')
    mkdirSync(join(project, 'secrets')); writeFileSync(join(project, 'secrets', 'cert.pem'), 'pem\n')
    mkdirSync(join(project, 'build')); writeFileSync(join(project, 'build', 'out.js'), 'x\n')
    writeFileSync(join(project, 'not-ignored.txt'), 'untracked but not ignored\n')
    const repoRoot = repoRootOf(project)!
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'bbbb0001' })
    const path = ensureWorktree(plan)
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('KEY=1\n')
    expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('L=1\n')
    expect(readFileSync(join(path, 'secrets', 'cert.pem'), 'utf8')).toBe('pem\n')
    expect(existsSync(join(path, 'build', 'out.js'))).toBe(false)
    expect(existsSync(join(path, 'not-ignored.txt'))).toBe(false)
    // 带进来的文件被忽略:不算没提交的改动,也不挡删除
    expect(worktreeDirty(plan.root)).toBe(false)
    removeWorktree(repoRoot, plan.root)
    expect(existsSync(plan.root)).toBe(false)
    // 没有 .worktreeinclude ⇒ 什么都不带
    const bare = repo()
    writeFileSync(join(bare.project, '.gitignore'), '.env\n'); writeFileSync(join(bare.project, '.env'), 'K\n')
    expect(copyIncludedFiles(bare.project, bare.state)).toBe(0)
  })
  it('merge hint quotes paths with spaces', () => {
    expect(mergeHint('/Users/a/My Project', 'cc/abcd1234')).toBe("cd '/Users/a/My Project' && git merge cc/abcd1234")
    expect(mergeHint('/Users/a/p', 'cc/abcd1234')).toBe('cd /Users/a/p && git merge cc/abcd1234')
  })
})
