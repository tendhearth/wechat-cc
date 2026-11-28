import { describe, it, expect } from 'vitest'
import { judgeRollup, judgeQueue, hasMergeQueueRule, resolveStack, runCiLand, isNetworkError, CI_LAND_EXIT, type PrInfo, type CiLandDeps } from './ci-land'
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
  it('close/reopen 的 cancelled 没有 startedAt,更新成功仍能覆盖;新失败不能被旧成功掩盖', () => {
    const cancelled = { name: 'build · windows-latest', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/o/r/actions/runs/1' }
    const success = { ...cancelled, conclusion: 'SUCCESS', startedAt: '2026-11-06T00:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/2' }
    expect(judgeRollup([cancelled, success], 1).kind).toBe('green')
    expect(judgeRollup([success, cancelled], 1).kind).toBe('green')
    expect(judgeRollup([success, { ...success, conclusion: 'FAILURE', startedAt: '2026-11-06T01:00:00Z' }], 1).kind).toBe('red')
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
  moveWhileWaiting?: boolean
  behind?: boolean
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
  /** 合并队列:进队列后第几次查状态时合进去;'dequeue' ⇒ 被踢出来;'move' ⇒ head 被人推了。 */
  queue?: { mergeAfterPolls?: number; outcome?: 'merge' | 'dequeue' | 'move' | 'merged-other-head' | 'auto-only'; noRule?: boolean; preEnqueued?: number[]
    /** 这个 head 上 ci · gate 的结论;otherRed = 另一条非必过检查红了。 */ gate?: string; otherRed?: boolean; noMergeCommitPolls?: number }
}) {
  const calls: string[] = []
  let viewIdx = 0
  let dev = 'd0'
  let devParent = 'dX'
  let t = 0
  let head = ''
  const mergedNow = new Set<number>()
  const enqueued = new Map<number, { head: string; polls: number }>()
  for (const n of script.queue?.preEnqueued ?? []) enqueued.set(n, { head: script.open.find(p => p.number === n)!.headRefOid, polls: 0 })
  const exec = (cmd: string, args: string[]): ExecResult => {
    const line = `${cmd} ${args.join(' ')}`
    calls.push(line)
    const r = (stdout = '', code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr })
    if (line === 'git symbolic-ref -q HEAD') return r('', 1)
    if (line === 'git status --porcelain') return r('')
    if (line.startsWith('gh pr list') && args.includes('merged')) return r(JSON.stringify(script.merged ?? []))
    if (line.startsWith('gh pr list')) return r(JSON.stringify(script.open))
    if (line.startsWith('git merge-base --is-ancestor')) {
      if (args[2] === 'd0') return r('', script.behind ? 1 : 0)
      if (args[2] === 'origin/dev') return r('', (script.onTarget ?? []).includes(head) ? 0 : 1)
      return r('', (script.ancestors ?? []).includes(args[2]!) ? 0 : 1)
    }
    if (line.startsWith('gh api graphql') && line.includes('isInMergeQueue')) {
      const n = Number(args.find(a => a.startsWith('n='))!.slice(2))
      const e = enqueued.get(n)
      const q = script.queue ?? {}
      const openHead = script.open.find(p => p.number === n)?.headRefOid ?? ''
      let state = 'OPEN', headRefOid = e?.head ?? openHead, inQueue = !!e, auto = false, mergeCommit: { oid: string } | null = null
      if (e && q.outcome === 'auto-only') { inQueue = false; auto = true }
      if (e) {
        e.polls++
        if (e.polls >= (q.mergeAfterPolls ?? 2)) {
          const outcome = q.outcome ?? 'merge'
          if (outcome === 'merge') { land(n); state = 'MERGED'; mergeCommit = { oid: dev } }
          else if (outcome === 'merged-other-head') { land(n); state = 'MERGED'; headRefOid = 'other-head'; mergeCommit = { oid: dev } }
          else if (outcome === 'dequeue') inQueue = false
          else if (outcome === 'move') headRefOid = 'someone-else'
        }
      }
      if (mergeCommit && (q.noMergeCommitPolls ?? 0) > 0) { q.noMergeCommitPolls!--; mergeCommit = null }
      const contexts = [
        // 一条更早的、结论相反的 gate(rerun 之前那一次),排在后面:必须按开始时间认,不能认最后一条。
        ...(q.gate ? [{ name: 'ci · gate', status: 'COMPLETED', conclusion: q.gate, startedAt: '2026-11-28T02:00:00Z' },
          { name: 'ci · gate', status: 'COMPLETED', conclusion: q.gate === 'SUCCESS' ? 'FAILURE' : 'SUCCESS', startedAt: '2026-11-28T01:00:00Z' }] : []),
        ...(q.otherRed ? [{ name: 'some other check', status: 'COMPLETED', conclusion: 'FAILURE' }] : []),
      ]
      return r(JSON.stringify({ data: { repository: { pullRequest: { state, headRefOid, baseRefName: 'dev', isInMergeQueue: inQueue, autoMergeRequest: auto ? { enabledAt: 'x' } : null, mergeCommit,
        commits: { nodes: [{ commit: { oid: headRefOid, statusCheckRollup: { contexts: { nodes: contexts } } } }] } } } } }))
    }
    if (line.startsWith('gh api repos/{owner}/{repo}/rules/branches/')) {
      return r(JSON.stringify(script.queue?.noRule ? [{ type: 'pull_request' }] : [{ type: 'merge_queue' }, { type: 'required_status_checks' }]))
    }
    if (line.startsWith('gh api graphql')) return r(JSON.stringify(script.forcePushBefores ?? []))
    if (line.startsWith('gh pr merge') && args.includes('--auto')) {
      enqueued.set(Number(args[2]), { head: args[args.indexOf('--match-head-commit') + 1]!, polls: 0 })
      return r()
    }
    if (line.startsWith('git push') && script.netFailures?.push?.length) return r('', 128, script.netFailures.push.shift()!)
    if (line.startsWith('gh pr view') && args.includes('baseRefName,mergeCommit')) {
      return r(JSON.stringify({ baseRefName: 'dev', mergeCommit: { oid: 'merged-before' } }))
    }
    if (line.startsWith('gh pr view') && args.includes('state')) {
      const n = Number(args[2])
      return r(JSON.stringify({ state: mergedNow.has(n) ? 'MERGED' : 'OPEN' }))
    }
    if (line.startsWith('gh pr view')) {
      if (script.moveWhileWaiting) dev = 'd1'
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

const green = (sha: string) => ({ headRefOid: sha, statusCheckRollup: [ok('build · ubuntu-latest'), ok('build · macos-latest'), ok('build · windows-latest'), ok('d'), ok('e'), skip('f')] })

describe('judgeQueue', () => {
  const q = { state: 'OPEN', headRefOid: 'h', isInMergeQueue: true, autoMerge: false }
  it('合了 / 在队列里 / 开着自动合并都分得清', () => {
    expect(judgeQueue({ ...q, state: 'MERGED' }, 'h', 0)).toBe('merged')
    expect(judgeQueue(q, 'h', 10 * 60_000)).toBe('waiting')
  })
  it('离开队列又没合:最后一次看见它在队列里之后的几分钟里先等(GitHub 慢半拍),过了就是被踢出来', () => {
    const out = { ...q, isInMergeQueue: false }
    expect(judgeQueue(out, 'h', 60_000)).toBe('waiting')
    expect(judgeQueue(out, 'h', 4 * 60_000)).toBe('dequeued')
    expect(judgeQueue({ ...q, state: 'CLOSED' }, 'h', 0)).toBe('dequeued')
  })
  it('只开着自动合并、还没进队列 ⇒ 在等 PR 自己的检查', () => {
    expect(judgeQueue({ ...q, isInMergeQueue: false, autoMerge: true }, 'h', 10 * 60_000)).toBe('awaiting_checks')
  })
  it('head 被人推了 ⇒ moved(没看过的版本不合);合进去的不是钉住的那一版也是 moved,不报成功', () => {
    expect(judgeQueue({ ...q, headRefOid: 'x' }, 'h', 0)).toBe('moved')
    expect(judgeQueue({ ...q, state: 'MERGED', headRefOid: 'x' }, 'h', 0)).toBe('moved')
  })
  it('认规则集里的 merge_queue', () => {
    expect(hasMergeQueueRule('[{"type":"merge_queue"}]')).toBe(true)
    expect(hasMergeQueueRule('[{"type":"pull_request"}]')).toBe(false)
    expect(hasMergeQueueRule('not json')).toBe(false)
  })
})

const linuxOnly = (sha: string) => ({ headRefOid: sha, statusCheckRollup: [ok('changes · paths'), ok('build · ubuntu-latest'), ok('node · core suite'), ok('e2e'), ok('ci · gate'), skip('desktop-e2e')] })

describe('runCiLand —— 合并队列', () => {
  const one = [pr(7, 'dev', 'x', 'sx', false)]
  it('落后 dev、PR 上只有 Linux 也照样进队列:--auto、不带 --squash,合了才算', async () => {
    const { deps, calls } = fakeDeps({ open: one, views: [linuxOnly('sx')], behind: true, moveWhileWaiting: true })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([7])
    expect(calls.filter(c => c.startsWith('gh pr merge'))).toEqual(['gh pr merge 7 --auto --match-head-commit sx'])
    expect(res.message).toContain('经合并队列')
    expect(res.message).toMatch(/ci triage --wait --rerun --sha \S+/)
  })
  it('队列那一轮红了被踢出来 ⇒ red,说去看 merge_group', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'dequeue', mergeAfterPolls: 1 } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(res.message).toContain('merge_group')
    expect(res.merged).toEqual([])
  })
  it('在队列里时 head 被人推了 ⇒ moved', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'move', mergeAfterPolls: 1 } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
  })
  it('PR 自己的 CI 红了照旧不进队列', async () => {
    const red = linuxOnly('sx'); red.statusCheckRollup[1] = { name: 'build · ubuntu-latest', status: 'COMPLETED', conclusion: 'FAILURE' }
    const { deps, calls } = fakeDeps({ open: one, views: [red] })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('叠起来的两层:下层进队列合了,上层 rebase 到 dev、先推后改 base(推失败时 base 没动,能接上),关了再开让 CI 对着 dev 跑,再用新 head 进队列', async () => {
    const stack = [pr(1, 'dev', 'a', 'sa', false), pr(2, 'a', 'b', 'sb', false)]
    const { deps, calls } = fakeDeps({ open: stack, views: [linuxOnly('sb')] })
    const res = await runCiLand(deps, { top: 2, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.merged).toEqual([1, 2])
    expect(calls.filter(c => /rebase --onto|push|pr edit|pr merge|pr close|pr reopen/.test(c))).toEqual([
      'gh pr merge 1 --auto --match-head-commit sa',
      'git rebase --onto origin/dev sa',
      'git push --no-verify --force-with-lease=b:sb origin HEAD:refs/heads/b',
      'gh pr edit 2 --base dev',
      'gh pr close 2',
      'gh pr reopen 2',
      'gh pr merge 2 --auto --match-head-commit sb-rebased',
    ])
  })
  it('两次 ci land 之间已经被队列合掉了 ⇒ 报合了、带合入提交,不说「不是开着的 PR」', async () => {
    const { deps, calls } = fakeDeps({ open: [], views: [], merged: [{ number: 7, headRefName: 'x', headRefOid: 'sx' }] })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res).toMatchObject({ exitCode: CI_LAND_EXIT.landed, merged: [7], mergeSha: 'merged-before', viaQueue: true })
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('dev 没开合并队列 ⇒ 不猜,停下来说用 --direct', async () => {
    const { deps, calls } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { noRule: true } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.precondition)
    expect(res.message).toContain('--direct')
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('已经在队列里(上一次回应丢了 / 等超时了)⇒ 不再请求一次,接着等', async () => {
    const { deps, calls } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { preEnqueued: [7] } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('合进去的不是钉住的那一版 ⇒ moved,不报成功', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'merged-other-head', mergeAfterPolls: 1 } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(res.message).toContain('人看一眼')
  })
  it('开着自动合并在等 PR 自己的检查、ci · gate 红了 ⇒ 当场 red 并说自动合并还开着', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'auto-only', mergeAfterPolls: 99, gate: 'FAILURE' } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true, timeoutMin: 600 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(res.message).toContain('ci · gate')
    expect(res.message).toContain('自动合并还开着')
  })
  it('gate 跳过(只改文档)算过,不报红', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'auto-only', mergeAfterPolls: 99, gate: 'SKIPPED' } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true, timeoutMin: 30 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.timeout)
  })
  it('别的非必过检查红了不算(不挡队列),照旧等', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { outcome: 'auto-only', mergeAfterPolls: 99, gate: 'SUCCESS', otherRed: true } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true, timeoutMin: 30 })
    expect(res.exitCode).toBe(CI_LAND_EXIT.timeout)
    expect(res.message).toContain('开着自动合并')
  })
  it('合进去了但合入提交晚几秒才出现 ⇒ 再问几次拿到它', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')], queue: { noMergeCommitPolls: 2 } })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.landed)
    expect(res.mergeSha).toBe('d0+7')
  })
  it('合完返回这一层的合入提交(给自改部署用)', async () => {
    const { deps } = fakeDeps({ open: one, views: [linuxOnly('sx')] })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true, queue: true })
    expect(res.mergeSha).toBe('d0+7')
    expect(res.viaQueue).toBe(true)
  })
  it('不走队列(--direct)照旧要求三平台', async () => {
    const { deps, calls } = fakeDeps({ open: one, views: [linuxOnly('sx')] })
    const res = await runCiLand(deps, { top: 7, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
})

describe('runCiLand', () => {
  const open = [pr(1, 'dev', 'a', 'sa'), pr(2, 'a', 'b', 'sb'), pr(3, 'b', 'c', 'sc')]

  it('落后 dev 时要求先同步,不等旧 CI、不合入', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')], behind: true })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.precondition)
    expect(res.message).toContain('先 rebase')
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('等待期间 dev 前进,停止合入并要求新 CI', async () => {
    const { deps, calls } = fakeDeps({ open, views: [green('sc')], moveWhileWaiting: true })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.moved)
    expect(res.message).toContain('同步分支')
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
  it('旧两平台 CI 即使检查数够也不放行', async () => {
    const old = green('sc')
    old.statusCheckRollup = old.statusCheckRollup.filter(c => c.name !== 'build · windows-latest')
    old.statusCheckRollup.push(ok('other'))
    const { deps, calls } = fakeDeps({ open, views: [old] })
    const res = await runCiLand(deps, { top: 3, skipTypecheck: true })
    expect(res.exitCode).toBe(CI_LAND_EXIT.red)
    expect(calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
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
