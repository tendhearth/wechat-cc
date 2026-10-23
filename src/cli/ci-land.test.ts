import { describe, it, expect } from 'vitest'
import { judgeRollup, resolveStack, runCiLand, isNetworkError, CI_LAND_EXIT, type PrInfo, type CiLandDeps } from './ci-land'
import type { ExecResult } from './ci-triage-run'

const pr = (number: number, base: string, head: string, sha: string, isDraft = true): PrInfo =>
  ({ number, state: 'OPEN', baseRefName: base, headRefName: head, headRefOid: sha, isDraft })

const ok = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
const skip = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SKIPPED' })

describe('judgeRollup', () => {
  it('空 rollup 永远不是绿', () => {
    expect(judgeRollup([], 5)).toEqual({ kind: 'too_few', counted: 0 })
    expect(judgeRollup([], 0).kind).toBe('green')
  })
  it('skipped 不计数;够数且全 SUCCESS 才绿', () => {
    const items = [ok('a'), ok('b'), skip('c'), skip('d')]
    expect(judgeRollup(items, 2)).toEqual({ kind: 'green', counted: 2 })
    expect(judgeRollup(items, 3)).toEqual({ kind: 'too_few', counted: 2 })
  })
  it('任何一条红 ⇒ red(即使别的还在跑)', () => {
    expect(judgeRollup([ok('a'), { name: 'w', status: 'IN_PROGRESS' }, { name: 'x', status: 'COMPLETED', conclusion: 'FAILURE' }], 1))
      .toEqual({ kind: 'red', failed: ['x'] })
  })
  it('还在跑 ⇒ pending', () => {
    expect(judgeRollup([ok('a'), { name: 'b', status: 'QUEUED' }], 1).kind).toBe('pending')
  })
  it('StatusContext 看 state', () => {
    expect(judgeRollup([{ context: 'ext', state: 'SUCCESS' }], 1).kind).toBe('green')
    expect(judgeRollup([{ context: 'ext', state: 'ERROR' }], 1)).toEqual({ kind: 'red', failed: ['ext'] })
  })
})

describe('resolveStack', () => {
  const open = [pr(1, 'dev', 'a', 'sa'), pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc'), pr(9, 'dev', 'z', 'sz')]
  it('从上往下走到 dev,返回从下到上,带旧 head', () => {
    expect(resolveStack(3, open, 'dev').map(l => [l.number, l.oldHead])).toEqual([[1, 'sa'], [2, 'sb'], [3, 'sc']])
  })
  it('单层也行', () => {
    expect(resolveStack(9, open, 'dev').map(l => l.number)).toEqual([9])
  })
  it('有兄弟 ⇒ 抛出', () => {
    expect(() => resolveStack(3, [...open, pr(4, 'a', 'd', 'sd')], 'dev')).toThrow(/#4/)
  })
  it('下层不是开着的 PR ⇒ 抛出', () => {
    expect(() => resolveStack(2, [pr(2, 'gone', 'b', 'sb')], 'dev')).toThrow(/gone/)
  })
  it('只给上层、下层的上面还叠着更上层(不是兄弟)不算兄弟', () => {
    // 合 #2 这一串时,#3 叠在 #2 上 ⇒ 它是兄弟(不在这一串里),停下。
    expect(() => resolveStack(2, open, 'dev')).toThrow(/#3/)
  })
})

/** 假的 git / gh:按命令前缀回结果,记录调用顺序。 */
function fakeDeps(script: {
  open: PrInfo[]
  views: Array<{ headRefOid: string; statusCheckRollup: unknown[] } | null>
  rebaseFailsFor?: string
  devMovedBySomeoneElse?: boolean
  merged?: Array<{ number: number; headRefName: string; headRefOid: string }>
  /** 前几次 push / gh pr merge 回什么 stderr(网络抖)。 */
  netFailures?: { push?: string[]; merge?: string[] }
  onTarget?: string[]
  /** 哪些提交是最下面那层的祖先(接着来时找旧 head 用)。 */
  ancestors?: string[]
  /** 已合下层被 force push 之前的 head(GraphQL beforeCommit,从旧到新)。 */
  forcePushBefores?: string[]
}) {
  const calls: string[] = []
  let viewIdx = 0
  let dev = 'd0'
  let devParent = 'dX'
  let t = 0
  let head = ''
  const exec = (cmd: string, args: string[]): ExecResult => {
    const line = `${cmd} ${args.join(' ')}`
    calls.push(line)
    const r = (stdout = '', code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr })
    if (line === 'git symbolic-ref -q HEAD') return r('', 1)
    if (line === 'git status --porcelain') return r('')
    if (line.startsWith('gh pr list') && args.includes('merged')) return r(JSON.stringify(script.merged ?? []))
    if (line.startsWith('gh pr list')) return r(JSON.stringify(script.open))
    if (line.startsWith('git merge-base --is-ancestor')) {
      if (args[2] === 'origin/dev') return r('', (script.onTarget ?? []).includes(head) ? 0 : 1)
      return r('', (script.ancestors ?? []).includes(args[2]!) ? 0 : 1)
    }
    if (line.startsWith('gh api graphql')) return r(JSON.stringify(script.forcePushBefores ?? []))
    if (line.startsWith('git push') && script.netFailures?.push?.length) return r('', 128, script.netFailures.push.shift()!)
    if (line.startsWith('gh pr view')) {
      const v = script.views[Math.min(viewIdx++, script.views.length - 1)]
      return v ? r(JSON.stringify(v)) : r('', 1)
    }
    if (line.startsWith('git checkout')) { head = args[3]!; return r() }
    if (line.startsWith('git rebase --onto')) {
      if (head === script.rebaseFailsFor) return r('', 1)
      head = `${head}-rebased`
      return r()
    }
    if (line.startsWith('git rebase --abort')) return r()
    if (line === 'git rev-parse HEAD') return r(`${head}\n`)
    if (line === 'git rev-parse origin/dev') return r(`${dev}\n`)
    if (line === 'git rev-parse origin/dev^') return r(`${devParent}\n`)
    if (line.startsWith('gh pr merge') && script.netFailures?.merge?.length) return r('', 1, script.netFailures.merge.shift()!)
    if (line.startsWith('gh pr merge')) {
      devParent = script.devMovedBySomeoneElse ? 'stranger' : dev
      dev = `${dev}+${args[2]}`
      return r()
    }
    return r()
  }
  const deps: CiLandDeps = {
    exec, sleep: async (ms) => { t += ms }, now: () => t, log: () => {}, cwd: '/repo',
  }
  return { deps, calls }
}

const green = (sha: string) => ({ headRefOid: sha, statusCheckRollup: [ok('a'), ok('b'), ok('c'), ok('d'), ok('e'), skip('f')] })

describe('runCiLand', () => {
  const open = [pr(1, 'dev', 'a', 'sa'), pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')]

  it('等最上面那个绿 ⇒ 从下往上:第一层直接合,上层 rebase --onto 下层旧 head、带租约推、改 base、合', async () => {
    const { deps, calls } = fakeDeps({ open, views: [{ headRefOid: 'sc', statusCheckRollup: [] }, green('sc')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([1, 2, 3])
    const keep = calls.filter(c => /rebase --onto|push|pr edit|pr merge|pr ready/.test(c))
    expect(keep).toEqual([
      'gh pr ready 1',
      'gh pr merge 1 --squash --match-head-commit sa',
      'git rebase --onto origin/dev sa',
      "git push --force-with-lease=b:sb origin HEAD:refs/heads/b",
      'gh pr edit 2 --base dev',
      'gh pr ready 2',
      'gh pr merge 2 --squash --match-head-commit sb-rebased',
      'git rebase --onto origin/dev sb',
      "git push --force-with-lease=c:sc origin HEAD:refs/heads/c",
      'gh pr edit 3 --base dev',
      'gh pr ready 3',
      'gh pr merge 3 --squash --match-head-commit sc-rebased',
    ])
  })

  it('head 变了 ⇒ 停,一层都不合', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('other')] })
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })

  it('CI 一直零条检查 ⇒ 十分钟后判红,不当绿', async () => {
    const { deps, calls } = fakeDeps({ open, views: [{ headRefOid: 'sc', statusCheckRollup: [] }] })
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(res.message).toMatch(/一条检查都没有/)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })

  it('changes 先完、别的还没进 rollup 的空档不判红,下一次看到全绿就合', async () => {
    const { deps } = fakeDeps({ open, views: [{ headRefOid: 'sc', statusCheckRollup: [ok('changes')] }, green('sc')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
  })

  it('gh 一直不回 ⇒ 十次后停(exit 2),不死等', async () => {
    const { deps } = fakeDeps({ open, views: [null] })
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.precondition)
    expect(res.message).toMatch(/连续 10 次/)
  })

  it('rebase 后先 bun install 再 tsc', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')] })
    await runCiLand(deps, { top: 3 })
    const i = calls.indexOf('bun install --frozen-lockfile')
    expect(i).toBeGreaterThan(-1)
    expect(calls.indexOf('bun x tsc --noEmit')).toBeGreaterThan(i)
  })

  it('跑完但非 skipped 一直不够数 ⇒ 十分钟后红,提示 --min-checks', async () => {
    const { deps } = fakeDeps({ open, views: [{ headRefOid: 'sc', statusCheckRollup: [ok('changes'), skip('b')] }] })
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(res.message).toMatch(/--min-checks 1/)
  })

  it('gh 没回东西 ⇒ 等一会儿再问,不当 head 变了', async () => {
    const { deps } = fakeDeps({ open, views: [null, green('sc')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
  })

  it('rebase 冲突 ⇒ abort、报告停在哪层,已合的保留', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')], rebaseFailsFor: 'sc' })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.conflict)
    expect(res.merged).toEqual([1, 2])
    expect(calls).toContain('git rebase --abort')
    expect(res.message).toMatch(/#3/)
  })

  it('dev 被别人动过 ⇒ 合完那一层就停', async () => {
    const { deps } = fakeDeps({ open, views: [green('sc')], devMovedBySomeoneElse: true })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(res.merged).toEqual([1])
  })

  it('不在 detached HEAD ⇒ 拒绝', async () => {
    const { deps } = fakeDeps({ open, views: [green('sc')] })
    const exec = deps.exec
    deps.exec = (cmd, args, o) => (args.join(' ') === 'symbolic-ref -q HEAD' ? { code: 0, stdout: 'refs/heads/x', stderr: '' } : exec(cmd, args, o))
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.precondition)
    expect(res.message).toMatch(/detached/)
  })

  it('预演:只认出这一串,不动任何东西', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')] })
    const res = await runCiLand(deps, { top: 3, dryRun: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls.filter(c => !c.startsWith('gh pr list'))).toEqual([])
  })

  it('网络抖 ⇒ 退避重试,第二次成了就照常合', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')], netFailures: { push: ['fatal: unable to access: LibreSSL SSL_connect: SSL_ERROR_SYSCALL'], merge: ['HTTP 502: Bad Gateway'] } })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([1, 2, 3])
    expect(calls.filter(c => c.startsWith('gh pr merge 1')).length).toBe(2)
  })

  it('租约被拒不重试,当「动过」停', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')], netFailures: { push: ['! [rejected] HEAD -> b (stale info)'] } })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(calls.filter(c => c.startsWith('git push')).length).toBe(1)
    expect(res.merged).toEqual([1])
  })

  it('接着上一次:最下面那个已合,上一层的 base 还指着它的分支 ⇒ 用那个 PR 最后的 head 当 rebase 起点', async () => {
    const rest = [pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')]
    const { deps, calls } = fakeDeps({ open: rest, merged: [{ number: 1, headRefName: 'a', headRefOid: 'sa-final' }], views: [green('sc')], ancestors: ['sa-final'] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([2, 3])
    expect(calls).toContain('git rebase --onto origin/dev sa-final')
    expect(calls).toContain('gh pr edit 2 --base dev')
  })

  it('接着上一次:那一层已经 rebase 推上去了(停在改 base)⇒ 不再 rebase、不再推', async () => {
    const rest = [pr(2, 'a', 'b', 'sb2', false)]
    const { deps, calls } = fakeDeps({ open: rest, merged: [{ number: 1, headRefName: 'a', headRefOid: 'sa' }], views: [green('sb2')], onTarget: ['sb2'] })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls.some(c => c.startsWith('git rebase --onto'))).toBe(false)
    expect(calls.some(c => c.startsWith('git push'))).toBe(false)
    expect(calls).toContain('gh pr merge 2 --squash --match-head-commit sb2')
  })
})

describe('runCiLand —— 接着来时找下层的旧 head', () => {
  const rest = [pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')]
  const merged = [{ number: 1, headRefName: 'a', headRefOid: 'sa-final' }]

  it('下层合前被 rebase 过、还解过冲突(补丁变了,#617)⇒ 用 force push 之前、是这一层祖先的那个 head', async () => {
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc')], forcePushBefores: ['sa-v1', 'sa-v2'], ancestors: ['sa-v1'] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls).toContain('git rebase --onto origin/dev sa-v1')
    expect(calls.some(c => c.includes('sa-final') && c.startsWith('git rebase'))).toBe(false)
  })

  it('几次 force push 之前的都是祖先 ⇒ 取最新的那个', async () => {
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc')], forcePushBefores: ['sa-v1', 'sa-v2'], ancestors: ['sa-v1', 'sa-v2'] })
    await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(calls).toContain('git rebase --onto origin/dev sa-v2')
  })

  it('一个都对不上 ⇒ 停,要 --parent-old,一层都不动', async () => {
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc')], forcePushBefores: ['sa-v1'], ancestors: [] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.precondition)
    expect(res.message).toMatch(/--parent-old/)
    expect(calls.some(c => c.startsWith('git rebase --onto') || c.startsWith('git push') || c.startsWith('gh pr merge'))).toBe(false)
  })

  it('--parent-old 手给且是祖先 ⇒ 用它', async () => {
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc')], ancestors: ['manual'] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true, parentOld: 'manual' })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls).toContain('git rebase --onto origin/dev manual')
  })
})

describe('isNetworkError', () => {
  it.each([
    'fatal: unable to access \'https://github.com/x/\': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443',
    'Could not resolve host: github.com',
    'Operation timed out',
    'HTTP 502: Bad Gateway',
    'error: RPC failed; curl 56 Connection reset by peer',
  ])('可重试:%s', (e) => expect(isNetworkError(e)).toBe(true))
  it.each([
    ' ! [rejected]        HEAD -> b (stale info)',
    'Head branch was modified. Review and try the merge again. (head commit mismatch)',
    'Pull request is not mergeable',
    '',
  ])('不重试:%s', (e) => expect(isNetworkError(e)).toBe(false))
})
