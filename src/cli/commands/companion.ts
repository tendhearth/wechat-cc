// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
const companionPushCmd = defineCommand({
  meta: { name: 'push', description: 'Fire a companion push tick NOW (instead of waiting for the ~20min scheduler) — nudges any due agenda follow-up' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestPushTick } = await import('../companion-push.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestPushTick({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 立刻跑一次 push tick —— 若有到点的 agenda 跟进会主动发。`)
      console.log('查看结果：wechat-cc logs（或 tail channel.log 看 SCHED / COMPANION）。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`companion push failed: ${msg}`); process.exit(1)
    }
  },
})


const companionIntrospectCmd = defineCommand({
  meta: { name: 'introspect', description: 'Fire introspection + CC Atelier tick NOW (instead of waiting for the daily schedule)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestIntrospectTick } = await import('../companion-introspect.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestIntrospectTick({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 立刻跑一次 introspect + Atelier tick。`)
      console.log('查看结果：wechat-cc logs（或 tail channel.log 看 INTROSPECT / ATELIER）。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`companion introspect failed: ${msg}`); process.exit(1)
    }
  },
})

export const companionCmd = defineCommand({
  meta: { name: 'companion', description: 'Companion (proactive contact) controls' },
  subCommands: { push: companionPushCmd, introspect: companionIntrospectCmd },
})
