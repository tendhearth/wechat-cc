import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { fakeState, gitReply, greenTriage, makeFakeDeps, memoryStore } from './pipeline.fixture'
import type { SelfChangeState } from './state'
import { failingTestFiles, SUMMARY_MAX_CHARS, steps } from './steps'

const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)

describe('intake', () => {
  it('停机了就不干活(blocked)', async () => {
    const { deps, rec } = makeFakeDeps({ config: { haltedAt: 1_699_000_000_000, haltReason: 'selftest_failed_rolled_back' } })
    const out = await steps.intake(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'self_change_halted' })
    expect(out.detail).toContain('selftest_failed_rolled_back')
    expect(rec.notices).toEqual([])
  })

  it('今天跑够了就不干活,而且不把自己算进去', async () => {
    const now = 1_700_000_000_000
    const today = [1, 2].map(i => fakeState({ id: `same-day-${i}`, startedAt: now - 1000 }))
    const mine = fakeState({ id: 'mine', startedAt: now })
    const { deps } = makeFakeDeps({ config: { maxPerDay: 3 }, now: () => now, state: memory([...today, mine]) })
    // 自己 + 两条 = 3 条,但上限算的是「别的」,所以还能跑。
    expect(await steps.intake(mine, deps)).toMatchObject({ ok: true, next: 'repo' })

    const { deps: deps2 } = makeFakeDeps({ config: { maxPerDay: 2 }, now: () => now, state: memory([...today, mine]) })
    expect(await steps.intake(mine, deps2)).toMatchObject({ ok: false, fail: 'self_change_quota' })
  })

  it('daemon 没起就不干活(没人能拍板)', async () => {
    const { deps } = makeFakeDeps({ health: false })
    expect(await steps.intake(fakeState(), deps)).toMatchObject({ ok: false, fail: 'daemon_not_running' })
  })

  it('三道门都过 ⇒ 报一句开始', async () => {
    const { deps, rec } = makeFakeDeps()
    const s = fakeState()
    expect(await steps.intake(s, deps)).toEqual({ ok: true, next: 'repo' })
    expect(rec.notices[0]).toContain('自改 #ab12cd34 开始:给 flake 表加一行')
    // 报出去的原话也要留在 state 里,事后追账不用去翻微信。
    expect(s.notices).toEqual(rec.notices)
  })
})

function memory(rows: ReturnType<typeof fakeState>[]): ReturnType<typeof makeFakeDeps>['deps']['state'] {
  return {
    load: id => rows.find(r => r.id === id) ?? null,
    save: () => {},
    list: () => rows,
    countSince: ts => rows.filter(r => r.startedAt >= ts).length,
  }
}

describe('repo', () => {
  it('没有克隆就 clone,有就 fetch;两条路都要 reset + checkout -B + 写交代', async () => {
    const s = fakeState()
    const fresh = makeFakeDeps({ exists: () => false, git: gitReply({ 'rev-parse origin/dev': BASE_SHA }) })
    expect(await steps.repo(s, fresh.deps)).toEqual({ ok: true, next: 'implement' })
    expect(fresh.rec.git[0]).toEqual(['clone', 'file:///tmp/remote.git', 'repo'])
    expect(fresh.rec.git.some(a => a.join(' ') === 'checkout -B self/ab12cd34 origin/dev')).toBe(true)
    expect(s.baseSha).toBe(BASE_SHA)
    expect(fresh.files.get(join('/w', 'briefs', 'ab12cd34.md'))).toContain('自改 #ab12cd34')
    expect(fresh.rec.exec[0]).toEqual(['bun', 'install', '--frozen-lockfile'])

    const reused = makeFakeDeps({ exists: () => true, git: gitReply({ 'rev-parse origin/dev': BASE_SHA }) })
    await steps.repo(fakeState(), reused.deps)
    expect(reused.rec.git[0]).toEqual(['fetch', 'origin', '--prune'])
  })

  it('git 失败 ⇒ repo_failed,原文带上', async () => {
    const { deps } = makeFakeDeps({ exists: () => true, git: gitReply({ fetch: { code: 128, stderr: 'fatal: 远端没了' } }) })
    const out = await steps.repo(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'repo_failed' })
    expect(out.detail).toContain('fatal: 远端没了')
  })

  it('bun install 红了也是 repo_failed', async () => {
    const { deps } = makeFakeDeps({ exists: () => true, exec: () => ({ code: 1, stderr: 'lockfile 对不上' }) })
    expect(await steps.repo(fakeState(), deps)).toMatchObject({ ok: false, fail: 'repo_failed' })
  })
})

describe('implement', () => {
  it('执行者忘了提交 ⇒ 流水线替它提交,不算失败', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      git: gitReply({ 'status --porcelain': ' M src/a.ts\n', 'rev-list --count': '2\n' }),
    })
    expect(await steps.implement(s, deps)).toEqual({ ok: true, next: 'guard' })
    const commit = rec.git.find(a => a.includes('commit'))
    expect(commit?.at(-1)).toBe('自改 #ab12cd34:执行者未提交的改动')
    // 全局没身份 ⇒ 临时补一个,不然 git commit 会以「你是谁」整条失败。
    expect(commit?.slice(0, 4)).toEqual(['-c', 'user.name=wechat-cc self-change', '-c', 'user.email=self-change@wechat-cc.local'])
    expect(s.implement.sessionId).toBe('sess-1')
    expect(s.implement.costUsd).toBe(1)
  })

  it('只配了 user.email 没配 user.name 的机器,也要走临时身份', async () => {
    const { deps, rec } = makeFakeDeps({
      git: gitReply({
        'config --get user.email': 'owner@example.com\n',
        'config --get user.name': { code: 1 },
        'status --porcelain': ' M src/a.ts\n',
        'rev-list --count': '1\n',
      }),
    })
    expect(await steps.implement(fakeState(), deps)).toEqual({ ok: true, next: 'guard' })
    expect(rec.git.find(a => a.includes('commit'))?.[1]).toBe('user.name=wechat-cc self-change')
  })

  it('主人自己的身份齐全时就用他的,不加 -c', async () => {
    const { deps, rec } = makeFakeDeps({
      git: gitReply({ 'config --get': 'owner\n', 'status --porcelain': ' M src/a.ts\n', 'rev-list --count': '1\n' }),
    })
    await steps.implement(fakeState(), deps)
    expect(rec.git.find(a => a.includes('commit'))?.[0]).toBe('commit')
  })

  it('执行者最后那段话留进 state(拍板卡要用)', async () => {
    const s = fakeState()
    const long = 'x'.repeat(2000) + '\n收尾:改了 a.ts,跑了四条验证。'
    const { deps } = makeFakeDeps({
      runner: () => ({ text: long }),
      git: gitReply({ 'rev-list --count': '1\n' }),
    })
    await steps.implement(s, deps)
    expect(s.implement.summary).toContain('收尾:改了 a.ts')
    // 微信里一条几千字的卡片没人读 —— 留尾巴 1500 字。
    expect(s.implement.summary.length).toBe(SUMMARY_MAX_CHARS)
  })

  it('一个提交都没有 ⇒ no_changes(不进修复轮)', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ 'rev-list --count': '0\n' }) })
    const out = await steps.implement(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'no_changes' })
    expect(out.fixRound).toBeUndefined()
  })

  it('执行者自己失败 ⇒ implement_failed,带上 error', async () => {
    const { deps } = makeFakeDeps({ runner: () => ({ ok: false, error: 'claude_exit_null', text: '超时了' }) })
    const out = await steps.implement(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'implement_failed' })
    expect(out.detail).toContain('claude_exit_null')
  })
})

describe('guard', () => {
  it('碰了禁改清单 ⇒ forbidden_paths,列出文件', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ 'diff --name-only': 'src/a.ts\nsrc/cli/self-deploy.ts\n' }) })
    const out = await steps.guard(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'forbidden_paths' })
    expect(out.detail).toContain('src/cli/self-deploy.ts')
    expect(out.detail).not.toContain('- src/a.ts')
  })

  it('没碰 ⇒ 去跑测试', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ 'diff --name-only': 'src/a.ts\ndocs/x.md\n' }) })
    expect(await steps.guard(fakeState(), deps)).toEqual({ ok: true, next: 'tests' })
  })
})

describe('failingTestFiles', () => {
  it('认 FAIL 行、去 ANSI、去重;认不出来的给空表', () => {
    const out = failingTestFiles([
      ' \u001b[31mFAIL\u001b[0m  src/a.test.ts > 第一条',
      ' FAIL  src/a.test.ts > 第二条',
      ' FAIL  src/b/c.test.ts',
      'AssertionError: expected 1 to be 2',
    ].join('\n'))
    expect(out).toEqual(['src/a.test.ts', 'src/b/c.test.ts'])
    expect(failingTestFiles('timed out after 1800000ms')).toEqual([])
  })
})

describe('tests', () => {
  it('四条依次跑,全绿 ⇒ 去评审', async () => {
    const { deps, rec } = makeFakeDeps()
    expect(await steps.tests(fakeState(), deps)).toEqual({ ok: true, next: 'review' })
    expect(rec.exec.map(c => c.join(' '))).toEqual([
      'bun run typecheck', 'bun run depcheck', 'bun run test', 'npm run test:node -- --reporter=dot',
    ])
  })

  it('第一条红就停,失败尾巴(去 ANSI)进修复轮', async () => {
    const { deps, rec } = makeFakeDeps({
      exec: (_cmd, args) => args.includes('depcheck') ? { code: 1, stdout: '[31mFAIL src/a.test.ts[0m' } : undefined,
      git: gitReply({ 'diff --name-only': 'src/a.ts\n' }),
    })
    const out = await steps.tests(fakeState(), deps)
    expect(out.fixRound).toBe('tests')
    expect(out.detail).toContain('FAIL src/a.test.ts')
    expect(out.detail).not.toContain('[31m')
    expect(out.fixPrompt).toContain('本地测试没过')
    // src/a.test.ts ↔ src/a.ts:红的正是这轮改的东西,不重跑,直接交回。
    expect(rec.exec.length).toBe(2)
  })

  // 真机 f65f4c09:满载机器把整套测试拖超时,红的跟这次改动毫无关系,
  // 修复轮却花了 $10 让执行者改了 10 个无关文件。抖动不该由执行者来「修」。
  it('红的测试文件与本次改动无关 ⇒ 原样重跑一次,绿了就接着走并记一笔抖动', async () => {
    let testCalls = 0
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      exec: (cmd, args) => cmd === 'bun' && args.includes('test')
        ? (testCalls++ === 0 ? { code: 1, stdout: ' FAIL  src/unrelated.test.ts > 某个断言\n' } : undefined)
        : undefined,
      git: gitReply({ 'diff --name-only': 'docs/maintainer/ci-and-flakes.md\n' }),
    })
    expect(await steps.tests(s, deps)).toEqual({ ok: true, next: 'review' })
    expect(s.tests.flakes).toEqual(['bun run test'])
    expect(rec.exec.map(c => c.join(' '))).toEqual([
      'bun run typecheck', 'bun run depcheck', 'bun run test', 'bun run test', 'npm run test:node -- --reporter=dot',
    ])
  })

  it('一条 FAIL 都解析不出来(整套被超时杀掉)也当抖动重跑', async () => {
    let calls = 0
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      exec: (cmd) => cmd === 'bun' && calls++ === 2 ? { code: 1, stderr: 'timed out after 1800000ms\n' } : undefined,
      git: gitReply({ 'diff --name-only': 'docs/x.md\n' }),
    })
    expect(await steps.tests(s, deps)).toEqual({ ok: true, next: 'review' })
    expect(s.tests.flakes).toEqual(['bun run test'])
    expect(rec.exec.length).toBe(5)
  })

  it('无关的红重跑还是红 ⇒ 照旧进修复轮(带第二次的输出)', async () => {
    const { deps, rec } = makeFakeDeps({
      exec: (_cmd, args) => args.includes('depcheck')
        ? { code: 1, stdout: ' FAIL  src/unrelated.test.ts\n' }
        : undefined,
      git: gitReply({ 'diff --name-only': 'docs/x.md\n' }),
    })
    const out = await steps.tests(fakeState(), deps)
    expect(out.fixRound).toBe('tests')
    expect(out.detail).toContain('src/unrelated.test.ts')
    // typecheck + depcheck + depcheck(重跑)
    expect(rec.exec.length).toBe(3)
  })

  // typecheck / depcheck 的红是确定性的:它们没有 FAIL 行不是因为抖动,
  // 是因为它们压根不长那个样子。重跑一次只是白等。
  it('typecheck / depcheck 红了一律直接进修复轮,不重跑', async () => {
    for (const which of ['typecheck', 'depcheck']) {
      const { deps, rec } = makeFakeDeps({
        exec: (_cmd, args) => args.includes(which) ? { code: 1, stdout: 'error TS2353: …' } : undefined,
        git: gitReply({ 'diff --name-only': 'docs/x.md\n' }),
      })
      const out = await steps.tests(fakeState(), deps)
      expect(out.fixRound).toBe('tests')
      expect(rec.exec.length).toBe(which === 'typecheck' ? 1 : 2)
    }
  })

  it('改动文件列表问不出来时不敢判抖动:不重跑,直接进修复轮', async () => {
    const { deps, rec } = makeFakeDeps({
      exec: (_cmd, args) => args.includes('depcheck') ? { code: 1, stdout: 'boom' } : undefined,
      git: gitReply({ 'diff --name-only': { code: 128, stderr: 'fatal: bad revision' } }),
    })
    expect((await steps.tests(fakeState(), deps)).fixRound).toBe('tests')
    expect(rec.exec.length).toBe(2)
  })

  it('修复轮的提示词里写着范围纪律(不准为了变绿放宽阈值)', async () => {
    const { deps } = makeFakeDeps({
      exec: (_cmd, args) => args.includes('depcheck') ? { code: 1, stdout: ' FAIL  src/a.test.ts\n' } : undefined,
      git: gitReply({ 'diff --name-only': 'src/a.ts\n' }),
    })
    const out = await steps.tests(fakeState(), deps)
    expect(out.fixPrompt).toContain('与本次改动无关')
    expect(out.fixPrompt).toContain('不要调超时')
  })
})

describe('review', () => {
  it('approve ⇒ 去 CI;findings 记在 state 上', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      runner: () => ({ text: '还行。\n```json\n{"verdict":"approve","findings":[{"severity":"minor","summary":"命名可以再好点"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    expect(await steps.review(s, deps)).toEqual({ ok: true, next: 'ci' })
    expect(rec.runner[0]?.readOnly).toBe(true)
    expect(s.review.verdict).toBe('approve')
    expect(s.review.findings).toEqual([{ severity: 'minor', summary: '命名可以再好点' }])
  })

  it('有 important ⇒ 修复轮', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"important","file":"src/a.ts","line":3,"summary":"错误吞了"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixRound).toBe('review')
    expect(out.fixPrompt).toContain('src/a.ts:3 错误吞了')
  })

  it('评审只是改脏了工作树(HEAD 没动)⇒ 也要 reset --hard,不能只 checkout 索引', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"approve","findings":[]}\n```' }),
      git: gitReply({ 'status --porcelain': 'M  src/a.ts\n', 'rev-parse HEAD': HEAD_SHA }),
    })
    const out = await steps.review(s, deps)
    expect(out.fixRound).toBe('review')
    expect(s.review.verdict).toBe('changes')
    expect(s.review.findings[0]).toEqual({ severity: 'important', summary: '评审会话改了工作树,已还原' })
    // `M ` 是**已暂存**的改动:`checkout -- .` 会把索引刷回工作树,等于原样留着,
    // 接着的 review 修复轮就会把评审的手笔提交进去。必须硬还原。
    expect(rec.git.some(a => a.join(' ') === `reset --hard ${HEAD_SHA}`)).toBe(true)
    expect(rec.git.some(a => a.join(' ') === 'clean -fd')).toBe(true)
    expect(rec.git.some(a => a.join(' ') === 'checkout -- .')).toBe(false)
  })

  it('评审动了 HEAD ⇒ 硬还原到评审前那个 HEAD', async () => {
    let calls = 0
    const { deps, rec } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"approve","findings":[]}\n```' }),
      git: args => {
        if (args.join(' ') === 'rev-parse HEAD') return { stdout: calls++ === 0 ? HEAD_SHA : 'c'.repeat(40) }
        return undefined
      },
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixRound).toBe('review')
    expect(rec.git.some(a => a.join(' ') === `reset --hard ${HEAD_SHA}`)).toBe(true)
  })

  it('判了 changes 却一条 critical / important 都没列 ⇒ 照样回一轮修复轮', async () => {
    const s = fakeState()
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"minor","summary":"命名可以再好点"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    const out = await steps.review(s, deps)
    // 「说要改却说不出哪里要改」不该当成放行 —— spec 的「只剩 minor ⇒ 通过」
    // 说的是 approve 那一边。
    expect(out.fixRound).toBe('review')
    expect(out.fixPrompt).toContain('命名可以再好点')
    expect(s.review.verdict).toBe('changes')
  })

  it('judge 一条意见都没给的 changes 也回修复轮', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixRound).toBe('review')
    expect(out.detail).toContain('一条意见都没列出来')
  })

  it('approve + 只剩 minor ⇒ 照旧放行(这条没变)', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"approve","findings":[{"severity":"minor","summary":"小事"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    expect(await steps.review(fakeState(), deps)).toEqual({ ok: true, next: 'ci' })
  })

  // 真机 f65f4c09:越界改动只被记了一条 minor 就合进了 dev。现在它是 important,
  // 而且修复轮要的是「还原」不是「修」—— 让执行者去「修」那些文件等于让它接着改。
  it('scope: 的 important ⇒ 修复轮的提示词是还原,带文件清单和 checkout 命令', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"important","file":"vitest.config.ts","summary":"scope:vitest.config.ts 把超时从 5s 放到 20s,与需求无关"},{"severity":"important","summary":"scope:src/fixture.ts 顺手改了夹具"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA, 'diff --name-only': 'docs/x.md\nvitest.config.ts\nsrc/fixture.ts\n' }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixRound).toBe('review')
    expect(out.fixPrompt).toContain('还原')
    expect(out.fixPrompt).toContain('vitest.config.ts')
    expect(out.fixPrompt).toContain('src/fixture.ts')
    expect(out.fixPrompt).toContain('git checkout origin/dev -- vitest.config.ts src/fixture.ts')
    // 越界的那条仍然原样进 detail(拍板卡和存盘里看得见)。
    expect(out.detail).toContain('scope:vitest.config.ts')
  })

  // 越界那条不能把同一轮里别的问题吞掉:只还原不修,下一轮评审照样把它打回来。
  it('一条 scope: + 一条 critical ⇒ 还原清单和那条 critical 都在提示词里', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"important","file":"vitest.config.ts","summary":"scope:vitest.config.ts 与需求无关"},{"severity":"critical","file":"src/a.ts","line":3,"summary":"新加的那段把错误吞了"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA, 'diff --name-only': 'src/a.ts\nvitest.config.ts\n' }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixPrompt).toContain('git checkout origin/dev -- vitest.config.ts')
    expect(out.fixPrompt).toContain('新加的那段把错误吞了')
    expect(out.detail).toContain('新加的那段把错误吞了')
  })

  // 评审给的「文件名」常常根本不是文件(「scope:与需求无关」的第一个词),
  // 或者是它自己想出来的路径。拿这种东西去 git checkout 只会白烧一轮预算。
  it('scope: 取不到真改过的文件(没写 file / 文件不在 diff 里)⇒ 退回普通修复提示词', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"important","summary":"scope:与需求无关"},{"severity":"important","file":"bogus.ts","summary":"scope:bogus.ts 顺手改的"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA, 'diff --name-only': 'docs/x.md\n' }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixRound).toBe('review')
    expect(out.fixPrompt).toContain('被独立评审判了要改')
    expect(out.fixPrompt).not.toContain('git checkout')
    expect(out.fixPrompt).toContain('scope:与需求无关')
  })

  it('没有 scope: 的 important 还是走原来那份修复提示词', async () => {
    const { deps } = makeFakeDeps({
      runner: () => ({ text: '```json\n{"verdict":"changes","findings":[{"severity":"important","file":"src/a.ts","summary":"错误吞了"}]}\n```' }),
      git: gitReply({ 'rev-parse HEAD': HEAD_SHA }),
    })
    const out = await steps.review(fakeState(), deps)
    expect(out.fixPrompt).toContain('被独立评审判了要改')
    expect(out.fixPrompt).not.toContain('git checkout')
  })

  it('评审会话本身失败 ⇒ review_failed', async () => {
    const { deps } = makeFakeDeps({ runner: () => ({ ok: false, error: 'claude_exit_null' }) })
    expect(await steps.review(fakeState(), deps)).toMatchObject({ ok: false, fail: 'review_failed' })
  })
})

describe('ci', () => {
  it('强推 self 分支 → triage 绿 ⇒ 去拍板', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({ git: gitReply({ 'rev-parse HEAD': HEAD_SHA }) })
    expect(await steps.ci(s, deps)).toEqual({ ok: true, next: 'approval' })
    expect(rec.git[0]).toEqual(['push', '-u', '--force', 'origin', 'self/ab12cd34'])
    expect(s.ci).toEqual({ runId: 42, url: 'https://github.com/x/y/actions/runs/42', verdict: 'green', sha: HEAD_SHA })
  })

  it('不绿 ⇒ 修复轮,prompt 是 triage 的人读输出', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ 'rev-parse HEAD': HEAD_SHA }), ciTriage: o => greenTriage(o.sha, 'real') })
    const out = await steps.ci(fakeState(), deps)
    expect(out.fixRound).toBe('ci')
    expect(out.fixPrompt).toContain('verdict=real')
  })

  it('triage 退 2(没有运行 / 等超时 / gh 出错)⇒ ci_unavailable,不烧修复轮', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ 'rev-parse HEAD': HEAD_SHA }) })
    deps.ciTriage = async o => ({ report: { ...greenTriage(o.sha, 'unknown'), runId: null, url: null }, exitCode: 2 })
    const out = await steps.ci(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'ci_unavailable' })
    expect(out.fixRound).toBeUndefined()
    expect(out.detail).toContain('看不到 CI 结果')
  })

  it('推不上去 ⇒ push_failed', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ push: { code: 1, stderr: 'permission denied' } }) })
    expect(await steps.ci(fakeState(), deps)).toMatchObject({ ok: false, fail: 'push_failed' })
  })
})

describe('approval', () => {
  it('allow ⇒ 去合并;卡片里有需求 / 分支 / CI / 费用', async () => {
    const s = fakeState({ ci: { runId: 1, url: 'https://ci/1', verdict: 'green', sha: HEAD_SHA } })
    s.implement.summary = '把 flake 表补了一行,跑了四条验证全绿'
    s.implement.costUsd = 3.5
    s.review.costUsd = 0.5
    const { deps, rec } = makeFakeDeps({ git: gitReply({ 'diff --stat': ' src/a.ts | 2 +-\n' }) })
    expect(await steps.approval(s, deps)).toEqual({ ok: true, next: 'merge' })
    expect(rec.asks[0]).toContain('给 flake 表加一行')
    expect(rec.asks[0]).toContain('self/ab12cd34 → dev')
    expect(rec.asks[0]).toContain('https://ci/1')
    expect(rec.asks[0]).toContain('$4.00')
    // brief 里向执行者承诺过「最后那段话原样进拍板卡」—— 主人看 diffstat
    // 看不出为什么这么改。
    expect(rec.asks[0]).toContain('执行者说')
    expect(rec.asks[0]).toContain('把 flake 表补了一行,跑了四条验证全绿')
    expect(s.approval).toMatchObject({ hash: 'h1', code: 'AB12', decision: 'allow' })
  })

  // 「四条全绿」是最后的口径,但中间抖过一次的话主人有权在拍板前知道。
  it('抖动重跑过的命令在拍板卡上占一行;没抖过就没有这一行', async () => {
    const s = fakeState()
    s.tests.flakes = ['bun run test', 'npm run test:node -- --reporter=dot']
    const { deps, rec } = makeFakeDeps()
    await steps.approval(s, deps)
    expect(rec.asks[0]).toContain('测试抖动重跑:bun run test、npm run test:node -- --reporter=dot')

    const clean = makeFakeDeps()
    await steps.approval(fakeState(), clean.deps)
    expect(clean.rec.asks[0]).not.toContain('测试抖动重跑')
  })

  it('每 20 秒问一次,pending 期间不动', async () => {
    const { deps, rec } = makeFakeDeps({ decisions: ['pending', 'pending', 'allow'] })
    expect(await steps.approval(fakeState(), deps)).toEqual({ ok: true, next: 'merge' })
    expect(rec.sleeps).toEqual([20_000, 20_000])
  })

  it('deny ⇒ declined', async () => {
    const { deps } = makeFakeDeps({ decisions: ['deny'] })
    expect(await steps.approval(fakeState(), deps)).toMatchObject({ ok: false, fail: 'declined' })
  })

  it('daemon 侧 timeout / undelivered ⇒ approval_timeout', async () => {
    for (const d of ['timeout', 'undelivered'] as const) {
      const { deps } = makeFakeDeps({ decisions: [d] })
      expect(await steps.approval(fakeState(), deps)).toMatchObject({ ok: false, fail: 'approval_timeout' })
    }
  })

  it('unknown 先多问一轮(daemon 可能只是在重启),不急着重发卡', async () => {
    const { deps, rec } = makeFakeDeps({ decisions: ['unknown', 'allow'] })
    expect(await steps.approval(fakeState(), deps)).toEqual({ ok: true, next: 'merge' })
    expect(rec.asks.length).toBe(1)
    expect(rec.sleeps).toEqual([20_000])
  })

  it('连着两次 unknown(卡真丢了)⇒ 重发一次;之后还 unknown 才算超时', async () => {
    const once = makeFakeDeps({ decisions: ['unknown', 'unknown', 'allow'] })
    expect(await steps.approval(fakeState(), once.deps)).toEqual({ ok: true, next: 'merge' })
    expect(once.rec.asks.length).toBe(2)

    const never = makeFakeDeps({ decisions: ['unknown'] })
    expect(await steps.approval(fakeState(), never.deps)).toMatchObject({ ok: false, fail: 'approval_timeout' })
    expect(never.rec.asks.length).toBe(2)
  })

  // 2026-09-18 真机:hash 只在内存里,盘上还是上一轮的结局和旧 hash ——
  // `--approve` 的三道门一道都过不了,第二条拍板口成了哑弹。开卡之后**立刻**落盘。
  it('开卡之后立刻落盘:等人的这段时间里,盘上就能查到 hash', async () => {
    const store = memoryStore()
    const { deps } = makeFakeDeps({ state: store, decisions: ['pending', 'allow'] })
    const s = fakeState({ step: 'approval' })
    // 轮询到 allow 之前,盘上必须已经是一条「活的、停在 approval、hash 在」的记录。
    let seen: SelfChangeState | null = null
    const orig = deps.sleep
    deps.sleep = async ms => { seen ??= store.load(s.id); await orig(ms) }
    expect(await steps.approval(s, deps)).toEqual({ ok: true, next: 'merge' })
    expect(seen).toMatchObject({ step: 'approval', result: null, approval: { hash: 'h1', code: 'AB12', delivered: true } })
    expect(seen!.approval.askedAt).not.toBeNull()
  })

  it('重发卡换了 hash ⇒ 新 hash 也立刻落盘(旧的已经没人认了)', async () => {
    const store = memoryStore()
    const { deps } = makeFakeDeps({ state: store, decisions: ['unknown', 'unknown', 'allow'] })
    const s = fakeState({ step: 'approval' })
    const saved: Array<string | null> = []
    const orig = deps.sleep
    deps.sleep = async ms => { saved.push(store.load(s.id)?.approval.hash ?? null); await orig(ms) }
    expect(await steps.approval(s, deps)).toEqual({ ok: true, next: 'merge' })
    expect(saved).toEqual(['h1', 'h2'])
  })

  // 2026-09-18 真机:CI 全绿之后拍板卡撞上 errcode=-2,整条白等到 approval_timeout。
  // 现在条目留在 daemon 的登记处,只是人不知道 —— 所以要在终端和微信各说一句
  // 还有哪两条路能拍,然后照常轮询(决定仍旧是 pending,不提前收工)。
  it('delivered:false ⇒ 记进 state、说一句别的拍板口,照常等主人', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps({
      ask: () => ({ hash: 'h1', code: 'AB12', delivered: false }),
      decisions: ['pending', 'allow'],
    })
    const logs: string[] = []
    deps.log = l => { logs.push(l) }
    expect(await steps.approval(s, deps)).toEqual({ ok: true, next: 'merge' })
    expect(s.approval.delivered).toBe(false)
    const line = `微信卡没送到(外发不通);桌面权限卡或终端 wechat-cc self change --approve ${s.id} 都能拍板`
    expect(logs).toContain(line)
    expect(rec.notices).toContain(line)
    expect(s.notices).toContain(line)
    // 照常轮询,没有提前收工。
    expect(rec.sleeps).toEqual([20_000])
  })

  it('delivered:true ⇒ 一句多余的话都不说', async () => {
    const { deps, rec } = makeFakeDeps({ decisions: ['allow'] })
    await steps.approval(fakeState(), deps)
    expect(rec.notices).toEqual([])
  })

  it('卡根本发不出去 ⇒ owner_chat_unknown(blocked)', async () => {
    const { deps } = makeFakeDeps({ ask: () => null })
    expect(await steps.approval(fakeState(), deps)).toMatchObject({ ok: false, fail: 'owner_chat_unknown' })
  })

  it('等过了点 ⇒ approval_timeout', async () => {
    let now = 1_700_000_000_000
    const { deps } = makeFakeDeps({ decisions: ['pending'], now: () => (now += 40_000) })
    expect(await steps.approval(fakeState(), deps)).toMatchObject({ ok: false, fail: 'approval_timeout' })
  })
})

describe('merge', () => {
  it('rebase 冲突 ⇒ abort + merge_conflict,不碰 dev', async () => {
    const { deps, rec } = makeFakeDeps({ git: gitReply({ 'rebase origin/dev': { code: 1, stderr: 'CONFLICT (content)' } }) })
    const out = await steps.merge(fakeState(), deps)
    expect(out).toMatchObject({ ok: false, fail: 'merge_conflict' })
    expect(rec.git.some(a => a.join(' ') === 'rebase --abort')).toBe(true)
    expect(rec.git.some(a => a.includes('--ff-only'))).toBe(false)
  })

  it('顺序:fetch → rebase → checkout → reset → ff-only → push → 删远端分支', async () => {
    const s = fakeState({ ci: { runId: 1, url: null, verdict: 'green', sha: HEAD_SHA } })
    const { deps, rec } = makeFakeDeps({ git: gitReply({ 'rev-parse HEAD': HEAD_SHA }) })
    expect(await steps.merge(s, deps)).toEqual({ ok: true, next: 'deploy' })
    expect(rec.git.map(a => a.join(' '))).toEqual([
      'fetch origin', 'rebase origin/dev', 'rev-parse HEAD',
      'checkout dev', 'reset --hard origin/dev', 'merge --ff-only self/ab12cd34',
      'push origin dev', 'rev-parse HEAD', 'push origin --delete self/ab12cd34',
    ])
    expect(s.merge).toEqual({ sha: HEAD_SHA, rebased: false })
    expect(rec.notices[0]).toContain('已合入 dev')
  })

  it('rebase 动了 HEAD ⇒ 记 rebased(报告里要说 CI 跑的不是这个 sha)', async () => {
    const s = fakeState({ ci: { runId: 1, url: null, verdict: 'green', sha: 'd'.repeat(40) } })
    const { deps } = makeFakeDeps({ git: gitReply({ 'rev-parse HEAD': HEAD_SHA }) })
    await steps.merge(s, deps)
    expect(s.merge.rebased).toBe(true)
  })

  it('删远端分支失败只记一笔,不影响结果', async () => {
    const { deps } = makeFakeDeps({ git: gitReply({ '--delete': { code: 1, stderr: 'remote ref does not exist' } }) })
    expect(await steps.merge(fakeState(), deps)).toMatchObject({ ok: true, next: 'deploy' })
  })

  it('--no-deploy ⇒ 合完直接去写报告', async () => {
    const { deps, rec } = makeFakeDeps()
    expect(await steps.merge(fakeState({ noDeploy: true }), deps)).toEqual({ ok: true, next: 'report' })
    expect(rec.notices[0]).toContain('不部署')
  })
})

describe('deploy', () => {
  it('build-sidecar 红 ⇒ deploy_failed + fail_streak+1', async () => {
    const { deps, rec } = makeFakeDeps({ exec: () => ({ code: 1, stderr: '编译错误' }) })
    expect(await steps.deploy(fakeState(), deps)).toMatchObject({ ok: false, fail: 'deploy_failed' })
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
    expect(deps.config.failStreak).toBe(1)
  })

  it('部署失败 ⇒ deploy_failed + fail_streak+1', async () => {
    const { deps, rec } = makeFakeDeps({ deploy: { ok: false, exitCode: 1, steps: [{ name: '健康门', ok: false, detail: '起不来' }], diagnostics: 'x' } })
    expect(await steps.deploy(fakeState(), deps)).toMatchObject({ ok: false, fail: 'deploy_failed' })
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
  })

  it('部署注入件**抛异常**(launchagent 不对 / 非 darwin)⇒ 也是 deploy_failed + fail_streak+1', async () => {
    // 不接住的话异常跑到 run.ts 的兜底记成 crashed,而 crashed 既不加
    // fail_streak 也不停机 —— 停机护栏会在最该生效的那天整条失效。
    const s = fakeState()
    const { deps, rec } = makeFakeDeps()
    deps.deploy = async () => { throw new Error('launchagent_not_found') }
    const out = await steps.deploy(s, deps)
    expect(out).toMatchObject({ ok: false, fail: 'deploy_failed' })
    expect(out.detail).toContain('launchagent_not_found')
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
    expect(deps.config.failStreak).toBe(1)
    expect(s.deploy.ok).toBe(false)
  })

  it('成功 ⇒ 去自检,版本记进 state', async () => {
    const s = fakeState()
    const { deps, rec } = makeFakeDeps()
    expect(await steps.deploy(s, deps)).toEqual({ ok: true, next: 'selftest' })
    expect(rec.exec[0]).toEqual(['bun', 'run', 'build-sidecar'])
    // 在克隆的 apps/desktop 里跑,不是仓库根。
    expect(rec.execOpts[0]?.cwd).toBe(join('/w', 'repo', 'apps', 'desktop'))
    expect(rec.execOpts[0]?.timeoutMs).toBeGreaterThan(0)
    expect(s.deploy).toEqual({ ok: true, version: '1.2.3' })
  })
})

describe('selftest', () => {
  it('一项红 ⇒ 回滚二进制 + fail_streak+1,并说清 dev 上的提交要人处理', async () => {
    const s = fakeState({ merge: { sha: HEAD_SHA, rebased: false } })
    const { deps, rec } = makeFakeDeps({ selftest: { workbench: true, chat: false } })
    const out = await steps.selftest(s, deps)
    expect(out).toMatchObject({ ok: false, fail: 'selftest_failed_rolled_back' })
    expect(out.detail).toContain('dev 上的提交 aaaaaaaa 还在,需要人处理')
    expect(rec.rolledBack).toEqual([join('/w', 'repo')])
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
    expect(s.selftest).toEqual({ workbench: true, chat: false })
  })

  it('自检注入件**抛异常** ⇒ 照样回滚 + fail_streak+1(跑不出结果 = 新二进制不可信)', async () => {
    const s = fakeState({ merge: { sha: HEAD_SHA, rebased: false } })
    const { deps, rec } = makeFakeDeps()
    deps.selftest = async () => { throw new Error('workbench 起不来') }
    const out = await steps.selftest(s, deps)
    expect(out).toMatchObject({ ok: false, fail: 'selftest_failed_rolled_back' })
    expect(out.detail).toContain('workbench 起不来')
    expect(out.detail).toContain('dev 上的提交 aaaaaaaa 还在,需要人处理')
    expect(rec.rolledBack).toEqual([join('/w', 'repo')])
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
  })

  it('回滚自己也抛 ⇒ deploy_failed + fail_streak+1,话说到「要人手工换回 .prev」', async () => {
    const s = fakeState({ merge: { sha: HEAD_SHA, rebased: false } })
    const { deps, rec } = makeFakeDeps({ selftest: { workbench: false, chat: true } })
    deps.rollback = async () => { throw new Error('launchagent_not_app_bundle') }
    const out = await steps.selftest(s, deps)
    expect(out).toMatchObject({ ok: false, fail: 'deploy_failed' })
    expect(out.detail).toContain('launchagent_not_app_bundle')
    expect(out.detail).toContain('.prev')
    expect(out.detail).toContain('dev 上的提交 aaaaaaaa 还在,需要人处理')
    expect(rec.patches).toEqual([{ fail_streak: 1 }])
  })

  it('全绿 ⇒ fail_streak 清零', async () => {
    const { deps, rec } = makeFakeDeps({ config: { failStreak: 1 } })
    expect(await steps.selftest(fakeState(), deps)).toEqual({ ok: true, next: 'report' })
    expect(rec.patches).toEqual([{ fail_streak: 0 }])
  })

  it('本来就是 0 就不写配置(别每条自改都去动 agent-config)', async () => {
    const { deps, rec } = makeFakeDeps()
    await steps.selftest(fakeState(), deps)
    expect(rec.patches).toEqual([])
  })
})

describe('report', () => {
  it('汇总一条:结果 / sha / 费用 / 自检两项', async () => {
    const s = fakeState({ merge: { sha: HEAD_SHA, rebased: false }, selftest: { workbench: true, chat: true } })
    s.implement.costUsd = 2
    s.review.costUsd = 1
    const { deps, rec } = makeFakeDeps()
    expect(await steps.report(s, deps)).toEqual({ ok: true, next: 'done' })
    expect(rec.notices[0]).toContain('自改 #ab12cd34 完成')
    expect(rec.notices[0]).toContain('$3.00')
    expect(rec.notices[0]).toContain('工作台 绿 · 对话 绿')
  })

  it('抖动重跑过的命令在收尾报告里也占一行', async () => {
    const s = fakeState({ merge: { sha: HEAD_SHA, rebased: false } })
    s.tests.flakes = ['bun run test']
    const { deps, rec } = makeFakeDeps()
    await steps.report(s, deps)
    expect(rec.notices[0]).toContain('测试抖动重跑:bun run test')
  })

  it('CI 跑的 sha 和合入的不一样时要说出来', async () => {
    const s = fakeState({ ci: { runId: 1, url: null, verdict: 'green', sha: 'd'.repeat(40) }, merge: { sha: HEAD_SHA, rebased: true } })
    const { deps, rec } = makeFakeDeps()
    await steps.report(s, deps)
    expect(rec.notices[0]).toContain('rebase 过,没有重跑 CI')
  })
})
