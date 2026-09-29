// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { parseTimeoutMsFlag } from '../flags'
// ── selftest — real-machine closed loop against a running daemon ───────
//
// spec: docs/superpowers/specs/2026-09-18-self-maintenance-design.md §2.
// Pure logic lives in src/cli/selftest.ts (runWorkbenchSelftest /
// runChatSelftest, injected deps); this just parses flags, wires the real
// deps (operator token from STATE_DIR/internal-api-info.json), and prints
// + exits per SELFTEST_EXIT. Never touches the owner's real WeChat chat.

const selftestWorkbenchCmd = defineCommand({
  meta: { name: 'workbench', description: '真机闭环自检:起一个 scratch 工作台任务,核对回复/工具活动/权限卡放行/写文件等信号(daemon 需在跑)' },
  args: {
    executor: { type: 'string', required: true, description: '执行者 provider id(claude / codex / cursor / agy / …)' },
    image: { type: 'boolean', description: '带一张自生成的红方块 PNG 附件,问模型图里是什么颜色(替换 activity_seen/permission_roundtrip/file_written 三项为 answer_mentions_red)' },
    resume: { type: 'boolean', description: '额外走一次 continue,核对续接(resume_replied)' },
    json: { type: 'boolean', description: 'JSON 输出(SelftestReport),不输出人读版' },
    'timeout-ms': { type: 'string', description: '总超时,毫秒(缺省 240000)' },
    keep: { type: 'boolean', description: '保留 scratch 项目目录,不在跑完后删除' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runWorkbenchSelftest, formatSelftestReport, defaultSelftestDeps, SELFTEST_EXIT } = await import('../selftest.ts')
    const timeout = parseTimeoutMsFlag(args['timeout-ms'])
    if (!timeout.ok) {
      const message = `--timeout-ms ${timeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_ms', message }, null, 2))
      else console.error(`selftest workbench: ${message}`)
      process.exit(SELFTEST_EXIT.failed)
      return
    }
    try {
      const report = await runWorkbenchSelftest(defaultSelftestDeps(STATE_DIR), {
        executor: args.executor,
        image: Boolean(args.image),
        resume: Boolean(args.resume),
        keep: Boolean(args.keep),
        ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      })
      if (json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(formatSelftestReport(report))
        if (report.scratchPath) console.log(`scratch: ${report.scratchPath}`)
      }
      process.exit(report.ok ? SELFTEST_EXIT.ok : SELFTEST_EXIT.failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`selftest workbench: ${noDaemon ? 'daemon 没在跑' : message}`)
      process.exit(noDaemon ? SELFTEST_EXIT.noDaemon : SELFTEST_EXIT.failed)
    }
  },
})

const selftestChatCmd = defineCommand({
  meta: { name: 'chat', description: '真机闭环自检:一轮测试对话(daemon 代 spawn,不发微信),核对回复/工具调用(daemon 需在跑)' },
  args: {
    provider: { type: 'string', required: true, description: 'provider id' },
    text: { type: 'string', description: '自定义测试话术(缺省会额外核对 wechat/ping 被调用)' },
    resume: { type: 'boolean', description: '用第一轮的 sessionId 再问一轮,核对续接(resume_replied)' },
    json: { type: 'boolean', description: 'JSON 输出(SelftestReport),不输出人读版' },
    'timeout-ms': { type: 'string', description: '单轮对话上限,毫秒(缺省 180000;daemon 侧轮次看门狗缺省 120000)' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runChatSelftest, formatSelftestReport, defaultSelftestDeps, SELFTEST_EXIT } = await import('../selftest.ts')
    const timeout = parseTimeoutMsFlag(args['timeout-ms'])
    if (!timeout.ok) {
      const message = `--timeout-ms ${timeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_ms', message }, null, 2))
      else console.error(`selftest chat: ${message}`)
      process.exit(SELFTEST_EXIT.failed)
      return
    }
    try {
      const report = await runChatSelftest(defaultSelftestDeps(STATE_DIR), {
        provider: args.provider,
        ...(args.text !== undefined ? { text: args.text } : {}),
        resume: Boolean(args.resume),
        ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      })
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(formatSelftestReport(report))
      process.exit(report.ok ? SELFTEST_EXIT.ok : SELFTEST_EXIT.failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`selftest chat: ${noDaemon ? 'daemon 没在跑' : message}`)
      process.exit(noDaemon ? SELFTEST_EXIT.noDaemon : SELFTEST_EXIT.failed)
    }
  },
})

const selftestPhoneCmd = defineCommand({
  meta: { name: 'phone', description: '真机闭环自检:配一台一次性设备经真中继连隧道,核对 v2 协议/agents 事件流,收尾撤销该设备(daemon 需在跑)' },
  args: {
    executor: { type: 'string', required: true, description: '执行者 provider id(claude / codex / cursor / agy / …),给自检建的最小工作台任务用' },
    json: { type: 'boolean', description: 'JSON 输出(SelftestReport),不输出人读版' },
    'timeout-ms': { type: 'string', description: '总超时,毫秒(缺省 90000)' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runPhoneSelftest, formatPhoneSelftestReport, defaultPhoneSelftestDeps, PHONE_SELFTEST_EXIT } = await import('../selftest-phone.ts')
    const timeout = parseTimeoutMsFlag(args['timeout-ms'])
    if (!timeout.ok) {
      const message = `--timeout-ms ${timeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_ms', message }, null, 2))
      else console.error(`selftest phone: ${message}`)
      process.exit(PHONE_SELFTEST_EXIT.failed)
      return
    }
    try {
      const report = await runPhoneSelftest(defaultPhoneSelftestDeps(STATE_DIR), {
        executor: args.executor,
        ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      })
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(formatPhoneSelftestReport(report))
      process.exit(report.ok ? PHONE_SELFTEST_EXIT.ok : PHONE_SELFTEST_EXIT.failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`selftest phone: ${noDaemon ? 'daemon 没在跑' : message}`)
      process.exit(noDaemon ? PHONE_SELFTEST_EXIT.noDaemon : PHONE_SELFTEST_EXIT.failed)
    }
  },
})

export const selftestCmd = defineCommand({
  meta: { name: 'selftest', description: '自维护:真机闭环自检(daemon 需在跑);见 docs/maintainer/verify.md' },
  subCommands: { workbench: selftestWorkbenchCmd, chat: selftestChatCmd, phone: selftestPhoneCmd },
})
