/**
 * 真 git 的整合测:临时 bare 远端 + 真中枢克隆 + 每条运行一个工作树,
 * 把一条自改从 intake 跑到 report。
 *
 * 只有执行者 / 测试命令 / CI / 拍板 / 部署 / 自检是假的 —— **git 是真的**,
 * 因为这条流水线最容易错的地方全在 git 上(worktree add、rebase、快进 push、
 * 删远端分支的顺序)。假 git 的单测只能证明「调用顺序没变」,证明不了
 * 「dev 上真的有这两个文件」、更证明不了「两条运行的树互不影响」。
 *
 * darwin / linux 跑;win32 跳过(流水线本身就是 darwin-only,spec §非目标)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../lib/test-temp'
import { makeGit, nodeGitSpawnSync } from './git'
import { fakeState, makeFakeDeps, runnerOk, type FakeOpts } from './pipeline.fixture'
import { runSelfChange } from './run'
import type { RunnerInput, RunnerResult } from './runner'
import { steps } from './steps'

const skipOnWindows = process.platform === 'win32'

/** CI 的 runner 上没有全局身份,每条都自带一份。 */
const IDENTITY = ['-c', 'user.email=self-change@example.com', '-c', 'user.name=self change test']

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}) → ${r.status}\n${r.stderr}`)
  return r.stdout
}

const IMPORTANT = '```json\n{"verdict":"changes","findings":[{"severity":"important","file":"docs/x.md","summary":"少了一句为什么"}]}\n```'
const APPROVE = '```json\n{"verdict":"approve","findings":[{"severity":"minor","summary":"措辞可以再紧一点"}]}\n```'

describe.skipIf(skipOnWindows)('self change 整条(真 git)', () => {
  let root: string
  let remote: string
  let workdir: string
  /** 中枢克隆:只 fetch,不在里面构建。 */
  let hub: string
  /** 这条运行自己的工作树。 */
  let runDir: (id: string) => string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'self-change-int-'))
    remote = join(root, 'remote.git')
    workdir = join(root, 'work')
    hub = join(workdir, 'repo')
    runDir = (id: string) => join(workdir, 'runs', id)

    git(root, ['init', '--bare', 'remote.git'])
    // 远端 HEAD 指向 dev,克隆出来才不会落在一个不存在的默认分支上。
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])

    const seed = join(root, 'seed')
    git(root, ['clone', remote, 'seed'])
    writeFileSync(join(seed, 'AGENTS.md'), '# wechat-cc\n\n只在 dev 上干活。\n')
    writeFileSync(join(seed, 'package.json'), '{\n  "name": "wechat-cc-seed"\n}\n')
    git(seed, ['add', '-A'])
    git(seed, ['commit', '-m', '种子提交'])
    git(seed, ['push', 'origin', 'HEAD:refs/heads/dev'])
  })

  afterEach(() => { removeTempDir(root) })

  /**
   * 执行者假件:真的在克隆里写文件并提交(`resume` 那轮写另一个文件)。
   * 每次新建带一个序号 —— 同一个远端上跑第二条时,写的内容必须和上一条不同,
   * 不然 `git commit` 会以「没有东西可提交」失败。
   */
  let runnerSeq = 0
  function fakeRunner(opts: { forbidden?: boolean } = {}): { run: (i: RunnerInput) => Promise<RunnerResult> } {
    let reviews = 0
    let fixes = 0
    const nonce = ++runnerSeq
    return {
      run: async (input: RunnerInput): Promise<RunnerResult> => {
        if (input.readOnly) {
          // 第一次判要改,第二次放行。
          return runnerOk({ sessionId: 'review-1', text: reviews++ === 0 ? IMPORTANT : APPROVE, costUsd: 0.5 })
        }
        // 工作树是流水线现开的,里面没有身份;后面的 rebase 要用。
        git(input.cwd, ['config', 'user.email', 'self-change@example.com'])
        git(input.cwd, ['config', 'user.name', 'self change test'])

        if (opts.forbidden) {
          mkdirSync(join(input.cwd, 'src', 'cli'), { recursive: true })
          writeFileSync(join(input.cwd, 'src', 'cli', 'self-deploy.ts'), '// 把回滚删了\n')
        } else if (input.resume) {
          fixes += 1
          mkdirSync(join(input.cwd, 'docs'), { recursive: true })
          const file = join(input.cwd, 'docs', 'y.md')
          writeFileSync(file, `${existsSync(file) ? readFileSync(file, 'utf8') : ''}第 ${nonce} 条的修复轮 ${fixes}\n`)
        } else {
          mkdirSync(join(input.cwd, 'docs'), { recursive: true })
          writeFileSync(join(input.cwd, 'docs', 'x.md'), `# 新文档(第 ${nonce} 条)\n`)
        }
        git(input.cwd, ['add', '-A'])
        git(input.cwd, ['commit', '-m', input.resume ? `修复轮 ${fixes}` : '执行者:加 docs/x.md'])
        return runnerOk({ sessionId: 'sess-1', costUsd: 1 })
      },
    }
  }

  function pipeline(over: FakeOpts & { forbidden?: boolean } = {}): ReturnType<typeof makeFakeDeps> {
    let testRuns = 0
    const made = makeFakeDeps({
      config: { repoUrl: remote, workdir, branch: 'dev' },
      // `bun run test` 头两次红,之后绿。两次是因为红的文件(src/a.test.ts)跟这次
      // 改的文件(docs/x.md)不沾边 —— tests 闸门会先原样重跑一次确认不是抖动,
      // 第二次还红才算真红、才进修复轮(v1.1b)。
      exec: (cmd, args) => (cmd === 'bun' && args[1] === 'test' && testRuns++ < 2
        ? { code: 1, stdout: 'FAIL src/a.test.ts > 一条新用例\nAssertionError: expected 1 to be 2' }
        : undefined),
      ...over,
    })
    // 缺省 cwd 只是兜底:每一步都显式传自己该在的目录(中枢 or 工作树)。
    made.deps.git = makeGit(nodeGitSpawnSync, hub)
    made.deps.fs = {
      exists: p => existsSync(p),
      writeFile: (p, s) => { writeFileSync(p, s) },
      mkdirp: p => { mkdirSync(p, { recursive: true }) },
    }
    made.deps.runner = fakeRunner({ ...(over.forbidden ? { forbidden: true } : {}) })
    return made
  }

  function remoteBranches(): string {
    return git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
  }

  it('修一轮测试、修一轮评审,拍板放行 ⇒ 两个文件都在远端 dev 上,self 分支删掉', async () => {
    const { deps, rec } = pipeline({ decisions: ['pending', 'pending', 'allow'] })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(state.result).toBe('done')
    expect(exitCode).toBe(0)
    expect(state.implement.rounds).toEqual({ tests: 1, review: 1, ci: 0 })

    const tree = git(remote, ['ls-tree', '-r', '--name-only', 'dev'])
    expect(tree).toContain('docs/x.md')
    expect(tree).toContain('docs/y.md')
    // ff-only:种子那条提交还在,dev 上多了三条(实现 + 两轮修复)。
    expect(git(remote, ['rev-list', '--count', 'dev']).trim()).toBe('4')
    expect(git(remote, ['rev-parse', 'dev']).trim()).toBe(state.merge.sha)

    expect(remoteBranches()).not.toContain('self/')

    const heads = rec.notices.map(n => n.split('\n')[0] ?? '')
    expect(heads[0]).toContain('开始')
    expect(heads.some(h => h.includes('已合入 dev'))).toBe(true)
    expect(heads.at(-1)).toContain('完成')
    // 拍板卡里有真 diffstat。
    expect(rec.asks[0]).toContain('docs/')
    expect(rec.sleeps).toEqual([20_000, 20_000])
  })

  it('主人回 n ⇒ declined,远端 dev 一个字没动(self 分支留着给人看)', async () => {
    const before = git(remote, ['rev-parse', 'dev']).trim()
    const { deps } = pipeline({ decisions: ['deny'] })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(state.result).toBe('declined')
    expect(exitCode).toBe(3)
    expect(git(remote, ['rev-parse', 'dev']).trim()).toBe(before)
    expect(remoteBranches()).toContain('refs/heads/self/ab12cd34')
  })

  it('碰了禁改清单 ⇒ forbidden_paths:不跑测试、不推分支、dev 没动', async () => {
    const before = git(remote, ['rev-parse', 'dev']).trim()
    const { deps, rec } = pipeline({ forbidden: true })
    const { state, exitCode } = await runSelfChange(fakeState(), deps)

    expect(state.result).toBe('forbidden_paths')
    expect(state.error).toContain('src/cli/self-deploy.ts')
    expect(exitCode).toBe(1)
    expect(git(remote, ['rev-parse', 'dev']).trim()).toBe(before)
    expect(remoteBranches()).not.toContain('self/')
    expect(rec.exec.some(c => c.join(' ').includes('run test'))).toBe(false)
  })

  // 一次运行一个工作树 —— 这条整合测钉的就是根因本身:B 的 `repo` 步不能在
  // A 的树底下把文件换掉(2026-09-21 审查 #4)。
  it('两条运行并存:各自一个工作树,A 的东西 B 看不见', async () => {
    const a = pipeline()
    expect(await steps.repo(fakeState({ id: 'aaaa1111' }), a.deps)).toMatchObject({ ok: true })
    const treeA = runDir('aaaa1111')
    writeFileSync(join(treeA, 'a-only.md'), 'A 的改动\n')
    git(treeA, ['add', '-A'])
    git(treeA, ['commit', '-m', 'A 的提交'])
    const headA = git(treeA, ['rev-parse', 'HEAD']).trim()

    const b = pipeline()
    expect(await steps.repo(fakeState({ id: 'bbbb2222' }), b.deps)).toMatchObject({ ok: true })
    const treeB = runDir('bbbb2222')

    // A 的树一个字没动:文件还在、HEAD 还是 A 那条提交、还站在 A 的分支上。
    expect(existsSync(join(treeA, 'a-only.md'))).toBe(true)
    expect(git(treeA, ['rev-parse', 'HEAD']).trim()).toBe(headA)
    expect(git(treeA, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('self/aaaa1111')
    // B 的树里没有 A 的东西,站在自己的分支上。
    expect(existsSync(join(treeB, 'a-only.md'))).toBe(false)
    expect(git(treeB, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('self/bbbb2222')
    // 中枢里两个都登记着,而中枢自己不动(还在 dev 上)。
    const list = git(hub, ['worktree', 'list'])
    expect(list).toContain(treeA)
    expect(list).toContain(treeB)
    expect(git(hub, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('dev')
  })

  // 恢复:工作树被人 `rm -rf` 掉了(或者是一条很老的运行,已经被顺手清理过)。
  // 老代码是「把共用克隆钉回批准的提交」,现在是「按批准的提交重开一个工作树」。
  it('`--resume` 在工作树被删之后:按批准的那条重建再部署', async () => {
    const first = pipeline({ decisions: ['allow'] })
    const done = await runSelfChange(fakeState(), first.deps)
    expect(done.state.result).toBe('done')
    const approved = done.state.merge.sha
    expect(approved).toBeTruthy()

    rmSync(runDir('ab12cd34'), { recursive: true, force: true })

    const second = pipeline()
    let builtAt = ''
    const exec = second.deps.exec
    second.deps.exec = async (cmd, args, o) => {
      if (args.includes('build-sidecar')) builtAt = git(runDir('ab12cd34'), ['rev-parse', 'HEAD']).trim()
      return await exec(cmd, args, o)
    }
    const resumed = fakeState({ step: 'deploy', result: 'deploy_failed', merge: { sha: approved, rebased: false } })
    const { state, exitCode } = await runSelfChange(resumed, second.deps)

    expect(exitCode).toBe(0)
    expect(state.result).toBe('done')
    // 构建的是批准的那条,在重建出来的那棵树里。
    expect(builtAt).toBe(approved)
    expect(state.deploy.sha).toBe(approved)
    expect(second.rec.deployed).toEqual([runDir('ab12cd34')])
  })

  it('批准的那条已经不在了(被 force-push 抹掉)⇒ 工作树重建不出来,不构建不部署', async () => {
    const first = pipeline({ decisions: ['allow'] })
    expect((await runSelfChange(fakeState(), first.deps)).state.result).toBe('done')
    const gone = 'd'.repeat(40)

    const second = pipeline()
    const resumed = fakeState({ id: 'cc22cc22', step: 'deploy', result: 'deploy_failed', merge: { sha: gone, rebased: false } })
    const { state, exitCode } = await runSelfChange(resumed, second.deps)

    expect(state.result).toBe('deploy_tree_mismatch')
    expect(exitCode).toBe(1)
    expect(state.error).toContain(gone)
    expect(second.rec.exec.some(c => c.includes('build-sidecar'))).toBe(false)
    expect(second.rec.deployed).toEqual([])
  })

  it('中枢克隆已经在了 ⇒ fetch 一遍再开新工作树;上一条留在自己树里的垃圾碰不到这一条', async () => {
    // 先跑一条,留下中枢克隆和它自己的工作树;再在那棵树里丢一个没人要的文件。
    const first = pipeline({ decisions: ['allow'] })
    expect((await runSelfChange(fakeState(), first.deps)).exitCode).toBe(0)
    writeFileSync(join(runDir('ab12cd34'), '垃圾.txt'), '上一条中断时留下的\n')

    const second = pipeline({ decisions: ['allow'] })
    const { state, exitCode } = await runSelfChange(fakeState({ id: 'ff00ff00' }), second.deps)
    expect(exitCode).toBe(0)
    expect(state.result).toBe('done')
    // 新工作树是干净的;而那份垃圾还老实待在上一条自己的树里(谁也没被清)。
    expect(existsSync(join(runDir('ff00ff00'), '垃圾.txt'))).toBe(false)
    expect(existsSync(join(runDir('ab12cd34'), '垃圾.txt'))).toBe(true)
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'dev'])).not.toContain('垃圾')
  })
})
