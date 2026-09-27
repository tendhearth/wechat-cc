// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
// ── 觅食台 social surface — wechat-cc social {wishes,enable} ──
// `wishes` needs the running daemon (GET /v1/social/wishes — spec
// 2026-09-04-wish-postcard §4); it replaces the P4-era propose/confirm/
// cancel/reveal/seeks/echoes/pledges subcommands (心愿 signals a wish
// through-and-through, sent with 派 <id> / voided with 取消 <id> in WeChat
// or the mcp tool — the CLI's only remaining job here is to list them).

const socialWishesCmd = defineCommand({
  meta: { name: 'wishes', description: 'List my 心愿 + effective status (needs running daemon)' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { cmdSocialWishes } = await import('../social.ts')
    try {
      await cmdSocialWishes(STATE_DIR, { json: Boolean(args.json) })
    } catch {
      // cmdSocialWishes's default `fail` already printed the message.
      process.exit(1)
    }
  },
})

// `enable` is a one-toggle onramp: sets social_enabled + fills in the two
// other social-boot settings ONLY when absent (merge-persist, same
// read-modify-write idiom as self-agent-id.ts). No `disable` — turning
// social off is an operator-config edit, not part of this onramp.
const socialEnableCmd = defineCommand({
  meta: { name: 'enable', description: '一键开启觅食台社交(merge-persist,不覆盖已有设置)' },
  args: {
    status: { type: 'boolean', description: '只打印当前三项设置,不写入' },
  },
  async run({ args }) {
    const { cmdSocialEnable } = await import('../social-enable.ts')
    cmdSocialEnable(STATE_DIR, { status: Boolean(args.status) })
  },
})

export const socialCmd = defineCommand({
  meta: { name: 'social', description: '觅食台 — list 心愿 (wishes), and enable (开启)' },
  subCommands: {
    wishes: socialWishesCmd,
    enable: socialEnableCmd,
  },
})
