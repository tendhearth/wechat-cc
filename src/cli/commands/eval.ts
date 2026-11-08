// `wechat-cc eval run|diff` —— AI 输出回归评测(设计稿 docs/design/2026-10-29-output-eval.md)。
// 逻辑在 src/cli/output-eval.ts(依赖注入、可测);这里只解析参数、接真依赖(STATE_DIR/eval、internal-api-info.json 的
// operator 凭据)、打印、按 EVAL_EXIT 退出。不发微信、不写对话库:被测的那一下在 daemon 的 POST /v1/eval/run 里。
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'

const evalDir = () => join(STATE_DIR, 'eval')

const evalRunCmd = defineCommand({
  meta: { name: 'run', description: '跑一遍 <STATE_DIR>/eval/samples/*.json:硬规则 + 便宜模型打分,报告写 eval/runs/<时间>/(daemon 需在跑)' },
  args: {
    only: { type: 'string', description: '只跑这几条(逗号分隔的样本 id)' },
    provider: { type: 'string', description: 'reply / brief 用哪家执行者(缺省 daemon 的缺省执行者)' },
    json: { type: 'boolean', description: 'JSON 输出({ report, diff, dir }),不输出人读版' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runEval, formatRunSummary, exitCodeFor, EVAL_EXIT } = await import('../output-eval.ts')
    const { readApiInfo } = await import('../../lib/api-info')
    const only = typeof args.only === 'string' ? args.only.split(',').map(s => s.trim()).filter(Boolean) : undefined
    try {
      const r = await runEval({
        evalDir: evalDir(), fetch, readApiInfo: () => readApiInfo(STATE_DIR), now: () => Date.now(),
        log: (line) => { if (!json) console.error(`[eval] ${line}`) },
      }, { ...(only?.length ? { only } : {}), ...(typeof args.provider === 'string' && args.provider ? { providerId: args.provider } : {}) })
      console.log(json ? JSON.stringify(r, null, 2) : formatRunSummary(r))
      process.exit(exitCodeFor(r.report))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      const human = noDaemon ? 'daemon 没在跑'
        : message === 'no_samples' ? `${join(evalDir(), 'samples')} 里没有样本(示例在仓库的 eval/output/examples/,复制过去改)`
        : message
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`eval run: ${human}`)
      process.exit(noDaemon ? EVAL_EXIT.noDaemon : EVAL_EXIT.failed)
    }
  },
})

const evalDiffCmd = defineCommand({
  meta: { name: 'diff', description: '比两次运行:列出「上次过、这次不过」的(缺省最近两次)' },
  args: {
    from: { type: 'positional', required: false, description: '较早那次的 runId(eval/runs/ 下的目录名)' },
    to: { type: 'positional', required: false, description: '较晚那次的 runId' },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const { diffLatest, formatDiff, EVAL_EXIT } = await import('../output-eval.ts')
    const from = typeof args.from === 'string' && args.from ? args.from : undefined
    const to = typeof args.to === 'string' && args.to ? args.to : undefined
    if ((from === undefined) !== (to === undefined)) {
      console.error('eval diff: 要么不给(比最近两次),要么两个 runId 都给')
      process.exit(EVAL_EXIT.failed)
      return
    }
    const d = await diffLatest(evalDir(), from, to)
    if (!d) {
      console.error(`eval diff: ${from ? '找不到这两次的 report.json' : '还没有两次运行可比'}(${join(evalDir(), 'runs')})`)
      process.exit(EVAL_EXIT.failed)
      return
    }
    console.log(args.json ? JSON.stringify(d, null, 2) : formatDiff(d))
    process.exit(EVAL_EXIT.ok)
  },
})

export const evalCmd = defineCommand({
  meta: { name: 'eval', description: 'AI 输出回归评测:改提示词 / 换模型后,以前答得对的现在还对不对;见 docs/design/2026-10-29-output-eval.md' },
  subCommands: { run: evalRunCmd, diff: evalDiffCmd },
})
