import { preparationJobspawnFixture } from '../../test-support/preparation-jobspawn'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { baseBranchExists, validBaseBranch, commitWorktree, copyIncludedFiles, ensureWorktree, git, mergeHint, mergeWorktree, planWorktree, removeWorktree, reopenWorktree, repoRootOf, repoRootOrFail, worktreeDirty, NOT_A_REPO } from './worktree-workspaces'

preparationJobspawnFixture()

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
  it('refuses task-installed dependencies when the owner is old, including after task removal', async () => {
    const { project, state } = repo()
    git(project,['checkout','-b','new-dependencies'])
    writeFileSync(join(project,'package.json'),'{"name":"fixture","dependencies":{"tool":"1"}}')
    writeFileSync(join(project,'bun.lock'),'invalid frozen lock');writeFileSync(join(project,'.gitignore'),'node_modules/\n')
    git(project,['add','.']);git(project,['commit','-m','new dependencies']);git(project,['checkout','main'])
    const plan=(id:string)=>planWorktree({stateDir:state,projectId:PID,projectPath:project,repoRoot:project,id,base:'new-dependencies'})
    const first=plan('aa000001');await ensureWorktree(first)
    mkdirSync(join(first.root,'node_modules/tool'),{recursive:true});writeFileSync(join(first.root,'node_modules/tool/index.js'),'untrusted task')
    const second=plan('aa000002');await ensureWorktree(second)
    expect(existsSync(join(second.root,'node_modules'))).toBe(false)
    expect(readFileSync(join(first.root,'node_modules/tool/index.js'),'utf8')).toBe('untrusted task')
    expect(second.start!.notices).toContain('未能完整复用项目依赖，请在此工作区运行锁定安装；临时目录和缓存已限制在任务工作区内。')
    removeWorktree(project,first.root);removeWorktree(project,second.root)
    const third=plan('aa000003');await ensureWorktree(third)
    expect(existsSync(join(third.root,'node_modules'))).toBe(false)
  })
  it('plans, creates idempotently from HEAD (uncommitted changes stay behind), commits, and removes', async () => {
    const { project, state } = repo()
    writeFileSync(join(project, 'a.txt'), 'uncommitted\n')
    const repoRoot = repoRootOf(project)!
    expect(repoRoot).toBe(project)
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'abcd1234' })
    expect(plan).toMatchObject({ branch: 'cc/abcd1234', root: join(state, 'worktrees', PID, 'abcd1234') })
    const path = (await ensureWorktree(plan))
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('one\n')
    expect((await ensureWorktree(plan))).toBe(path)
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
  it('a project inside a monorepo runs in the same relative folder of the worktree', async () => {
    const { project, state } = repo()
    const sub = join(project, 'pkg', 'app')
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: sub, repoRoot: repoRootOf(sub)!, id: '00ff00ff' })
    const path = (await ensureWorktree(plan))
    expect(path).toBe(realpathSync.native(join(plan.root, 'pkg', 'app')))
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\n')
  })
  it('refuses an existing branch name, a foreign directory, bad ids, and non-git folders', async () => {
    const { project, state } = repo()
    execFileSync('git', ['branch', 'cc/deadbeef'], { cwd: project })
    const repoRoot = repoRootOf(project)!
    await expect(ensureWorktree(planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'deadbeef' }))).rejects.toThrow('worktree_branch_exists')
    const foreign = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: '11112222' })
    mkdirSync(foreign.root, { recursive: true })
    await expect(ensureWorktree(foreign)).rejects.toThrow('worktree_conflict')
    expect(() => planWorktree({ stateDir: state, projectId: '../x', projectPath: project, repoRoot, id: 'abcd1234' })).toThrow('invalid_worktree')
    expect(() => planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: '../../x' })).toThrow('invalid_worktree')
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-plain-'))); dirs.push(plain)
    expect(repoRootOf(plain)).toBeNull()
  })
  it('merges back only by fast-forward (2026-10-08); everything else is left to the owner', async () => {
    const { project, state } = repo()
    const repoRoot = repoRootOf(project)!
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'aaaa0001' })
    const path = (await ensureWorktree(plan))
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
    writeFileSync(join((await ensureWorktree(other)), 'x.txt'), 'x\n'); commitWorktree(other.root, 'x')
    writeFileSync(join(project, 'main.txt'), 'm\n'); execFileSync('git', ['add', 'main.txt'], { cwd: project }); execFileSync('git', ['commit', '-q', '-m', 'main moved'], { cwd: project })
    expect(() => mergeWorktree(repoRoot, other.root, other.branch)).toThrow('worktree_not_ff')
    // 项目不在分支上 ⇒ 不动
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: project })
    expect(() => mergeWorktree(repoRoot, other.root, other.branch)).toThrow('project_detached')
  })
  it('a new worktree brings the ignored files .worktreeinclude lists (2026-10-08); tracked / unlisted / symlinked ones stay behind', async () => {
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
    const path = (await ensureWorktree(plan))
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
    expect((await copyIncludedFiles(bare.project, bare.state))).toBe(0)
  })
  it('a destination parent that is a symlink out of the worktree is never written through (2026-10-08 review)', async () => {
    const { project, state } = repo()
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-outside-'))); dirs.push(outside)
    const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
    writeFileSync(join(project, '.gitignore'), '*.secret\n'); writeFileSync(join(project, '.worktreeinclude'), '*.secret\n')
    g('add', '.gitignore', '.worktreeinclude'); g('commit', '-q', '-m', 'inc')
    writeFileSync(join(project, 'top.secret'), 's\n'); mkdirSync(join(project, 'cfg')); writeFileSync(join(project, 'cfg', 'a.secret'), 'a\n')
    const repoRoot = repoRootOf(project)!
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'cccc0001' })
    execFileSync('git', ['worktree', 'add', '-q', '-b', plan.branch, plan.root, 'HEAD'], { cwd: project })
    try { symlinkSync(outside, join(plan.root, 'cfg')) } catch { return } // Windows 没权限建链接 ⇒ 跳过
    expect((await copyIncludedFiles(repoRoot, plan.root))).toBe(1)
    expect(existsSync(join(plan.root, 'top.secret'))).toBe(true)
    expect(existsSync(join(outside, 'a.secret'))).toBe(false)
  })
  it('reopens a removed worktree from its kept branch at the same place (2026-10-08)', async () => {
    const { project, state } = repo()
    const repoRoot = repoRootOf(project)!
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'dddd0001' })
    const path = (await ensureWorktree(plan))
    writeFileSync(join(path, 'work.txt'), 'w\n'); commitWorktree(plan.root, 'work')
    removeWorktree(repoRoot, plan.root)
    ;(await reopenWorktree(repoRoot, plan.root, plan.branch, plan.taskPath))
    expect(readFileSync(join(plan.root, 'work.txt'), 'utf8')).toBe('w\n')
    expect(git(plan.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(plan.branch)
    await expect(reopenWorktree(repoRoot, plan.root, plan.branch, plan.taskPath)).rejects.toThrow('worktree_conflict')
    removeWorktree(repoRoot, plan.root); execFileSync('git', ['branch', '-D', plan.branch], { cwd: project, stdio: 'pipe' })
    await expect(reopenWorktree(repoRoot, plan.root, plan.branch, plan.taskPath)).rejects.toThrow('worktree_branch_missing')
  })
  it('starts from a named local branch when asked (2026-10-08); bad names never reach git', async () => {
    const { project, state } = repo()
    const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
    g('checkout', '-q', '-b', 'feature/login'); writeFileSync(join(project, 'login.txt'), 'l\n'); g('add', 'login.txt'); g('commit', '-q', '-m', 'login'); g('checkout', '-q', 'main')
    const repoRoot = repoRootOf(project)!
    expect(baseBranchExists(repoRoot, 'feature/login')).toBe(true)
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'eeee0001', base: 'feature/login' })
    const path = (await ensureWorktree(plan))
    expect(readFileSync(join(path, 'login.txt'), 'utf8')).toBe('l\n')
    expect(git(project, ['rev-parse', 'HEAD'])).not.toBe(git(path, ['rev-parse', 'HEAD']))
    await expect(ensureWorktree(planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'eeee0002', base: 'nope' }))).rejects.toThrow('worktree_base_missing')
    for (const bad of ['-x', '../x', 'a..b', '/abs', 'a/', 'x.lock', 'a b', 'a//b', '', 'x~1', 'a@{0}'])
      expect(validBaseBranch(bad), bad).toBe(false)
    expect(() => planWorktree({ stateDir: state, projectId: PID, projectPath: project, repoRoot, id: 'eeee0003', base: '--upload-pack=x' })).toThrow('invalid_worktree')
  })
  it('a project folder missing on the branch leaves nothing behind, so a retry is not stuck (2026-10-10)', async () => {
    const { project, state } = repo()
    const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
    g('checkout', '-q', '-b', 'no-app'); g('rm', '-rq', 'pkg'); g('commit', '-q', '-m', 'drop app'); g('checkout', '-q', 'main')
    const sub = join(project, 'pkg', 'app'), repoRoot = repoRootOf(sub)!
    // 新建:基线分支上没有这个子项目 ⇒ 不留工作区目录、不留分支
    const fresh = planWorktree({ stateDir: state, projectId: PID, projectPath: sub, repoRoot, id: 'ffff0001', base: 'no-app' })
    await expect(ensureWorktree(fresh)).rejects.toThrow('worktree_project_missing')
    expect(existsSync(fresh.root)).toBe(false)
    expect(() => git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${fresh.branch}`])).toThrow()
    expect(git(project, ['worktree', 'list', '--porcelain'])).not.toContain(fresh.root)
    // 重新打开:分支上把子项目删了 ⇒ 撤回检出、分支照旧保留;再试一次还是同一个错,不会变成 worktree_conflict
    const plan = planWorktree({ stateDir: state, projectId: PID, projectPath: sub, repoRoot, id: 'ffff0002' })
    const path = (await ensureWorktree(plan))
    execFileSync('git', ['rm', '-rq', '.'], { cwd: path, stdio: 'pipe' }); commitWorktree(plan.root, 'drop')
    removeWorktree(repoRoot, plan.root)
    await expect(reopenWorktree(repoRoot, plan.root, plan.branch, path)).rejects.toThrow('worktree_project_missing')
    expect(existsSync(plan.root)).toBe(false)
    await expect(reopenWorktree(repoRoot, plan.root, plan.branch, path)).rejects.toThrow('worktree_project_missing')
    expect(git(project, ['rev-parse', '--verify', plan.branch])).toMatch(/^[0-9a-f]{40}$/)
  })
  it('merge hint quotes paths with spaces', () => {
    expect(mergeHint('/Users/a/My Project', 'cc/abcd1234')).toBe("cd '/Users/a/My Project' && git merge cc/abcd1234")
    expect(mergeHint('/Users/a/p', 'cc/abcd1234')).toBe('cd /Users/a/p && git merge cc/abcd1234')
  })
})

describe('repoRootOrFail(10-21:机器忙时 git 没问成 ≠ 不是仓库)', () => {
  it('a repo ⇒ its root; a plain folder or a missing path ⇒ null (same answers as repoRootOf)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rrof-')))
    try {
      const repo = join(root, 'repo'), plain = join(root, 'plain'); mkdirSync(repo); mkdirSync(plain)
      execFileSync('git', ['init', '-q'], { cwd: repo })
      expect(repoRootOrFail(repo)).toBe(repoRootOf(repo))
      expect(repoRootOrFail(plain)).toBeNull()
      expect(repoRootOrFail(join(root, 'gone'))).toBeNull()
    } finally { removeTempDir(root) }
  })
  it.skipIf(process.platform === 'win32')('git could not be asked at all (not exit 128: here, git missing from PATH) ⇒ throws worktree_git_failed instead of claiming "not a repo"; repoRootOf still says null (the permission gate stays fail-closed)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rrof-')))
    const path = process.env.PATH
    try {
      process.env.PATH = join(root, 'no-bin')
      expect(() => repoRootOrFail(root)).toThrow('worktree_git_failed')
      expect(repoRootOf(root)).toBeNull()
    } finally { process.env.PATH = path; removeTempDir(root) }
  })
})

describe('repoRootOrFail 只在 git 真说了「不是仓库」时才回 null(10-22)', () => {
  it('只认 git 说「不是仓库」那一句;dubious ownership、index.lock 之类都不算', () => {
    expect(NOT_A_REPO.test('fatal: not a git repository (or any of the parent directories): .git')).toBe(true)
    // 是仓库、只是 git 不信任这个目录 ⇒ 不说成「不是 Git 仓库」(#537 评审)
    expect(NOT_A_REPO.test("fatal: detected dubious ownership in repository at '/x'")).toBe(false)
    expect(NOT_A_REPO.test('fatal: Unable to create \'/x/.git/index.lock\': File exists.')).toBe(false)
    expect(NOT_A_REPO.test('')).toBe(false)
  })
})

describe('fresh task starts and dependency clones',()=>{
  function remoteRepo() {
    const local=repo(), remote=repo()
    execFileSync('git',['remote','add','origin',remote.project],{cwd:local.project})
    execFileSync('git',['fetch','origin'],{cwd:local.project,stdio:'pipe'})
    execFileSync('git',['branch','--set-upstream-to=origin/main','main'],{cwd:local.project,stdio:'pipe'})
    // Both initial trees/commits may be identical. Freeze local at the fetched remote baseline.
    execFileSync('git',['reset','--hard','origin/main'],{cwd:local.project,stdio:'pipe'})
    const initial=git(local.project,['rev-parse','HEAD'])
    writeFileSync(join(remote.project,'remote.txt'),'new remote code')
    execFileSync('git',['add','remote.txt'],{cwd:remote.project})
    execFileSync('git',['commit','-qm','remote moved'],{cwd:remote.project})
    return {...local,remote:remote.project,initial,latest:git(remote.project,['rev-parse','HEAD'])}
  }
  it.each(['main','origin/main'])('fetches before starting from %s, freezes the newest SHA, and never moves the source branch',async base=>{
    const r=remoteRepo()
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab001',base})
    const path=(await ensureWorktree(plan))
    expect(git(path,['rev-parse','HEAD'])).toBe(r.latest)
    expect(git(r.project,['rev-parse','main'])).toBe(r.initial)
    expect(plan.start).toMatchObject({base,sha:r.latest,notices:[]})
    expect(readFileSync(join(path,'remote.txt'),'utf8')).toBe('new remote code')
    writeFileSync(join(path,'task.txt'),'task commit');commitWorktree(path,'task moved')
    const retry=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab001',base})
    ;(await ensureWorktree(retry))
    expect(retry.start).toEqual(plan.start)
    expect(git(path,['rev-parse','HEAD'])).not.toBe(r.latest)
  })
  it('failed fetch is non-blocking and the task keeps a safe notice',async ()=>{
    const r=remoteRepo()
    execFileSync('git',['remote','set-url','origin',join(r.state,'unavailable-remote')],{cwd:r.project})
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab002',base:'main'})
    expect(git((await ensureWorktree(plan)),['rev-parse','HEAD'])).toBe(r.initial)
    expect(plan.start?.notices).toEqual(['获取远端更新失败或超时，使用本机已有提交；起点可能不是最新版本。'])
  })
  it('a diverged local branch keeps its local commits',async ()=>{
    const r=remoteRepo()
    writeFileSync(join(r.project,'local.txt'),'local')
    execFileSync('git',['add','local.txt'],{cwd:r.project});execFileSync('git',['commit','-qm','local commit'],{cwd:r.project})
    const local=git(r.project,['rev-parse','HEAD'])
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab003',base:'main'})
    expect(git((await ensureWorktree(plan)),['rev-parse','HEAD'])).toBe(local)
  })
  function dependencies(){
    const r=repo()
    writeFileSync(join(r.project,'.gitignore'),'node_modules/\n')
    writeFileSync(join(r.project,'.worktreeinclude'),'node_modules/\n')
    writeFileSync(join(r.project,'package.json'),'{"name":"fixture","private":true}')
    writeFileSync(join(r.project,'bun.lock'),'locked')
    const g=(...args:string[])=>execFileSync('git',args,{cwd:r.project,stdio:'pipe'})
    g('add','-A');g('commit','-qm','dependencies')
    const modules=join(r.project,'node_modules'),pkg=join(modules,'.bun','tool','node_modules','tool')
    mkdirSync(pkg,{recursive:true});mkdirSync(join(modules,'.bin'))
    writeFileSync(join(pkg,'cli.js'),'original')
    for(let i=0;i<1001;i++)writeFileSync(join(pkg,`file-${i}`),'fixture')
    symlinkSync('.bun/tool/node_modules/tool',join(modules,'tool'),'dir')
    symlinkSync('../tool/cli.js',join(modules,'.bin','tool'),'file')
    symlinkSync(join(r.project,'pkg','app'),join(modules,'workspace'),'dir')
    return {...r,modules,pkg,g}
  }
  it('clones a complete Bun dependency tree beyond include limits, relocates links and isolates all writes',async ()=>{
    const r=dependencies()
    mkdirSync(join(r.modules,'.cache/cc-tasks/other'),{recursive:true})
    writeFileSync(join(r.modules,'.cache/cc-tasks/other/private.txt'),'other task scratch')
    writeFileSync(join(r.project,'pkg/app/package.json'),'{"name":"child","private":true}')
    mkdirSync(join(r.project,'pkg/app/node_modules'))
    symlinkSync(join(r.pkg),join(r.project,'pkg/app/node_modules/tool'),'dir')
    r.g('add','pkg/app/package.json');r.g('commit','-qm','child workspace')
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab004'})
    const path=(await ensureWorktree(plan))
    const cli=join(path,'node_modules/.bin/tool')
    expect(readFileSync(cli,'utf8')).toBe('original')
    expect(readFileSync(join(path,'pkg/app/node_modules/tool/cli.js'),'utf8')).toBe('original')
    expect(existsSync(join(path,'node_modules/.cache'))).toBe(false)
    expect(readFileSync(join(path,'node_modules/tool/file-1000'),'utf8')).toBe('fixture')
    expect(realpathSync(join(path,'node_modules/workspace'))).toBe(join(path,'pkg/app'))
    expect(statSync(cli).ino).not.toBe(statSync(join(r.pkg,'cli.js')).ino)
    writeFileSync(cli,'task edit')
    expect(readFileSync(join(r.pkg,'cli.js'),'utf8')).toBe('original')
    expect(worktreeDirty(path)).toBe(false)
    removeWorktree(r.project,path);(await reopenWorktree(r.project,path,plan.branch,path))
    expect(readFileSync(cli,'utf8')).toBe('original')
  })
  it('rejects source-external links atomically and reports missing dependencies instead of sharing them',async ()=>{
    const r=dependencies()
    symlinkSync(r.state,join(r.modules,'external'),'dir')
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab005'})
    const path=(await ensureWorktree(plan))
    expect(existsSync(join(path,'node_modules'))).toBe(false)
    expect(plan.start?.notices.join('')).toContain('未能完整复用项目依赖')
  })
  it('does not reuse dependencies when source and selected branch lockfiles differ',async ()=>{
    const r=dependencies()
    writeFileSync(join(r.project,'bun.lock'),'not committed')
    const plan=planWorktree({stateDir:r.state,projectId:PID,projectPath:r.project,repoRoot:r.project,id:'aaaab006'})
    const path=(await ensureWorktree(plan))
    expect(existsSync(join(path,'node_modules'))).toBe(false)
    expect(plan.start?.notices.join('')).toContain('未能完整复用项目依赖')
  })
})
