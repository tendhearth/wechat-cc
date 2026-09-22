import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fakeState, gitReply, greenTriage, makeFakeDeps, memoryStore, type FakeOpts } from './pipeline.fixture'
import { SELF_CHANGE_EXIT, exitCodeFor, runSelfChange } from './run'
import type { SelfChangeState, SelfChangeStep, StateStore } from './state'

/** 一整条能跑通的假机器:git 该回什么就回什么。 */
const HAPPY_GIT = gitReply({
  'rev-parse origin/dev': 'b'.repeat(40),
  'rev-list --count': '1\n',
  // src/a.ts 在场是为了让「FAIL src/a.test.ts」算**跟这次改动有关**的红:
  // 无关的红会先被 tests 闸门原样重跑一次(v1.1b 的抖动过滤),那是另一组用例在测。
  'diff --name-only': 'docs/x.md\nsrc/a.ts\n',
  'rev-parse HEAD': 'a'.repeat(40),
  'diff --stat': ' docs/x.md | 1 +\n',
})

function recordingStore(): { store: StateStore; steps: SelfChangeStep[]; rows: SelfChangeState[] } {
  const steps: SelfChangeStep[] = []
  const rows: SelfChangeState[] = []
  return {
    steps,
    rows,
    store: {
      load: () => null,
      save: s => { steps.push(s.step); rows.push(JSON.parse(JSON.stringify(s)) as SelfChangeState) },
      list: () => [],
      countSince: () => 0,
    },
  }
}

function happy(over: FakeOpts = {}): ReturnType<typeof makeFakeDeps> {
  return makeFakeDeps({ git: HAPPY_GIT, exists: () => true, ...over })
}

describe('exitCodeFor', () => {
  it('五个出口各归各位', () => {
    expect(exitCodeFor('done')).toBe(SELF_CHANGE_EXIT.done)
    expect(exitCodeFor('declined')).toBe(SELF_CHANGE_EXIT.declined)
    expect(exitCodeFor('approval_timeout')).toBe(SELF_CHANGE_EXIT.approvalTimeout)
    // CLI 层在流水线起步前挡下的那几种也归这里:退出码只有这一处说了算。
    for (const blocked of [
      'self_change_halted', 'self_change_quota', 'daemon_not_running', 'owner_chat_unknown',
      'self_change_busy', 'self_change_unsupported_platform', 'repo_url_unknown',
    ]) {
      expect(exitCodeFor(blocked)).toBe(SELF_CHANGE_EXIT.blocked)
    }
    for (const failed of ['forbidden_paths', 'no_changes', 'tests_exhausted', 'merge_conflict', 'crashed', null]) {
      expect(exitCodeFor(failed)).toBe(SELF_CHANGE_EXIT.failed)
    }
  })
})

describe('runSelfChange 一条跑通', () => {
  it('十二步走完 ⇒ done / 退出码 0,每步前后都存过盘', async () => {
    const { store, steps } = recordingStore()
    const { deps, rec } = happy({ state: store })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(state.result).toBe('done')
    expect(exitCode).toBe(0)
    expect([...new Set(steps)]).toEqual([
      'intake', 'repo', 'implement', 'guard', 'tests', 'review', 'ci', 'approval', 'merge', 'deploy', 'selftest', 'report', 'done',
    ])
    expect(rec.notices[0]).toContain('开始')
    expect(rec.notices.at(-1)).toContain('完成')
    // state 里留一份原话(开始 / 已合入 / 完成)。
    expect(state.notices).toEqual(rec.notices)
    expect(state.implement.rounds).toEqual({ tests: 0, review: 0, ci: 0 })
  })

  it('--no-deploy ⇒ 合完就写报告,不碰部署与自检', async () => {
    const { deps, rec } = happy()
    const { state, exitCode } = await runSelfChange(fakeState({ noDeploy: true }), deps)
    expect(exitCode).toBe(0)
    expect(state.deploy.ok).toBeNull()
    expect(rec.deployed).toEqual([])
    expect(rec.exec.some(c => c.includes('build-sidecar'))).toBe(false)
  })
})

describe('修复轮', () => {
  it('测试红一次:计一轮、接回同一个会话、脏了替它提交、回 guard 重走', async () => {
    let testRuns = 0
    // 执行者修完没提交:status 脏,直到流水线替它 commit。
    let dirty = false
    const { deps, rec } = happy({
      exec: (cmd, args) => {
        if (cmd === 'bun' && args[1] === 'test' && testRuns++ === 0) { dirty = true; return { code: 1, stdout: 'FAIL src/a.test.ts' } }
        return undefined
      },
      git: args => {
        if (args[0] === 'status') return { stdout: dirty ? ' M docs/x.md\n' : '' }
        if (args.includes('commit')) { dirty = false; return undefined }
        return HAPPY_GIT(args)
      },
    })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(exitCode).toBe(0)
    expect(state.implement.rounds).toEqual({ tests: 1, review: 0, ci: 0 })
    const fix = rec.runner[1]
    expect(fix?.resume).toBe('sess-1')
    expect(fix?.prompt).toContain('本地测试没过')
    // 预算是实现侧总额:这一轮只剩「总额 - 第一轮花掉的」。
    expect(rec.runner[0]?.budgetUsd).toBe(deps.config.implementBudgetUsd)
    expect(fix?.budgetUsd).toBe(deps.config.implementBudgetUsd - 1)
    expect(fix?.readOnly).toBeUndefined()
    expect(rec.git.some(a => a.at(-1) === '自改 #ab12cd34:修复轮(tests)未提交的改动')).toBe(true)
  })

  it('三处各自计数,评审两轮之后还能过', async () => {
    let reviews = 0
    const { deps } = happy({
      runner: input => (input.readOnly
        ? { text: reviews++ === 0 ? '```json\n{"verdict":"changes","findings":[{"severity":"critical","summary":"错了"}]}\n```' : undefined }
        : undefined),
    })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(exitCode).toBe(0)
    expect(state.implement.rounds).toEqual({ tests: 0, review: 1, ci: 0 })
  })

  it('修满两轮还红 ⇒ tests_exhausted(退出码 1),失败通知带原文', async () => {
    const { deps, rec } = happy({ exec: (cmd, args) => (cmd === 'bun' && args[1] === 'test' ? { code: 1, stdout: 'FAIL src/a.test.ts' } : undefined) })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(state.result).toBe('tests_exhausted')
    expect(exitCode).toBe(1)
    expect(state.implement.rounds.tests).toBe(3)
    expect(state.error).toContain('FAIL src/a.test.ts')
    expect(rec.notices.at(-1)).toContain('自改 #ab12cd34 失败:tests_exhausted')
    // 每多修一轮,剩下的预算就少一点(执行者每轮花 1 刀)。
    expect(rec.runner.filter(r => r.resume).map(r => r.budgetUsd)).toEqual([19, 18])
    // 三轮 tests:一次实现 + 两次修复。
    expect(rec.runner.filter(r => r.resume).length).toBe(2)
  })

  it('CI 不绿也走同一套计数', async () => {
    const { deps } = happy({ ciTriage: o => greenTriage(o.sha, 'real') })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('ci_exhausted')
    expect(state.implement.rounds).toEqual({ tests: 0, review: 0, ci: 3 })
    expect(exitCode).toBe(1)
  })

  it('修复轮里执行者自己挂了 ⇒ implement_failed', async () => {
    const { deps } = happy({
      exec: (cmd, args) => (cmd === 'bun' && args[1] === 'test' ? { code: 1 } : undefined),
      runner: (_input, call) => (call === 1 ? { ok: false, error: 'claude_exit_null', timedOut: true } : undefined),
    })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('implement_failed')
    expect(state.error).toContain('claude_exit_null')
    expect(exitCode).toBe(1)
  })
})

describe('结局', () => {
  it('主人回 n ⇒ declined(退出码 3),不合不部署', async () => {
    const { deps, rec } = happy({ decisions: ['deny'] })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('declined')
    expect(exitCode).toBe(3)
    expect(rec.git.some(a => a.includes('--ff-only'))).toBe(false)
    expect(rec.notices.at(-1)).toContain('你回了 n')
  })

  it('等不到拍板 ⇒ approval_timeout(退出码 4),step 停在 approval 好 --resume', async () => {
    const { deps, rec } = happy({ decisions: ['timeout'] })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('approval_timeout')
    expect(state.step).toBe('approval')
    expect(exitCode).toBe(4)
    expect(rec.notices.at(-1)).toContain('--resume ab12cd34')
  })

  it('停机 / 配额 / daemon 没起 ⇒ 退出码 2', async () => {
    const halted = happy({ config: { haltedAt: 1 } })
    expect((await runSelfChange(fakeState(), halted.deps)).exitCode).toBe(2)
    const noDaemon = happy({ health: false })
    expect((await runSelfChange(fakeState(), noDaemon.deps)).exitCode).toBe(2)
  })

  it('步骤没接住的异常 ⇒ crashed,原文进 state,退出码 1', async () => {
    const { deps } = happy()
    deps.exec = async () => { throw new Error('bun 不见了') }
    const { state, exitCode } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('crashed')
    expect(state.error).toContain('bun 不见了')
    expect(exitCode).toBe(1)
  })

  // deploy / selftest 两处**故意不**落到 crashed:crashed 既不加 fail_streak
  // 也不停机,而这两步抛异常(launchd 环境不对)恰恰是最该停机的那种失败。
  it('部署 / 自检抛异常不走 crashed,而是记进 fail_streak 的那两种结局', async () => {
    const deployThrew = happy()
    deployThrew.deps.deploy = async () => { throw new Error('launchagent_not_found') }
    const a = await runSelfChange(fakeState(), deployThrew.deps)
    expect(a.state.result).toBe('deploy_failed')
    expect(deployThrew.deps.config.failStreak).toBe(1)

    const selftestThrew = happy()
    selftestThrew.deps.selftest = async () => { throw new Error('自检客户端炸了') }
    const b = await runSelfChange(fakeState(), selftestThrew.deps)
    expect(b.state.result).toBe('selftest_failed_rolled_back')
    expect(selftestThrew.rec.rolledBack.length).toBe(1)
    expect(selftestThrew.deps.config.failStreak).toBe(1)
  })

  // deploy_tree_mismatch 既不停机也不会自动重来 —— 通知里不写「人该做什么」
  // 的话,主人只看到一条失败,不知道这条会一直停在这儿。
  it('工作树里不是批准的那条 ⇒ 通知要带上怎么接着装', async () => {
    // HEAD 是 HAPPY_GIT 里的 a…,批准的是 e… —— 对不上(`happy` 的工作树是在的)。
    const { deps, rec } = happy()
    const s = fakeState({ step: 'deploy', merge: { sha: 'e'.repeat(40), rebased: false } })
    const { state, exitCode } = await runSelfChange(s, deps)

    expect(state.result).toBe('deploy_tree_mismatch')
    expect(exitCode).toBe(1)
    const notice = rec.notices.at(-1) ?? ''
    expect(notice).toContain('wechat-cc self change --resume ab12cd34')
    // 恢复办法换了:删掉这条运行自己的工作树,下一次按批准的提交重建。
    expect(notice).toContain(join('runs', 'ab12cd34'))
    expect(notice).toContain('不会自动重来')
    expect(rec.deployed).toEqual([])
    // 不是机器坏了:不推 fail_streak、不停机。
    expect(rec.patches).toEqual([])
  })

  it('--resume:从 state 里的那一步接着跑,不重做前面的', async () => {
    const { deps, rec } = happy()
    const s = fakeState({ step: 'merge', ci: { runId: 1, url: null, verdict: 'green', sha: 'a'.repeat(40) } })
    const { state, exitCode } = await runSelfChange(s, deps)
    expect(exitCode).toBe(0)
    expect(state.result).toBe('done')
    expect(rec.runner).toEqual([])
    expect(rec.asks).toEqual([])
  })
})

describe('停机', () => {
  it('自检连着第二次红 ⇒ 写 halted_at,并告诉主人怎么解除', async () => {
    const { deps, rec } = happy({ config: { failStreak: 1 }, selftest: { workbench: false, chat: true } })
    const { state, exitCode } = await runSelfChange(fakeState({ step: 'selftest' }), deps)

    expect(state.result).toBe('selftest_failed_rolled_back')
    expect(exitCode).toBe(1)
    expect(rec.patches).toEqual([{ fail_streak: 2 }, { halted_at: expect.any(Number), halt_reason: expect.stringContaining('selftest_failed_rolled_back') }])
    expect(rec.notices.at(-1)).toContain('--unhalt')
  })

  it('主人回 n 时哪怕 fail_streak 已经到线,也不能停机', async () => {
    const { deps, rec } = happy({ config: { failStreak: 2 }, decisions: ['deny'] })
    const { state } = await runSelfChange(fakeState(), deps)
    expect(state.result).toBe('declined')
    expect(rec.patches).toEqual([])
    expect(rec.notices.some(n => n.includes('停机'))).toBe(false)
    expect(rec.notices.at(-1)).toContain('留在远端给人看')
  })

  it('第一次红只加 fail_streak,不停机', async () => {
    const { deps, rec } = happy({ selftest: { workbench: false, chat: true } })
    await runSelfChange(fakeState({ step: 'selftest' }), deps)
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
    expect(rec.notices.some(n => n.includes('停机'))).toBe(false)
  })

  // 2026-09-21 审查 #9:`haltedAt` 只在 intake 看一眼,而 `--resume` 是从
  // `state.step` 起步的 —— 停机之后恢复一条停在 deploy 的自改,机器照样构建、
  // 照样部署。停机的意思是「先别自动动这台机器」,不是「先别开新的」。
  describe('停机之后连恢复也不放行', () => {
    const halted = (over: FakeOpts = {}): ReturnType<typeof makeFakeDeps> =>
      happy({ config: { haltedAt: 1_699_000_000_000, haltReason: 'deploy_failed(连续 2 次)', failStreak: 2 }, ...over })

    it('停在 deploy 的那条 ⇒ self_change_halted(退出码 2),不构建不部署', async () => {
      const { deps, rec } = halted()
      const s = fakeState({ step: 'deploy', result: 'deploy_failed', merge: { sha: 'a'.repeat(40), rebased: false } })
      const { state, exitCode } = await runSelfChange(s, deps)

      expect(state.result).toBe('self_change_halted')
      expect(exitCode).toBe(2)
      expect(rec.exec).toEqual([])
      expect(rec.git).toEqual([])
      expect(rec.deployed).toEqual([])
      expect(rec.asks).toEqual([])
      expect(rec.notices.some(n => n.includes('完成'))).toBe(false)
      expect(rec.notices.at(-1)).toContain('--unhalt')
      // 停机时恢复不是「又红了一次」:别拿它去推 fail_streak。
      expect(rec.patches).toEqual([])
    })

    // 被停机挡下的这一次等于没跑过:不该顺手把盘上的 step / approval.decision
    // 改掉(那道门要是排在「清掉上一次结局」后面,恢复一条等拍板的自改会把
    // 它的 decision 抹了,--unhalt 之后再拍就对不上了)。
    it('挡下来的这一次不动盘上的 step / approval.decision', async () => {
      const { store, rows } = recordingStore()
      const { deps } = halted({ state: store })
      const s = fakeState({ step: 'approval', result: 'approval_timeout', error: '等了 1440 分钟没等到拍板' })
      s.approval.hash = 'h1'
      s.approval.decision = 'timeout'
      const { state, exitCode } = await runSelfChange(s, deps)

      expect(state.result).toBe('self_change_halted')
      expect(exitCode).toBe(2)
      expect(state.step).toBe('approval')
      expect(state.approval.decision).toBe('timeout')
      expect(state.approval.hash).toBe('h1')
      // 盘上一笔都别写:这一次压根没开跑。
      expect(rows).toEqual([])
    })

    it('--unhalt 之后,「退回 deploy」那条照样生效(盘上那个 result 还在)', async () => {
      const store = memoryStore()
      store.save(fakeState({ step: 'selftest', result: 'selftest_failed_rolled_back', merge: { sha: 'a'.repeat(40), rebased: false } }))

      const blocked = halted({ state: store })
      // 真 store 每次 load 都是从文件重新 parse 一份 —— 内存里改了没存盘的
      // 东西下一次读不回来。内存假件要复刻这一点,不然测不出「没存盘」。
      const load = (): SelfChangeState => {
        const row = store.load('ab12cd34')
        expect(row).not.toBeNull()
        return JSON.parse(JSON.stringify(row)) as SelfChangeState
      }
      expect((await runSelfChange(load(), blocked.deps)).state.result).toBe('self_change_halted')
      // 被挡下的这一次没动盘上任何东西 —— 下一次恢复认的就是这两个字段。
      expect(load().result).toBe('selftest_failed_rolled_back')
      expect(load().step).toBe('selftest')

      const { deps, rec } = happy({ config: { haltedAt: null, failStreak: 2 }, state: store })
      const { state } = await runSelfChange(load(), deps)
      expect(state.result).toBe('done')
      expect(rec.deployed).toHaveLength(1)
    })

    it('中间那些步也一样(不是只挡部署)', async () => {
      for (const step of ['implement', 'approval', 'merge', 'selftest', 'report'] as const) {
        const { deps, rec } = halted()
        const { state } = await runSelfChange(fakeState({ step }), deps)
        expect(state.result).toBe('self_change_halted')
        expect(rec.runner).toEqual([])
        expect(rec.deployed).toEqual([])
      }
    })

    it('--unhalt 之后(haltedAt 清了)才接着跑', async () => {
      const { deps, rec } = happy({ config: { haltedAt: null, failStreak: 2 } })
      const s = fakeState({ step: 'deploy', result: 'deploy_failed', merge: { sha: 'a'.repeat(40), rebased: false } })
      const { state, exitCode } = await runSelfChange(s, deps)
      expect(state.result).toBe('done')
      expect(exitCode).toBe(0)
      expect(rec.deployed).toHaveLength(1)
    })

    it('新起的一条照旧由 intake 那道门挡(话说得更细)', async () => {
      const { deps, rec } = halted()
      const { state, exitCode } = await runSelfChange(fakeState(), deps)
      expect(state.result).toBe('self_change_halted')
      expect(exitCode).toBe(2)
      expect(state.error).toContain('deploy_failed')
      expect(rec.runner).toEqual([])
    })
  })
})

// 2026-09-21 审查 #8:自检红了会把二进制回滚回上一版,但老代码把步留在
// `selftest`、`deploy.ok` 还留着 true —— `--resume` 于是对着那个已经被换回去的
// **旧**二进制再跑一遍自检。旧的当然绿,流水线就报「部署:绿」、把 fail_streak
// 清零、结局记成 done,而机器上根本没有这条改动。
describe('回滚之后恢复要重新部署', () => {
  const SHA = 'a'.repeat(40)
  const merged = (over: Partial<SelfChangeState> = {}): SelfChangeState =>
    fakeState({ step: 'selftest', merge: { sha: SHA, rebased: false }, deploy: { ok: true, version: 'A', sha: SHA, rolledBack: false }, ...over })

  it('自检红 ⇒ 回滚,盘上记成「没部署成、已回滚」,步退回 deploy', async () => {
    const { deps, rec } = happy({ selftest: { workbench: false, chat: true } })
    const s = merged()
    const { state, exitCode } = await runSelfChange(s, deps)

    expect(state.result).toBe('selftest_failed_rolled_back')
    expect(exitCode).toBe(1)
    expect(rec.rolledBack).toHaveLength(1)
    expect(state.step).toBe('deploy')
    expect(state.deploy).toEqual({ ok: false, version: null, sha: SHA, rolledBack: true })
    // 没部署成就一个字都别提「部署:绿」。
    expect(rec.notices.some(n => n.includes('部署:绿'))).toBe(false)
    expect(rec.notices.some(n => n.includes('完成'))).toBe(false)
  })

  it('--resume 一条回滚过的 ⇒ 重新构建、重新部署,再自检', async () => {
    const first = happy({ selftest: { workbench: false, chat: true } })
    const s = merged()
    await runSelfChange(s, first.deps)

    const retry = happy({ config: { failStreak: 1 } })
    const { state, exitCode } = await runSelfChange(s, retry.deps)

    expect(exitCode).toBe(0)
    expect(state.result).toBe('done')
    expect(retry.rec.deployed).toEqual([join('/w', 'runs', 'ab12cd34')])
    expect(retry.rec.exec.some(c => c.includes('build-sidecar'))).toBe(true)
    expect(state.deploy).toEqual({ ok: true, version: '1.2.3', sha: SHA, rolledBack: false })
    // 这一次「部署:绿」是真部署换来的。
    expect(retry.rec.notices.at(-1)).toContain('部署:绿')
  })

  it('盘上是老代码留下的状态(停在 selftest、deploy.ok 还是 true)⇒ 照样从 deploy 重来', async () => {
    const { deps, rec } = happy()
    const stale = merged({ result: 'selftest_failed_rolled_back', error: '自检红了(对话)' })
    const { state } = await runSelfChange(stale, deps)

    expect(state.result).toBe('done')
    expect(rec.deployed).toHaveLength(1)
    expect(rec.exec.some(c => c.includes('build-sidecar'))).toBe(true)
  })

  it('部署自己失败过的那条,恢复时也从 deploy 重来', async () => {
    const { deps, rec } = happy()
    const stale = merged({ step: 'selftest', result: 'deploy_failed', deploy: { ok: false, version: null, sha: null, rolledBack: false } })
    const { state } = await runSelfChange(stale, deps)

    expect(state.result).toBe('done')
    expect(rec.deployed).toHaveLength(1)
    expect(state.deploy.sha).toBe(SHA)
  })
})

// 2026-09-18 真机:`--resume` 一条 approval_timeout 的自改,内存里接着跑得好好的,
// 盘上却还写着上一次的结局 —— 于是 `--approve` 的第一道门(result === null)把人
// 挡在外面,拍不了板,只能再等一次超时。重新开跑就得先在盘上变回「活的」。
describe('--resume:重新开跑先把上一次的结局清掉', () => {
  it('approval_timeout 接着跑到 done;第一条存盘的 result 就是 null', async () => {
    const { store, rows } = recordingStore()
    const { deps } = happy({ state: store, decisions: ['allow'] })
    const s = fakeState({ step: 'approval', result: 'approval_timeout', error: '等了 1440 分钟没等到拍板' })
    s.approval.decision = 'timeout'
    const out = await runSelfChange(s, deps)
    expect(out.state.result).toBe('done')
    expect(out.exitCode).toBe(SELF_CHANGE_EXIT.done)
    // 盘上从第一笔起就是「活的」—— 否则 `--approve` 永远过不了那道门。
    expect(rows[0]!.result).toBeNull()
    expect(rows[0]!.error).toBeNull()
    expect(rows[0]!.approval.decision).toBeNull()
  })

  it('新起的一条不受影响(本来就是 null)', async () => {
    const { store, rows } = recordingStore()
    const { deps } = happy({ state: store })
    await runSelfChange(fakeState(), deps)
    expect(rows[0]!.result).toBeNull()
  })
})
