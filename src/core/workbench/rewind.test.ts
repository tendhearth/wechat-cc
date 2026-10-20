import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointGitArgs, takeCheckpoint } from './checkpoints'
import { applyRewind, commitOf, droppedCommits, dropIndex, ignoredConflicts, inspectApplying, workTree, worktreeState, type ApplyStep, type RewindGit } from './rewind'
import { removeTempDir } from '../../lib/test-temp'

/** 回退切片 2 的 git 部分:真临时仓库 + linked worktree(同独立工作区)。 */
const win = process.platform === 'win32'
let area: string, repo: string, wt: string, stateDir: string, g: RewindGit
const TASK = 'abcd1234', BRANCH = 'cc/abcd1234'
const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' }).toString().trim()
const put = (rel: string, data: string | Buffer) => { mkdirSync(join(wt, rel, '..'), { recursive: true }); writeFileSync(join(wt, rel), data) }
const read = (rel: string) => readFileSync(join(wt, rel))
const cp = async () => { const r = await takeCheckpoint({ root: wt, taskId: TASK, stateDir }); if ('skipped' in r) throw new Error(r.skipped); return r }
const head = () => run(wt, 'rev-parse', 'HEAD')
const exec = (rel: string) => (lstatSync(join(wt, rel)).mode & 0o111) !== 0

beforeEach(async () => {
  area = realpathSync(mkdtempSync(join(tmpdir(), 'cc-rewind-'))); repo = join(area, 'repo'); wt = join(area, 'wt'); stateDir = join(area, 'state')
  mkdirSync(repo); mkdirSync(stateDir)
  run(repo, 'init', '-q', '-b', 'main'); run(repo, 'config', 'user.email', 't@t'); run(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'base\n'); writeFileSync(join(repo, 'tool.sh'), 'echo\n'); writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  run(repo, 'add', '-A'); run(repo, 'commit', '-qm', 'base')
  run(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt, 'HEAD')
  const args = await checkpointGitArgs(wt)
  if ('skipped' in args) throw new Error(args.skipped)
  g = { root: args.top, filters: args.filters, stateDir }
})
afterEach(() => removeTempDir(area))

/** 一轮:改 a、加 new、tool 加执行位;下一轮:a 换成二进制、加未跟踪 u、删 new、在分支上提交一次,dist/ 里有被 ignore 的产物。 */
async function twoRounds() {
  const P = head()
  put('a.txt', 'one\n'); put('new.txt', 'new\n'); if (!win) chmodSync(join(wt, 'tool.sh'), 0o755)
  const C = await cp()
  put('a.txt', Buffer.from([0, 1, 2, 13, 10, 255])); put('u.txt', 'untracked\n'); rmSync(join(wt, 'new.txt')); if (!win) chmodSync(join(wt, 'tool.sh'), 0o644)
  put('c.txt', 'committed\n'); run(wt, 'add', 'c.txt'); run(wt, 'commit', '-qm', 'round 2')
  put('dist/out.js', 'built\n')
  const B = await cp()
  return { P, C, B, oldHead: head() }
}
function apply(target: { commit: string; parent: string }, B: { commit: string; tree: string }, oldHead: string, inject?: (s: ApplyStep) => void) {
  const pre = workTree(g, B.tree)
  try {
    expect(pre.tree).toBe(B.tree)
    const info = commitOf(g, target.commit)!
    return applyRewind({ g, branchRef: `refs/heads/${BRANCH}`, oldHead, target: { commit: target.commit, tree: info.tree, parent: target.parent }, backup: B, backupRef: `refs/tendhearth/rewind/${TASK}/${Date.now()}`, index: pre.index, ...(inject ? { inject } : {}) })
  } finally { dropIndex(pre.index) }
}

it('rewinds bytes, modes and untracked files, moves the branch back to P, leaves ignored files alone; undo is exact', async () => {
  const { P, C, B, oldHead } = await twoRounds()
  const before = { a: read('a.txt'), u: read('u.txt') }
  expect(apply({ commit: C.commit, parent: P }, B, oldHead)).toEqual({ ok: true })
  expect(read('a.txt').toString()).toBe('one\n'); expect(read('new.txt').toString()).toBe('new\n')
  expect(existsSync(join(wt, 'u.txt'))).toBe(false); expect(existsSync(join(wt, 'c.txt'))).toBe(false)
  if (!win) expect(exec('tool.sh')).toBe(true)
  expect(read('dist/out.js').toString()).toBe('built\n')
  expect(head()).toBe(P); expect(run(wt, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`)
  // 真 index 重置到 P:暂存区里没有那几轮的东西
  expect(run(wt, 'diff', '--cached', '--name-only')).toBe('')
  // 备份 ref 挂在主人仓库里,指向 B
  expect(run(repo, 'for-each-ref', '--format=%(objectname)', `refs/tendhearth/rewind/${TASK}/`)).toBe(B.commit)
  // 撤销 = 同一套流程,目标 B
  const B2 = await cp()
  expect(apply({ commit: B.commit, parent: oldHead }, B2, P)).toEqual({ ok: true })
  expect(read('a.txt')).toEqual(before.a); expect(read('u.txt')).toEqual(before.u)
  expect(existsSync(join(wt, 'new.txt'))).toBe(false); expect(read('c.txt').toString()).toBe('committed\n')
  if (!win) expect(exec('tool.sh')).toBe(false)
  expect(head()).toBe(oldHead)
})

for (const step of ['backup', 'switched', 'branch', 'verify'] as const) {
  it(`a failure after "${step}" rolls everything back to the backup state`, async () => {
    const { P, C, B, oldHead } = await twoRounds()
    const snapshot = { a: read('a.txt'), u: read('u.txt'), index: readFileSync(join(repo, '.git', 'worktrees', 'wt', 'index')) }
    const result = apply({ commit: C.commit, parent: P }, B, oldHead, s => { if (s === step) throw new Error('boom') })
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(read('a.txt')).toEqual(snapshot.a); expect(read('u.txt')).toEqual(snapshot.u); expect(existsSync(join(wt, 'new.txt'))).toBe(false)
    expect(head()).toBe(oldHead)
    expect(readFileSync(join(repo, '.git', 'worktrees', 'wt', 'index'))).toEqual(snapshot.index)
    expect(workTree(g, B.tree).tree).toBe(B.tree)
  })
}

it('rollback never overwrites a file edited inside the window: conflict reported, unrelated edits kept', async () => {
  writeFileSync(join(wt, 'same.txt'), 'same\n'); run(wt, 'add', 'same.txt'); run(wt, 'commit', '-qm', 'same')
  const { P, C, B, oldHead } = await twoRounds()
  const P2 = run(wt, 'rev-parse', `${C.commit}^`)
  expect(P2).toBe(P)
  // 只改了两树都一样的文件 ⇒ 回滚照做,那处改动留着
  let r = apply({ commit: C.commit, parent: P }, B, oldHead, s => { if (s === 'branch') put('same.txt', 'autosave\n') })
  expect(r).toMatchObject({ ok: false, error: 'rewind_verify_tree', rolledBack: true, conflicts: [], kept: ['same.txt'] })
  expect(read('same.txt').toString()).toBe('autosave\n'); expect(head()).toBe(oldHead)
  put('same.txt', 'same\n')
  // 改了两树有差的文件 ⇒ 不覆盖,报冲突;分支照样回去
  const B2 = await cp()
  r = apply({ commit: C.commit, parent: P }, B2, oldHead, s => { if (s === 'branch') put('a.txt', 'formatter\n') })
  expect(r).toMatchObject({ ok: false, rolledBack: false, conflicts: ['a.txt'] })
  expect(read('a.txt').toString()).toBe('formatter\n'); expect(head()).toBe(oldHead)
  if (!r.ok) expect(r.steps).toEqual(expect.arrayContaining([{ step: 'branch', ok: true }, expect.objectContaining({ step: 'worktree', ok: false })]))
})

it('a directory that becomes a file again: ignored files inside it count as a conflict', async () => {
  put('cache', 'file\n')
  const C = await cp()
  rmSync(join(wt, 'cache')); put('cache/keep.txt', 'k\n'); put('.gitignore', 'dist/\n*.log\n'); put('cache/secret.log', 'mine\n')
  const B = await cp()
  expect(ignoredConflicts(g, C.tree, B.tree)).toEqual(['cache/secret.log'])
  rmSync(join(wt, 'cache/secret.log'))
  expect(ignoredConflicts(g, C.tree, (await cp()).tree)).toEqual([])
})

it('refuses to clobber an ignored file the target tree would recreate', async () => {
  put('local.json', '{"v":1}\n')
  const C = await cp()
  put('.gitignore', 'dist/\nlocal.json\n'); put('local.json', '{"v":2,"mine":true}\n')
  const B = await cp()
  expect(ignoredConflicts(g, C.tree, B.tree)).toEqual(['local.json'])
  rmSync(join(wt, 'local.json'))
  const B2 = await cp()
  expect(ignoredConflicts(g, C.tree, B2.tree)).toEqual([])
})

it('reconciliation tells untouched / applied / files_only / unknown apart', async () => {
  const { P, C, B, oldHead } = await twoRounds()
  const input = { branchRef: `refs/heads/${BRANCH}`, priorHead: oldHead, target: { tree: C.tree, parent: P }, backupTree: B.tree }
  expect(inspectApplying(g, input)).toBe('untouched')
  expect(apply({ commit: C.commit, parent: P }, B, oldHead).ok).toBe(true)
  expect(inspectApplying(g, input)).toBe('applied')
  run(wt, 'update-ref', `refs/heads/${BRANCH}`, oldHead)
  expect(inspectApplying(g, input)).toBe('files_only')
  put('a.txt', 'someone else\n')
  expect(inspectApplying(g, input)).toBe('unknown')
})

it('worktreeState: linked vs main checkout, and an in-progress merge', () => {
  const linked = worktreeState(g)
  expect(linked.gitDir).not.toBe(linked.commonDir); expect(linked.headRef).toBe(`refs/heads/${BRANCH}`); expect(linked.inProgress).toBeNull()
  const main = worktreeState({ ...g, root: repo })
  expect(main.gitDir).toBe(main.commonDir)
  writeFileSync(join(linked.gitDir, 'MERGE_HEAD'), head() + '\n')
  expect(worktreeState(g).inProgress).toBe('MERGE_HEAD')
})

it('droppedCommits: merged into the project HEAD vs only present elsewhere', async () => {
  const P = head()
  put('c.txt', 'x\n'); run(wt, 'add', 'c.txt'); run(wt, 'commit', '-qm', 'c')
  const tip = head()
  expect(droppedCommits(g, P, tip, BRANCH, run(repo, 'rev-parse', 'HEAD'))).toEqual({ count: 1, merged: false, elsewhere: false })
  run(repo, 'branch', 'keep', tip)
  expect(droppedCommits(g, P, tip, BRANCH, run(repo, 'rev-parse', 'HEAD'))).toMatchObject({ merged: false, elsewhere: true })
  run(repo, 'merge', '-q', '--ff-only', tip)
  expect(droppedCommits(g, P, tip, BRANCH, run(repo, 'rev-parse', 'HEAD'))).toMatchObject({ merged: true })
})
