// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
export const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Deprecated since v1.0 — use `wechat-cc service install`',
  },
  args: {
    user: { type: 'boolean', description: 'legacy --user scope (ignored)' },
  },
  run() {
    // `wechat-cc install [--user]` was the v0.x entrypoint that wrote a
    // wechat MCP server entry into ~/.claude.json so Claude Code would
    // spawn the channel as a child MCP. v1.0+ flipped the model: the
    // daemon now drives Claude via the Agent SDK directly, so an MCP
    // entry serves no purpose. Tell the user the new path instead of
    // silently writing a broken entry.
    console.error('wechat-cc install is deprecated since v1.0.')
    console.error('Use `wechat-cc service install` to register the daemon (macOS launchd / Linux systemd / Windows ScheduledTask),')
    console.error('or open the desktop app and walk through the setup wizard.')
    process.exit(2)
  },
})
