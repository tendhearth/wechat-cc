import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteCheckpointRefs, takeCheckpoint } from './checkpoints'
import { parseGitReviewSnapshot } from './review'
import { removeTempDir } from '../../lib/test-temp'

let root: string, stateDir: string, marker: string
const win = process.platform === 'win32'
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
  expect(existsSync(join(stateDir, 'tmp')) ? readdirSync(join(stateDir, 'tmp')) : []).toEqual([])
  const aborted = new AbortController(); aborted.abort()
  expect(await takeCheckpoint({ root, taskId: 'abcd1234', stateDir, signal: aborted.signal })).toEqual({ skipped: 'cancelled' })
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
