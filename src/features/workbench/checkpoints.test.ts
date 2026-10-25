import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, existsSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { branchExists, CHECKPOINT_DEADLINE_MS, clearTendhearthRefs, deleteCheckpointRefs, listTendhearthRefs, pruneCheckpoints, takeCheckpoint, type GitExec } from './checkpoints'
import { parseGitReviewSnapshot } from './review'
import { removeTempDir } from '../../lib/test-temp'

let root: string, stateDir: string, marker: string
const win = process.platform === 'win32'
/** 临时 index 一个都不剩(叫停得早时 tmp 目录可能还没建)。 */
const leftovers = () => existsSync(join(stateDir, 'tmp')) ? readdirSync(join(stateDir, 'tmp')) : []
function git(...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function file(name: string, text: string | Buffer) { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text) }
/** checkpoint 树里的条目:path → [mode, blob 内容]。 */
function treeOf(commit: string) {
  const out = new Map<string, { mode: string; text: string }>()
  for (const row of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
    const [meta, path] = row.split('\t') as [string, string]
    const [mode, , oid] = meta.split(' ') as [string, string, string]
    out.set(path, { mode, text: git('cat-file', '-p', oid) })
  }
  return out
}
async function ok(prev?: string) {
  const result = await takeCheckpoint({ root, taskId: 'abcd1234', stateDir, ...(prev ? { prev } : {}) })
  if ('skipped' in result) throw new Error(`skipped ${result.skipped}`)
  return result
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-cp-')); stateDir = mkdtempSync(join(tmpdir(), 'cc-cp-state-')); marker = join(stateDir, 'marker')
  git('init', '-q'); git('config', 'user.email', 'test@localhost'); git('config', 'user.name', 'Test')
  file('app.ts', 'one\n'); file('gone.txt', 'bye\n'); file('tool.sh', 'echo\n'); git('add', '.'); git('commit', '-qm', 'base')
})
afterEach(() => { removeTempDir(root); removeTempDir(stateDir) })

it('captures the whole working tree without touching HEAD, index or the working tree', async () => {
  file('app.ts', 'two\n'); file('new/added.md', 'hi\n'); rmSync(join(root, 'gone.txt')); file('pic.bin', Buffer.from([0, 1, 2, 255]))
  if (!win) chmodSync(join(root, 'tool.sh'), 0o755)
  const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain'), index = readFileSync(join(root, '.git/index'))
  const cp = await ok()
  const tree = treeOf(cp.commit)
  expect(tree.get('app.ts')?.text).toBe('two'); expect(tree.get('new/added.md')?.text).toBe('hi'); expect(tree.has('gone.txt')).toBe(false)
  expect(tree.has('pic.bin')).toBe(true)
  if (!win) expect(tree.get('tool.sh')?.mode).toBe('100755')
  expect(git('rev-parse', `${cp.commit}^`)).toBe(head)
  expect(git('log', '-1', '--format=%an <%ae>', cp.commit)).toBe('Tendhearth CC <cc@localhost>')
  expect(git('for-each-ref', '--format=%(objectname)', 'refs/tendhearth/checkpoints/abcd1234/')).toBe(cp.commit)
  expect(git('rev-parse', 'HEAD')).toBe(head); expect(readFileSync(join(root, '.git/index'))).toEqual(index); expect(git('status', '--porcelain')).toBe(status)
  // 临时 index 用完就删
  expect(readdirSync(join(stateDir, 'tmp'))).toEqual([])
})

it.skipIf(win)('records symlinks as links', async () => {
  symlinkSync('app.ts', join(root, 'link.ts'))
  expect(treeOf((await ok()).commit).get('link.ts')).toEqual({ mode: '120000', text: 'app.ts' })
})

it('leaves out ignored files and task output folders', async () => {
  file('.gitignore', 'secret.env\nbuild/\n'); file('secret.env', 'x'); file('build/out.js', 'x')
  file('.cc-workbench/report.md', 'r'); file('pkg/.cc-workbench-inputs/a.png', 'i'); file('pkg/keep.ts', 'k')
  const paths = [...treeOf((await ok()).commit).keys()]
  expect(paths).toContain('pkg/keep.ts'); expect(paths).toContain('.gitignore')
  expect(paths.filter(p => /secret|build|cc-workbench/.test(p))).toEqual([])
})

it('never runs hooks and ignores commit.gpgSign', async () => {
  const hooks = join(root, '.git/hooks')
  const script = `#!/bin/sh\necho ran >> "${marker.replace(/\\/g, '/')}"\n`
  for (const name of ['pre-commit', 'post-checkout', 'reference-transaction', 'post-index-change']) { writeFileSync(join(hooks, name), script); chmodSync(join(hooks, name), 0o755) }
  git('config', 'commit.gpgSign', 'true'); git('config', 'gpg.program', join(stateDir, 'no-such-gpg'))
  file('data.dat', 'payload\n')
  const cp = await ok()
  expect(treeOf(cp.commit).get('data.dat')?.text).toBe('payload')
  expect(existsSync(marker)).toBe(false)
})

it('skips repos that use filters (LFS, required, any filter= attribute) and never runs them', async () => {
  const skip = () => takeCheckpoint({ root, taskId: 'abcd1234', stateDir })
  // 只配了过滤器、没有属性引用它 ⇒ 照打,也不会跑
  git('config', 'filter.x.clean', `sh -c 'echo ran >> "${marker.replace(/\\/g, '/')}"; cat'`)
  file('# comment.txt', 'c'); file('.gitattributes', '# *.dat filter=x\n*.txt -filter\n'); file('data.dat', 'payload\n')
  expect(await skip()).toHaveProperty('commit')
  file('.gitattributes', '*.dat filter=x\n')
  expect(await skip()).toEqual({ skipped: 'filter_repo' })
  rmSync(join(root, '.gitattributes')); file('sub/.gitattributes', 'a.bin  text filter=x\n')
  expect(await skip()).toEqual({ skipped: 'filter_repo' })
  rmSync(join(root, 'sub/.gitattributes')); file('.git/info/attributes', '*.dat filter=x\n')
  expect(await skip()).toEqual({ skipped: 'filter_repo' })
  rmSync(join(root, '.git/info/attributes')); expect(await skip()).toHaveProperty('commit')
  git('config', 'filter.y.required', 'true'); expect(await skip()).toEqual({ skipped: 'filter_repo' })
  git('config', '--unset', 'filter.y.required'); git('config', 'filter.lfs.process', 'git-lfs filter-process')
  expect(await skip()).toEqual({ skipped: 'filter_repo' })
  expect(existsSync(marker)).toBe(false)
})

it('skips with a reason when the change set is too big', async () => {
  file('big.bin', Buffer.alloc(2048)); file('a.txt', 'a'); file('b.txt', 'b')
  const run = (limits: object) => takeCheckpoint({ root, taskId: 'abcd1234', stateDir, limits })
  expect(await run({ maxFileBytes: 1024 })).toEqual({ skipped: 'file_too_large' })
  expect(await run({ maxTotalBytes: 1024 })).toEqual({ skipped: 'too_large' })
  expect(await run({ maxPaths: 2 })).toEqual({ skipped: 'too_many_paths' })
  expect(git('for-each-ref', 'refs/tendhearth/')).toBe('')
})

it('checkpoints the whole repository even when given a subdirectory', async () => {
  file('pkg/inner.ts', 'x'); git('add', '.'); git('commit', '-qm', 'pkg')
  file('app.ts', 'outside\n'); file('pkg/inner.ts', 'y')
  const result = await takeCheckpoint({ root: join(root, 'pkg'), taskId: 'abcd1234', stateDir })
  if ('skipped' in result) throw new Error(result.skipped)
  const tree = treeOf(result.commit)
  expect(tree.get('app.ts')?.text).toBe('outside'); expect(tree.get('pkg/inner.ts')?.text).toBe('y')
})

it('sees same-size rewrites the real index would call racy (copied index must not look newer)', async () => {
  // 文件与真 index 同一秒(git 自己会重新哈希);拷贝若带着「现在」的 mtime,这次改写就被当成没动
  const t = Math.floor(Date.now() / 1000) - 5
  file('racy.txt', 'p'); utimesSync(join(root, 'racy.txt'), t, t); git('add', '-A'); git('commit', '-qm', 'p')
  file('racy.txt', 'q'); utimesSync(join(root, 'racy.txt'), t, t); utimesSync(join(root, '.git/index'), t, t)
  expect(treeOf((await ok()).commit).get('racy.txt')?.text).toBe('q')
})

it('reuses the previous checkpoint when nothing changed, and notices a moved HEAD', async () => {
  const first = await ok()
  const again = await ok(first.commit)
  expect(again).toEqual({ commit: first.commit, tree: first.tree, sameTree: true })
  file('app.ts', 'changed\n')
  const third = await ok(first.commit)
  expect(third.commit).not.toBe(first.commit); expect(third.sameTree).toBe(false)
  git('add', '-A'); git('commit', '-qm', 'agent')
  const fourth = await ok(third.commit)
  expect(fourth.sameTree).toBe(true); expect(fourth.commit).not.toBe(third.commit); expect(git('rev-parse', `${fourth.commit}^`)).toBe(git('rev-parse', 'HEAD'))
})

it('works on an unborn branch (no parent)', async () => {
  removeTempDir(root); root = mkdtempSync(join(tmpdir(), 'cc-cp-')); git('init', '-q'); file('first.ts', 'x')
  const cp = await ok()
  expect(treeOf(cp.commit).get('first.ts')?.text).toBe('x')
  expect(git('cat-file', '-p', cp.commit)).not.toMatch(/^parent /m)
})

it('returns skipped instead of throwing when git cannot do it', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'cc-cp-plain-'))
  try {
    expect(await takeCheckpoint({ root: plain, taskId: 'abcd1234', stateDir })).toEqual({ skipped: 'not_git' })
    expect(await takeCheckpoint({ root: join(plain, 'missing'), taskId: 'abcd1234', stateDir })).toHaveProperty('skipped')
  } finally { removeTempDir(plain) }
  expect(await takeCheckpoint({ root, taskId: '../evil', stateDir })).toEqual({ skipped: 'invalid_task' })
  // 对象库坏了 ⇒ git_error,不抛
  rmSync(join(root, '.git/objects'), { recursive: true, force: true }); mkdirSync(join(root, '.git/objects'))
  file('app.ts', 'z')
  expect(await takeCheckpoint({ root, taskId: 'abcd1234', stateDir })).toEqual({ skipped: 'git_error' })
  expect(leftovers()).toEqual([])
  const aborted = new AbortController(); aborted.abort()
  expect(await takeCheckpoint({ root, taskId: 'abcd1234', stateDir, signal: aborted.signal })).toEqual({ skipped: 'aborted' })
})

it('deleteCheckpointRefs removes only that task\'s refs', async () => {
  const mine = await ok()
  const other = await takeCheckpoint({ root, taskId: 'abcd12345', stateDir }); if ('skipped' in other) throw new Error('x')
  git('update-ref', 'refs/tendhearth/rewind/abcd1234/1', mine.commit); git('update-ref', 'refs/tendhearth/rewind/ffff0000/1', mine.commit)
  expect(await deleteCheckpointRefs(root, 'abcd1234')).toBe(2)
  expect(git('for-each-ref', '--format=%(refname)', 'refs/tendhearth/').split('\n').sort()).toEqual([`refs/tendhearth/checkpoints/abcd12345/${other.commit.slice(0, 12)}`, 'refs/tendhearth/rewind/ffff0000/1'])
  expect(await deleteCheckpointRefs(root, 'abcd1234')).toBe(0)
  expect(await deleteCheckpointRefs(join(root, 'missing'), 'abcd1234')).toBe(0)
})

it('parseGitReviewSnapshot keeps valid checkpoint ids and drops anything else', () => {
  const base = { version: 1, scope: 'working-tree-before-after', status: 'complete', files: [] }
  const a = 'a'.repeat(40), b = 'b'.repeat(64)
  expect(parseGitReviewSnapshot(Buffer.from(JSON.stringify({ ...base, checkpointBefore: a, checkpointAfter: b })))).toMatchObject({ checkpointBefore: a, checkpointAfter: b })
  const bad = parseGitReviewSnapshot(Buffer.from(JSON.stringify({ ...base, checkpointBefore: 'HEAD', checkpointAfter: 'A'.repeat(40) })))!
  expect('checkpointBefore' in bad).toBe(false); expect('checkpointAfter' in bad).toBe(false)
  expect('checkpointBefore' in parseGitReviewSnapshot(Buffer.from(JSON.stringify({ ...base, checkpointBefore: 'a'.repeat(50) })))!).toBe(false)
})

describe('the owner\'s global ignore rules still apply (review #428)', () => {
  let home: string, saved: { HOME?: string; XDG_CONFIG_HOME?: string }
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-cp-home-')); saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }; process.env.HOME = home; delete process.env.XDG_CONFIG_HOME })
  afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } removeTempDir(home) })
  it('core.excludesFile from ~/.gitconfig (with ~ expanded)', async () => {
    writeFileSync(join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/my-ignore\n'); writeFileSync(join(home, 'my-ignore'), '*.secret\nnode_modules/\n')
    file('a.secret', 'k'); file('keep.txt', 'k'); file('node_modules/x/.gitattributes', '* filter=lfs\n'); file('node_modules/x/i.js', 'x')
    const paths = [...treeOf((await ok()).commit).keys()]
    expect(paths).toContain('keep.txt'); expect(paths.filter(p => /secret|node_modules/.test(p))).toEqual([])
  })
  it('git\'s default ~/.config/git/ignore when nothing is configured, and $XDG_CONFIG_HOME', async () => {
    mkdirSync(join(home, '.config/git'), { recursive: true }); writeFileSync(join(home, '.config/git/ignore'), '*.secret\n')
    file('a.secret', 'k'); file('b.xdg', 'x')
    expect(treeOf((await ok()).commit).has('a.secret')).toBe(false)
    const xdg = join(home, 'xdg'); mkdirSync(join(xdg, 'git'), { recursive: true }); writeFileSync(join(xdg, 'git/ignore'), '*.xdg\n'); process.env.XDG_CONFIG_HOME = xdg
    const tree = treeOf((await ok()).commit)
    expect(tree.has('b.xdg')).toBe(false); expect(tree.has('a.secret')).toBe(true)
  })
  it('a repo-local core.excludesFile wins over the global one', async () => {
    writeFileSync(join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/my-ignore\n'); writeFileSync(join(home, 'my-ignore'), '*.secret\n')
    writeFileSync(join(stateDir, 'local-ignore'), '*.local\n'); git('config', 'core.excludesFile', join(stateDir, 'local-ignore'))
    file('a.secret', 'k'); file('b.local', 'l')
    const tree = treeOf((await ok()).commit)
    expect(tree.has('b.local')).toBe(false); expect(tree.has('a.secret')).toBe(true)
  })
})

describe('one overall deadline; the caller can stop it (review #428)', () => {
  const run = promisify(execFile)
  const real: GitExec = async (args, opts) => Buffer.from((await run('git', args, { cwd: opts.cwd, env: opts.env, encoding: 'buffer', maxBuffer: opts.maxBuffer, ...(opts.signal ? { signal: opts.signal } : {}) })).stdout)
  /** add 永远不回,只认 abort(同真 execFile:abort ⇒ 杀掉、reject)。 */
  const stuckAdd: GitExec = (args, opts) => args.includes('add') ? new Promise((_, fail) => opts.signal?.addEventListener('abort', () => fail(new Error('killed')), { once: true })) : real(args, opts)
  it('exports a 15 s budget', () => { expect(CHECKPOINT_DEADLINE_MS).toBe(15_000) })
  it('times out within the deadline and cleans up', async () => {
    file('app.ts', 'slow\n')
    const started = Date.now()
    expect(await takeCheckpoint({ root, taskId: 'abcd1234', stateDir, exec: stuckAdd, deadlineMs: 400 })).toEqual({ skipped: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(leftovers()).toEqual([]); expect(git('for-each-ref', 'refs/tendhearth/')).toBe('')
  })
  it('stops promptly when the caller aborts', async () => {
    file('app.ts', 'slow\n')
    const stop = new AbortController(), started = Date.now()
    setTimeout(() => stop.abort(), 100)
    expect(await takeCheckpoint({ root, taskId: 'abcd1234', stateDir, exec: stuckAdd, signal: stop.signal })).toEqual({ skipped: 'aborted' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(leftovers()).toEqual([])
  })
})

describe('inside a real linked worktree (production shape)', () => {
  let main: string
  beforeEach(() => {
    main = root; root = join(stateDir, 'wt'); execFileSync('git', ['worktree', 'add', '-q', '-b', 'cc/abcd1234', root], { cwd: main, stdio: 'pipe' })
  })
  afterEach(() => { root = main })
  it('captures the worktree, not the main checkout, and leaves both indexes alone', async () => {
    file('app.ts', 'in worktree\n'); file('new.md', 'n'); rmSync(join(root, 'gone.txt'))
    writeFileSync(join(main, 'main-only.txt'), 'm')
    const indexes = [resolve(root, git('rev-parse', '--git-path', 'index')), join(main, '.git/index')].map(p => readFileSync(p))
    const cp = await ok()
    const tree = treeOf(cp.commit)
    expect(tree.get('app.ts')?.text).toBe('in worktree'); expect(tree.has('new.md')).toBe(true); expect(tree.has('gone.txt')).toBe(false); expect(tree.has('main-only.txt')).toBe(false)
    expect(git('rev-parse', `${cp.commit}^`)).toBe(git('rev-parse', 'HEAD'))
    // ref 在公共目录:主仓库看得见
    expect(execFileSync('git', ['for-each-ref', '--format=%(objectname)', 'refs/tendhearth/checkpoints/abcd1234/'], { cwd: main, encoding: 'utf8' }).trim()).toBe(cp.commit)
    const after = [resolve(root, git('rev-parse', '--git-path', 'index')), join(main, '.git/index')].map(p => readFileSync(p))
    expect(after).toEqual(indexes)
  })
  it('excludes ignored files and task output folders; runs no hooks', async () => {
    const hooks = join(main, '.git/hooks'), script = `#!/bin/sh\necho ran >> "${marker.replace(/\\/g, '/')}"\n`
    for (const name of ['pre-commit', 'post-checkout', 'reference-transaction', 'post-index-change']) { writeFileSync(join(hooks, name), script); chmodSync(join(hooks, name), 0o755) }
    file('.gitignore', 'secret.env\n'); file('secret.env', 'x'); file('.cc-workbench/r.md', 'r'); file('keep.ts', 'k')
    const paths = [...treeOf((await ok()).commit).keys()]
    expect(paths).toContain('keep.ts'); expect(paths.filter(p => /secret|cc-workbench/.test(p))).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })
  it('seeds the temp index from the worktree\'s own index (--git-path)', async () => {
    // 只有工作区自己的 index 带 skip-worktree:拿它当种子 ⇒ add -A 不碰这个文件、树里还是旧内容;
    // 拿错(主仓库 index / read-tree HEAD)就会是新内容。这也是已知限制:稀疏 / skip-worktree 的文件按 index 记。
    git('update-index', '--skip-worktree', 'app.ts'); file('app.ts', 'edited\n')
    expect(treeOf((await ok()).commit).get('app.ts')?.text).toBe('one')
  })
})

describe('ref 的去留(回退切片 2)', () => {
  it('pruneCheckpoints keeps only the newest N; list / clear report and remove refs/tendhearth/*', async () => {
    const made: string[] = []
    for (let i = 0; i < 4; i++) {
      file('app.ts', `v${i}\n`)
      const r = await ok()
      made.push(r.commit)
    }
    const listing = await listTendhearthRefs(root)
    expect(listing?.count).toBe(4); expect(listing?.oldest).toBeGreaterThan(0)
    expect(await pruneCheckpoints(root, 'abcd1234', 10)).toBe(0)
    expect(await pruneCheckpoints(root, 'abcd1234', 2)).toBe(2)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/tendhearth/checkpoints/abcd1234/').split('\n')).toHaveLength(2)
    git('update-ref', 'refs/tendhearth/rewind/abcd1234/1', made[0]!)
    expect(await clearTendhearthRefs(root)).toBe(3)
    expect(await listTendhearthRefs(root)).toEqual({ count: 0, oldest: null })
  })
  it('branchExists: true / false / null (not a repo)', async () => {
    const branch = git('symbolic-ref', '--short', 'HEAD')
    expect(await branchExists(root, branch)).toBe(true)
    expect(await branchExists(root, 'cc/nope0000')).toBe(false)
    expect(await branchExists(join(stateDir, 'nowhere'), branch)).toBeNull()
  })
})
