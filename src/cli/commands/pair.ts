// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
// ── 配对码 — friend pairing (spec §7) ─────────────────────────────────
// wechat-cc pair          → mint + print a 6-digit code (share with a friend)
// wechat-cc pair <code>   → redeem a friend's code and connect
// Both need the RUNNING daemon (internal-api, tier trusted) — same idiom as
// `social wishes`. NOT to be confused with `hand invite`/`hand join`, which
// pair two WORKER hands (delegated-agent capacity), not two people's bots.
export const pairCmd = defineCommand({
  meta: {
    name: 'pair',
    description: '配对码 — 和朋友的 bot 建边:无参生成码,带 6 位码接受(≠ hand invite/join 的干活手配对;需运行中的 daemon)',
  },
  args: {
    code: { type: 'positional', required: false, description: '朋友的 6 位配对码', valueHint: 'code' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    try {
      if (args.code) {
        const { cmdPairAccept } = await import('../pair.ts')
        await cmdPairAccept(STATE_DIR, String(args.code), { json: Boolean(args.json) })
      } else {
        const { cmdPairStart } = await import('../pair.ts')
        await cmdPairStart(STATE_DIR, { json: Boolean(args.json) })
      }
    } catch {
      // cmdPairStart/cmdPairAccept's default `fail` already printed the message.
      process.exit(1)
    }
  },
})
