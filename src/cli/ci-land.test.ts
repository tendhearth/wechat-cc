import { describe, it, expect } from 'vitest'
import { judgeRollup, resolveStack, runCiLand, isNetworkError, CI_LAND_EXIT, type PrInfo, type CiLandDeps } from './ci-land'
import type { ExecResult } from './ci-triage-run'

const pr = (number: number, base: string, head: string, sha: string, isDraft = true): PrInfo =>
  ({ number, state: 'OPEN', baseRefName: base, headRefName: head, headRefOid: sha, isDraft })

const ok = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
const skip = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SKIPPED' })

describe('judgeRollup', () => {
  // 2026-10-27 #747:同一提交上 pr-rules 跑了两次(旧一轮读的是改之前的描述 ⇒ 红,新一轮 ⇒ 绿),只认最近那一次
  it('同一个作业跑了几次:只认最近开始的那一次', () => {
    const five = ['a', 'b', 'c', 'd'].map(name => ({ name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-27T08:00:00Z' }))
    const old = { name: 'pr', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-27T07:55:25Z' }
    const fresh = { name: 'pr', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-27T08:01:31Z' }
    expect(judgeRollup([...five, old, fresh], 5)).toEqual({ kind: 'green', counted: 5 })
    expect(judgeRollup([...five, fresh, old], 5)).toEqual({ kind: 'green', counted: 5 })
    // 反过来:最近那一次红了就是红,旧的绿不算数
    expect(judgeRollup([...five, { ...old, conclusion: 'SUCCESS' }, { ...fresh, conclusion: 'FAILURE' }], 5)).toEqual({ kind: 'red', failed: ['pr'] })
    // 不同工作流里同名的作业各算各的
    expect(judgeRollup([...five, { ...old, workflowName: 'Other' }, fresh], 5)).toEqual({ kind: 'red', failed: ['pr'] })
  })
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
  it('给的那层上面还叠着更上层 ⇒ 不算兄弟,只合到给的那层(核心链一步一部署)', () => {
    expect(resolveStack(2, open, 'dev').map(l => l.number)).toEqual([1, 2])
    expect(resolveStack(1, open, 'dev').map(l => l.number)).toEqual([1])
  })
  it('中间层上叠着不在这一串里的,照旧是兄弟', () => {
    expect(() => resolveStack(2, [...open, pr(4, 'a', 'd', 'sd')], 'dev')).toThrow(/#4/)
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
  /** gh pr merge 报网络错、但其实已经合了的 PR。 */
  mergedDespiteError?: number[]
}) {
  const calls: string[] = []
  let viewIdx = 0
  let dev = 'd0'
  let devParent = 'dX'
  let t = 0
  let head = ''
  const mergedNow = new Set<number>()
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
    if (line.startsWith('gh pr view') && args.includes('state')) {
      const n = Number(args[2])
      return r(JSON.stringify({ state: mergedNow.has(n) ? 'MERGED' : 'OPEN' }))
    }
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
    if (line.startsWith('gh pr merge') && script.netFailures?.merge?.length) {
      const n = Number(args[2])
      if (script.mergedDespiteError?.includes(n)) land(n)
      return r('', 1, script.netFailures.merge.shift()!)
    }
    if (line.startsWith('gh pr merge')) {
      land(Number(args[2]))
      return r()
    }
    return r()
  }
  function land(n: number) {
    if (mergedNow.has(n)) return
    mergedNow.add(n)
    devParent = script.devMovedBySomeoneElse ? 'stranger' : dev
    dev = `${dev}+${n}`
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
      "git push --no-verify --force-with-lease=b:sb origin HEAD:refs/heads/b",
      'gh pr edit 2 --base dev',
      'gh pr ready 2',
      'gh pr merge 2 --squash --match-head-commit sb-rebased',
      'git rebase --onto origin/dev sb',
      "git push --no-verify --force-with-lease=c:sc origin HEAD:refs/heads/c",
      'gh pr edit 3 --base dev',
      'gh pr ready 3',
      'gh pr merge 3 --squash --match-head-commit sc-rebased',
    ])
  })

  it('只给最下面那层(上面还叠着两层)⇒ 只合它,不碰上面的分支,说一声它们以后接着来', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sa')] })
    const lines: string[] = []
    deps.log = l => { lines.push(l) }
    const res = await runCiLand(deps, { top: 1, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([1])
    expect(calls.filter(c => /push|pr edit|pr merge/.test(c))).toEqual(['gh pr merge 1 --squash --match-head-commit sa'])
    expect(lines.some(l => l.includes('上面还叠着 #2'))).toBe(true)
  })

  it('head 变了 ⇒ 停,一层都不合', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('other')] })
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })

  it('CI 一直零条检查 ⇒ 十分钟后判红,不当绿', async () => {
    const { deps, calls } = fakeDeps({ open, views: [{ headRefOid: 'sc', statusCheckRollup: [] }] })
    const lines: string[] = []
    deps.log = l => { lines.push(l) }
    const res = await runCiLand(deps, { top: 3 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(res.message).toMatch(/一条检查都没有/)
    expect(res.message).toContain('gh pr close 3 && gh pr reopen 3')
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
    // 不等到十分钟才吭声:三分钟就自己关了再开一次,只一次。
    const hints = lines.filter(l => l.includes('多半没触发 CI'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('已关了再开一次')
    expect(calls.filter(c => /^gh pr (close|reopen) 3$/.test(c))).toEqual(['gh pr close 3', 'gh pr reopen 3'])
  })

  it('重触发之后 CI 起来了 ⇒ 照常等绿、合', async () => {
    const empty = { headRefOid: 'sc', statusCheckRollup: [] }
    const { deps, calls } = fakeDeps({ open, views: [empty, empty, empty, green('sc')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls.indexOf('gh pr reopen 3')).toBeLessThan(calls.indexOf('gh pr merge 1 --squash --match-head-commit sa'))
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
    const { deps, calls } = fakeDeps({ open: rest, merged: [{ number: 1, headRefName: 'a', headRefOid: 'sa-final' }], views: [green('sc-rebased')], ancestors: ['sa-final'] })
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
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc-rebased')], forcePushBefores: ['sa-v1', 'sa-v2'], ancestors: ['sa-v1'] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls).toContain('git rebase --onto origin/dev sa-v1')
    expect(calls.some(c => c.includes('sa-final') && c.startsWith('git rebase'))).toBe(false)
  })

  it('几次 force push 之前的都是祖先 ⇒ 取最新的那个', async () => {
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc-rebased')], forcePushBefores: ['sa-v1', 'sa-v2'], ancestors: ['sa-v1', 'sa-v2'] })
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
    const { deps, calls } = fakeDeps({ open: rest, merged, views: [green('sc-rebased')], ancestors: ['manual'] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true, parentOld: 'manual' })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls).toContain('git rebase --onto origin/dev manual')
  })
})

describe('runCiLand —— 接着来时先把最下层放到 dev 上再等 CI', () => {
  const merged = [{ number: 1, headRefName: 'a', headRefOid: 'sa' }]
  it('只有一层:先 rebase 推上去、改 base,再等**新 head** 的 CI', async () => {
    const { deps, calls } = fakeDeps({ open: [pr(2, 'a', 'b', 'sb')], merged, ancestors: ['sa'], views: [green('sb-rebased')] })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    const rebase = calls.indexOf('git rebase --onto origin/dev sa')
    const firstWait = calls.findIndex(c => c.startsWith('gh pr view 2 --json headRefOid'))
    expect(rebase).toBeGreaterThan(-1)
    expect(rebase).toBeLessThan(firstWait)
    expect(calls.indexOf('gh pr edit 2 --base dev')).toBeLessThan(firstWait)
    expect(calls).toContain('gh pr merge 2 --squash --match-head-commit sb-rebased')
  })
  it('只有一层:CI 还挂在旧 head 上 ⇒ 当「head 变了」停,不合没验过的那份', async () => {
    const { deps, calls } = fakeDeps({ open: [pr(2, 'a', 'b', 'sb')], merged, ancestors: ['sa'], views: [green('sb')] })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('多层:先整串从下往上放好(上层叠到下层的新 head 上、base 不改),再等最上面那个的新 CI', async () => {
    const { deps, calls } = fakeDeps({ open: [pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')], merged, ancestors: ['sa'], views: [green('sc-rebased')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    const firstWait = calls.findIndex(c => c.startsWith('gh pr view 3 --json headRefOid'))
    expect(calls.indexOf('git rebase --onto origin/dev sa')).toBeLessThan(firstWait)
    expect(calls.indexOf('git rebase --onto sb-rebased sb')).toBeLessThan(firstWait)
    expect(calls.filter(c => c === 'gh pr edit 3 --base dev').length).toBe(1) // 只在合的时候改,放的时候 base 还是下层分支
    expect(calls.indexOf('gh pr edit 3 --base dev')).toBeGreaterThan(firstWait)
    expect(calls).toContain('gh pr merge 2 --squash --match-head-commit sb-rebased')
    // 下层合掉以后,上层照常从下层(新)head rebase 到 dev
    expect(calls).toContain('git rebase --onto origin/dev sb-rebased')
  })
  it('多层:最上面那个的 CI 还挂在旧 head 上 ⇒ 停', async () => {
    const { deps, calls } = fakeDeps({ open: [pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')], merged, ancestors: ['sa'], views: [green('sc')] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('预演说出接着来的那一步', async () => {
    const { deps } = fakeDeps({ open: [pr(2, 'a', 'b', 'sb')], merged, views: [green('sb')] })
    const res = await runCiLand(deps, { top: 2, dryRun: true })
    expect(res.message).toMatch(/叠在已合的 #1 上/)
  })
})

describe('runCiLand —— 合并的回应丢了', () => {
  const open = [pr(1, 'dev', 'a', 'sa'), pr(2, 'a', 'b', 'sb')]
  it('merge 报 SSL 错、但其实合了 ⇒ 问一句状态,算合成,接着下一层', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sb')], netFailures: { merge: ['LibreSSL SSL_connect: SSL_ERROR_SYSCALL'] }, mergedDespiteError: [1] })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([1, 2])
    expect(calls.filter(c => c.startsWith('gh pr merge 1')).length).toBe(1)
  })
  it('merge 报网络错、也没合 ⇒ 重试', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sb')], netFailures: { merge: ['HTTP 502'] } })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls.filter(c => c.startsWith('gh pr merge 1')).length).toBe(2)
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
