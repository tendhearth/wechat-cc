/**
 * 真 git 的整合测:临时 bare 远端 + 真克隆,把一条自改从 intake 跑到 report。
 *
 * 只有执行者 / 测试命令 / CI / 拍板 / 部署 / 自检是假的 —— **git 是真的**,
 * 因为这条流水线最容易错的地方全在 git 上(checkout -B、rebase、ff-only、
 * 删远端分支的顺序)。假 git 的单测只能证明「调用顺序没变」,证明不了
 * 「dev 上真的有这两个文件」。
 *
 * darwin / linux 跑;win32 跳过(流水线本身就是 darwin-only,spec §非目标)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../lib/test-temp'
import { makeGit, nodeGitSpawnSync } from './git'
import { fakeState, makeFakeDeps, runnerOk, type FakeOpts } from './pipeline.fixture'
import { runSelfChange } from './run'
import type { RunnerInput, RunnerResult } from './runner'

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
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'self-change-int-'))
    remote = join(root, 'remote.git')
    workdir = join(root, 'work')
    repo = join(workdir, 'repo')

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
        // 克隆是流水线现做的,里面没有身份;后面的 rebase 要用。
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
      // `bun run test` 第一次红,之后绿。
      exec: (cmd, args) => (cmd === 'bun' && args[1] === 'test' && testRuns++ === 0
        ? { code: 1, stdout: 'FAIL src/a.test.ts > 一条新用例\nAssertionError: expected 1 to be 2' }
        : undefined),
      ...over,
    })
    made.deps.git = makeGit(nodeGitSpawnSync, repo)
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

  it('克隆已经在了(上一条留下的脏工作树)⇒ 照样 fetch + 洗干净再开工', async () => {
    // 先跑一条,留下克隆;再在克隆里丢一个没人要的文件。
    const first = pipeline({ decisions: ['allow'] })
    expect((await runSelfChange(fakeState(), first.deps)).exitCode).toBe(0)
    writeFileSync(join(repo, '垃圾.txt'), '上一条中断时留下的\n')

    const second = pipeline({ decisions: ['allow'] })
    const { state, exitCode } = await runSelfChange(fakeState({ id: 'ff00ff00' }), second.deps)
    expect(exitCode).toBe(0)
    expect(state.result).toBe('done')
    expect(existsSync(join(repo, '垃圾.txt'))).toBe(false)
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'dev'])).not.toContain('垃圾')
  })
})
