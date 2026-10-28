// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { parseCountFlag } from '../flags'
// ── ci triage — 「看 CI」这一步从人的判断变成一条命令 ──────────────────
//
// spec: docs/superpowers/specs/2026-09-18-ci-triage-design.md §3。纯逻辑在
// src/cli/ci-triage.ts,取数与等待在 src/cli/ci-triage-run.ts;这里只解析开关、
// 打印、按 CI_TRIAGE_EXIT 退出。跟 `self deploy` 一样,只在开发机上有意义
// (依赖 gh 的登录态)。


const ciTriageCmd = defineCommand({
  meta: { name: 'triage', description: '看 CI:这个 SHA 绿了吗?红的是自己的锅还是已知 flake(需要 gh 登录态)' },
  args: {
    sha: { type: 'string', description: '要看的提交(缺省 HEAD;短 sha 会先 git rev-parse 成 40 位)' },
    branch: { type: 'string', description: '去哪条分支上找「上一次绿」当 diff 基线(缺省当前分支)' },
    wait: { type: 'boolean', description: '等运行出现(最多 2 分钟)并等它跑完' },
    rerun: { type: 'boolean', description: '判成 flake 时重跑失败作业;--wait 时等完重判,第二次仍红一律算真红' },
    'max-reruns': { type: 'string', description: '最多重跑几次(缺省 1;0 = 从不重跑)。>1 只对 __NO_SUMMARY__ 那类作业级 flake 有意义 —— 具体测试的失败第二轮一律判真红,再重跑也翻不过来' },
    'timeout-min': { type: 'string', description: '等运行跑完的总上限,分钟(缺省 30)' },
    json: { type: 'boolean', description: 'JSON 输出(TriageReport),不输出人读版' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runCiTriage, defaultCiTriageDeps, CI_TRIAGE_EXIT } = await import('../ci-triage-run.ts')
    const { formatTriage } = await import('../ci-triage.ts')

    const maxReruns = parseCountFlag(args['max-reruns'], 0)
    if (!maxReruns.ok) {
      const message = `--max-reruns ${maxReruns.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_max_reruns', message }, null, 2))
      else console.error(`ci triage: ${message}`)
      // 2 而不是 1:开关写错了是「没能去判」,不是「判出来是真红」。
      process.exit(CI_TRIAGE_EXIT.noRun)
      return
    }
    const timeoutMin = parseCountFlag(args['timeout-min'], 1)
    if (!timeoutMin.ok) {
      const message = `--timeout-min ${timeoutMin.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_min', message }, null, 2))
      else console.error(`ci triage: ${message}`)
      process.exit(CI_TRIAGE_EXIT.noRun)
      return
    }

    const { report, exitCode } = await runCiTriage(defaultCiTriageDeps(process.cwd()), {
      ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      ...(args.branch !== undefined ? { branch: String(args.branch) } : {}),
      wait: Boolean(args.wait),
      rerun: Boolean(args.rerun),
      ...(maxReruns.value !== undefined ? { maxReruns: maxReruns.value } : {}),
      ...(timeoutMin.value !== undefined ? { timeoutMin: timeoutMin.value } : {}),
    })
    if (json) console.log(JSON.stringify(report, null, 2))
    else console.log(formatTriage(report))
    process.exit(exitCode)
  },
})

// ── ci land — 叠起来的一串 PR 一条命令合进 dev(src/cli/ci-land.ts 开头写了每条「停下来」的来历) ──
const ciLandCmd = defineCommand({
  meta: { name: 'land', description: '把叠起来的一串 PR 合进 dev:只等最上面那个的 CI,绿了从下往上 rebase / 改 base / squash 合(在整合者自己的 detached worktree 里跑)' },
  args: {
    pr: { type: 'positional', required: true, description: '最上面那个 PR 的编号' },
    'min-checks': { type: 'string', description: '非 skipped 的检查至少几条才算 CI 真跑了(缺省 5;只改文档的串给 1)' },
    'timeout-min': { type: 'string', description: '等 CI 的总上限,分钟(缺省 120)' },
    'dry-run': { type: 'boolean', description: '只认出这一串、打印计划,不动任何东西' },
    'skip-typecheck': { type: 'boolean', description: '每层 rebase 后不跑 tsc(缺省会跑)' },
    'parent-old': { type: 'string', description: '接着上一次、最下面那层叠在已合 PR 上且自动找不到时:它当初叠在下层的哪个提交上' },
  },
  async run({ args }) {
    const { runCiLand, CI_LAND_EXIT } = await import('../ci-land.ts')
    const { defaultCiTriageDeps } = await import('../ci-triage-run.ts')
    const top = Number(args.pr)
    const minChecks = parseCountFlag(args['min-checks'], 0)
    const timeoutMin = parseCountFlag(args['timeout-min'], 1)
    if (!Number.isInteger(top) || top <= 0 || !minChecks.ok || !timeoutMin.ok) {
      console.error('ci land: 用法 wechat-cc ci land <PR 编号> [--min-checks N] [--timeout-min N] [--dry-run] [--skip-typecheck]')
      process.exit(CI_LAND_EXIT.precondition)
      return
    }
    const { registry: _registry, ...deps } = defaultCiTriageDeps(process.cwd())
    const res = await runCiLand(deps, {
      top,
      ...(minChecks.value !== undefined ? { minChecks: minChecks.value } : {}),
      ...(timeoutMin.value !== undefined ? { timeoutMin: timeoutMin.value } : {}),
      dryRun: Boolean(args['dry-run']),
      skipTypecheck: Boolean(args['skip-typecheck']),
      ...(args['parent-old'] ? { parentOld: String(args['parent-old']) } : {}),
    })
    ;(res.exitCode === CI_LAND_EXIT.landed ? console.log : console.error)(res.message)
    process.exit(res.exitCode)
  },
})

export const ciCmd = defineCommand({
  meta: { name: 'ci', description: '看 CI 的信号面(见 docs/maintainer/ci-and-flakes.md)' },
  subCommands: { triage: ciTriageCmd, land: ciLandCmd },
})
