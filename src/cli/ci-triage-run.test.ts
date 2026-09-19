/**
 * ci-triage-run.test.ts —— 外壳的行为,全部用假 `exec` 跑,不碰 gh / git / 网络。
 *
 * 这里测的不是分类规则(那是 ci-triage.test.ts 的事),而是**外壳把哪些命令、
 * 按什么顺序、用什么参数发出去**,以及退出码。两条特别值得钉住:
 *   ① `gh run list --commit` 必须用 40 位 SHA —— 短 sha 查不到任何东西,而且
 *      是**安静地**返回空数组,看上去就像「这次推送没有 CI」。
 *   ② 判成 flake 后重跑,第二轮仍红一律改判 real(连着两次红的 flake 当真的看)。
 */
import { describe, it, expect } from 'vitest'
import { runCiTriage, CI_TRIAGE_EXIT, type CiTriageDeps } from './ci-triage-run'
import type { FlakeRegistry } from './ci-triage'

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const BASE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const RUN_ID = 35173091848
const WIN_JOB_ID = 99887766
const URL = `https://github.com/o/r/actions/runs/${RUN_ID}`

// 本地登记表,不读仓库里的 ci-flakes.json —— 测的是外壳,不该在有人给登记表
// 加/删条目时跟着红。
const registry: FlakeRegistry = {
  entries: [
    {
      id: 'win-hook-timeout',
      jobs: ['build · windows-latest'],
      symptom: 'Hook timed out in \\d+ms',
      note: 'windows runner 磁盘 I/O 慢',
      since: '2026-09-16',
    },
  ],
}

/** `gh run view --job … --log-failed` 的真实行格式:`<job>\t<step>\t<ISO> <文本>`。 */
function ghLog(job: string, step: string, lines: string[]): string {
  return lines
    .map((l, i) => `${job}\t${step}\t2026-09-18T10:00:${String(i).padStart(2, '0')}.000Z ${l}`)
    .join('\n')
}

function runListRow(over: Partial<{ status: string; conclusion: string | null }> = {}) {
  return JSON.stringify([
    {
      databaseId: RUN_ID,
      status: 'completed',
      conclusion: 'failure',
      headSha: SHA,
      url: URL,
      createdAt: '2026-09-18T10:00:00Z',
      ...over,
    },
  ])
}

const WIN_JOBS = JSON.stringify({
  jobs: [
    {
      name: 'build · ubuntu-latest',
      databaseId: 1,
      conclusion: 'success',
      steps: [{ name: 'Run tests', conclusion: 'success' }],
    },
    {
      name: 'build · windows-latest',
      databaseId: WIN_JOB_ID,
      conclusion: 'failure',
      steps: [
        { name: 'Install dependencies', conclusion: 'success' },
        { name: 'Run tests', conclusion: 'failure' },
      ],
    },
  ],
})

const FLAKE_LOG = ghLog('build · windows-latest', 'Run tests', [
  ' FAIL  src/core/workbench/service.test.ts > workbench service > starts',
  'Hook timed out in 10000ms',
  ' Test Files  1 failed | 900 passed',
])

const REAL_LOG = ghLog('build · windows-latest', 'Run tests', [
  ' FAIL  src/cli/selftest.test.ts > selftest workbench > basename',
  'AssertionError: expected undefined to be "wb-1"',
  ' Test Files  1 failed | 900 passed',
])

type Res = { code: number | null; stdout: string; stderr: string }
type Handler = (line: string) => string | Res | undefined

/** 假 exec:按整条命令行分派。返回字符串 = stdout + code 0;undefined = 空且成功。 */
function harness(handler: Handler, over: Partial<CiTriageDeps> = {}) {
  const calls: string[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  let clock = 0
  const deps: CiTriageDeps = {
    exec: (cmd, args) => {
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      const r = handler(line)
      if (r === undefined) return { code: 0, stdout: '', stderr: '' }
      if (typeof r === 'string') return { code: 0, stdout: r, stderr: '' }
      return r
    },
    sleep: async (ms) => { clock += ms; sleeps.push(ms) },
    now: () => clock,
    log: (l) => { logs.push(l) },
    registry,
    cwd: '/repo',
    ...over,
  }
  return { deps, calls, sleeps, logs }
}

/** 一次「失败的 run」的完整路由表;`log` 决定这次是 flake 还是真红。 */
function failedRunHandler(log: string, changed: string): Handler {
  return (line) => {
    if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
    if (line === 'git rev-parse --abbrev-ref HEAD') return 'dev\n'
    if (line.startsWith('gh run list --commit')) return runListRow()
    if (line.startsWith('gh run view') && line.includes('--json jobs')) return WIN_JOBS
    if (line.startsWith('gh run list --branch')) return JSON.stringify([{ headSha: BASE, conclusion: 'success' }])
    if (line.startsWith('git merge-base --is-ancestor')) return { code: 0, stdout: '', stderr: '' }
    if (line.startsWith('git diff --name-only')) return changed
    if (line.includes('--log-failed')) return log
    return undefined
  }
}

describe('runCiTriage', () => {
  it('绿:conclusion success ⇒ verdict green,退出 0,不去拉任何日志', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ conclusion: 'success' })
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(report.verdict).toBe('green')
    expect(report.runId).toBe(RUN_ID)
    expect(report.url).toBe(URL)
    expect(exitCode).toBe(CI_TRIAGE_EXIT.green)
    expect(h.calls.some(c => c.includes('--log-failed'))).toBe(false)
  })

  it('`gh run list --commit` 用的是 40 位 SHA(短 sha 会安静地查不到任何东西)', async () => {
    const h = harness((line) => {
      if (line === 'git rev-parse 25113589') return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ conclusion: 'success' })
      return undefined
    })
    await runCiTriage(h.deps, { sha: '25113589' })
    const listCall = h.calls.find(c => c.startsWith('gh run list --commit'))!
    expect(listCall).toContain(`--commit ${SHA}`)
    expect(listCall.split(' ')[4]).toHaveLength(40)
    expect(listCall).toContain('--workflow CI')
  })

  it('真红:失败的测试文件本轮动过 ⇒ verdict real,退出 1', async () => {
    const h = harness(failedRunHandler(REAL_LOG, 'src/cli/selftest.ts\ndocs/x.md\n'))
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(report.verdict).toBe('real')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.real)
    expect(report.base).toBe(BASE)
    expect(report.changedFiles).toEqual(['src/cli/selftest.ts', 'docs/x.md'])
    expect(report.jobs).toHaveLength(1)
    expect(report.jobs[0]!.name).toBe('build · windows-latest')
    expect(report.jobs[0]!.step).toBe('Run tests')
    expect(report.jobs[0]!.classified[0]!.failure?.file).toBe('src/cli/selftest.test.ts')
  })

  it('flake 但没给 --rerun ⇒ verdict flake,退出 3,没有发出 rerun', async () => {
    const h = harness(failedRunHandler(FLAKE_LOG, 'docs/x.md\n'))
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(report.verdict).toBe('flake')
    expect(report.reruns).toBe(0)
    expect(exitCode).toBe(CI_TRIAGE_EXIT.flake)
    expect(h.calls.some(c => c.startsWith('gh run rerun'))).toBe(false)
  })

  it('flake + --rerun + --wait:重跑一次,第二轮仍红一律改判 real(退出 1)', async () => {
    const h = harness((line) => {
      const base = failedRunHandler(FLAKE_LOG, 'docs/x.md\n')(line)
      if (line.startsWith('gh run view') && line.includes('--json status,conclusion')) {
        return JSON.stringify({ status: 'completed', conclusion: 'failure' })
      }
      return base
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA, rerun: true, wait: true })
    expect(h.calls).toContain(`gh run rerun ${RUN_ID} --failed`)
    expect(report.reruns).toBe(1)
    // 第二轮同一条 flake 症状,但 secondRun ⇒ real。
    expect(report.verdict).toBe('real')
    expect(report.jobs[0]!.classified[0]!.kind).toBe('real')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.real)
    // 只重跑一次(缺省 max-reruns=1),不会打转。
    expect(h.calls.filter(c => c.startsWith('gh run rerun'))).toHaveLength(1)
  })

  it('flake + --rerun 但没 --wait:重跑了就收工,verdict 仍是 flake(退出 3)', async () => {
    const h = harness(failedRunHandler(FLAKE_LOG, 'docs/x.md\n'))
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA, rerun: true })
    expect(h.calls).toContain(`gh run rerun ${RUN_ID} --failed`)
    expect(report.reruns).toBe(1)
    expect(report.verdict).toBe('flake')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.flake)
  })

  it('--wait:in_progress 一直轮询到 completed,每 30s 一次', async () => {
    let views = 0
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ status: 'in_progress', conclusion: null })
      if (line.startsWith('gh run view') && line.includes('--json status,conclusion')) {
        views++
        return views < 3
          ? JSON.stringify({ status: 'in_progress', conclusion: null })
          : JSON.stringify({ status: 'completed', conclusion: 'success' })
      }
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA, wait: true })
    expect(views).toBe(3)
    expect(h.sleeps).toEqual([30_000, 30_000])
    expect(report.verdict).toBe('green')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.green)
  })

  it('--wait:gh 抖一次(TLS 超时)不放弃,下一次问到 completed 照样给结论', async () => {
    let views = 0
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ status: 'in_progress', conclusion: null })
      if (line.startsWith('gh run view') && line.includes('--json status,conclusion')) {
        views++
        if (views === 1) return { code: 1, stdout: '', stderr: 'failed to get run: net/http: TLS handshake timeout' }
        return JSON.stringify({ status: 'completed', conclusion: 'success' })
      }
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA, wait: true })
    expect(views).toBe(2)
    expect(report.verdict).toBe('green')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.green)
  })

  it('--wait:gh 连错 4 次才算真出错(退出 2)', async () => {
    let views = 0
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ status: 'in_progress', conclusion: null })
      if (line.startsWith('gh run view') && line.includes('--json status,conclusion')) {
        views++
        return { code: 1, stdout: '', stderr: 'TLS handshake timeout' }
      }
      return undefined
    })
    const { exitCode } = await runCiTriage(h.deps, { sha: SHA, wait: true })
    expect(views).toBe(4)
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
  })

  it('这个 SHA 上还没有任何运行 ⇒ noRun(退出 2)', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return '[]'
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(report.runId).toBeNull()
    expect(report.verdict).toBe('unknown')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
    expect(h.sleeps).toEqual([])
  })

  it('--wait 下还没有运行:每 15s 再看,最多 2 分钟', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return '[]'
      return undefined
    })
    const { exitCode } = await runCiTriage(h.deps, { sha: SHA, wait: true })
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
    expect(h.sleeps.every(s => s === 15_000)).toBe(true)
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(120_000)
  })

  it('取不到失败日志 ⇒ 该作业记 unknown,绝不当 __NO_SUMMARY__ 的 flake 重跑', async () => {
    // 这是最阴的一条:空日志解析出来正好是「没有 FAIL 块、也没有 Test Files
    // 汇总行」—— 即 __NO_SUMMARY__ 的形状。登记表里 node · core suite 正好有
    // 这么一条 flake,于是一次取日志失败会把一条真红判成 flake,--rerun 还会
    // 顺手把它重跑掉,最后没有任何人知道发生过什么。
    const nodeRegistry: FlakeRegistry = {
      entries: [
        {
          id: 'node-no-summary',
          jobs: ['node · core suite'],
          symptom: '__NO_SUMMARY__',
          note: 'node 作业跑完没有 Test Files 汇总行',
          since: '2026-09-16',
        },
      ],
    }
    const nodeJobs = JSON.stringify({
      jobs: [{
        name: 'node · core suite',
        databaseId: 4242,
        conclusion: 'failure',
        steps: [{ name: 'Unit tests under Node (whole src, minus the ws server)', conclusion: 'failure' }],
      }],
    })
    const h = harness((line) => {
      if (line.includes('--log-failed')) return { code: 1, stdout: '', stderr: 'log not found\nmore detail' }
      if (line.startsWith('gh run view') && line.includes('--json jobs')) return nodeJobs
      return failedRunHandler('', 'docs/x.md\n')(line)
    }, { registry: nodeRegistry })

    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA, rerun: true })
    expect(report.verdict).toBe('unknown')
    expect(exitCode).toBe(CI_TRIAGE_EXIT.real)
    expect(report.reruns).toBe(0)
    expect(h.calls.some(c => c.startsWith('gh run rerun'))).toBe(false)
    const only = report.jobs[0]!.classified[0]!
    expect(only.kind).toBe('unknown')
    if (only.kind === 'unknown') expect(only.excerpt).toBe('could not fetch log: log not found')
  })

  it('gh 出错(没登录 / 网络断)⇒ 退出 2,而不是假装绿', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return { code: 4, stdout: '', stderr: 'gh: not authenticated' }
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
    expect(report.verdict).toBe('unknown')
    expect(h.logs.join('\n')).toContain('not authenticated')
  })

  it('找到运行之后 gh 才出错 ⇒ 报告里仍带着这次运行的 id 和地址', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow()
      if (line.startsWith('gh run view') && line.includes('--json jobs')) {
        return { code: 4, stdout: '', stderr: 'gh: API rate limit exceeded' }
      }
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
    // 退 2 的那一行如果连 URL 都没有,人得自己回去翻是哪一次运行。
    expect(report.runId).toBe(RUN_ID)
    expect(report.url).toBe(URL)
  })

  it('--branch 缺省用当前分支来找「上一次绿」', async () => {
    const h = harness(failedRunHandler(REAL_LOG, 'src/cli/selftest.ts\n'))
    await runCiTriage(h.deps, { sha: SHA })
    expect(h.calls.some(c => c.startsWith('gh run list --branch dev'))).toBe(true)
    const explicit = harness(failedRunHandler(REAL_LOG, 'src/cli/selftest.ts\n'))
    await runCiTriage(explicit.deps, { sha: SHA, branch: 'self/x' })
    expect(explicit.calls.some(c => c.startsWith('gh run list --branch self/x'))).toBe(true)
    expect(explicit.calls.some(c => c === 'git rev-parse --abbrev-ref HEAD')).toBe(false)
  })

  it('找不到「上一次绿」时退化成 <sha>~1 去 diff', async () => {
    const h = harness((line) => {
      if (line.startsWith('gh run list --branch')) return '[]'
      return failedRunHandler(REAL_LOG, 'src/cli/selftest.ts\n')(line)
    })
    const { report } = await runCiTriage(h.deps, { sha: SHA })
    expect(report.base).toBe(`${SHA}~1`)
    expect(h.calls.some(c => c === `git diff --name-only ${SHA}~1 ${SHA}`)).toBe(true)
  })

  it('运行还没跑完又没给 --wait ⇒ 退出 2(没有结论可判,不是绿)', async () => {
    const h = harness((line) => {
      if (line === `git rev-parse ${SHA}`) return `${SHA}\n`
      if (line.startsWith('gh run list --commit')) return runListRow({ status: 'in_progress', conclusion: null })
      return undefined
    })
    const { report, exitCode } = await runCiTriage(h.deps, { sha: SHA })
    expect(exitCode).toBe(CI_TRIAGE_EXIT.noRun)
    expect(report.verdict).toBe('unknown')
    expect(report.runId).toBe(RUN_ID)
  })
})
