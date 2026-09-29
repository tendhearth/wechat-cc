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

export const ciCmd = defineCommand({
  meta: { name: 'ci', description: '看 CI 的信号面(见 docs/maintainer/ci-and-flakes.md)' },
  subCommands: { triage: ciTriageCmd },
})
