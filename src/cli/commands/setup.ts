// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { SetupPollOutput, SetupQrJsonOutput } from '../schema'
export const setupCmd = defineCommand({
  meta: { name: 'setup', description: 'Scan QR + bind a WeChat bot' },
  args: {
    'qr-json': { type: 'boolean', description: 'Emit JSON envelope (one-shot QR fetch) instead of starting an interactive scan' },
  },
  async run({ args }) {
    if (args['qr-json']) {
      const { requestSetupQrCode } = await import('../setup-flow.ts')
      console.log(JSON.stringify(SetupQrJsonOutput.parse(await requestSetupQrCode()), null, 2))
      return
    }
    // Same rationale as `run`: import setup.ts directly so the compiled
    // sidecar can drive the QR flow from inside Tauri-spawned shells too.
    await import('../../../setup.ts')
  },
})

export const setupPollCmd = defineCommand({
  meta: { name: 'setup-poll', description: 'Poll a setup-status QR code (paired with `setup --qr-json`)' },
  args: {
    qrcode: { type: 'string', required: true, description: 'QR token returned from `setup --qr-json`' },
    'base-url': { type: 'string', description: 'Override ilink base URL (defaults to setup-flow internal default)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { pollSetupQrStatus } = await import('../setup-flow.ts')
    // Best-effort: open the daemon's SQLite read-only-style so scenario
    // detection can distinguish 'reconnect' from 'redundant'. db.ts uses
    // WAL mode + 5s busy_timeout, so concurrent access from a running
    // daemon is safe. If the db doesn't exist yet (fresh install), fall
    // through with isExpired undefined — determineScenario then collapses
    // 'reconnect' into 'redundant', which is still truthful copy.
    let isExpired: ((botDirName: string) => boolean) | undefined
    try {
      const { openWechatDb } = await import('../../lib/db')
      const { makeSessionStateStore } = await import('../../core/session-state')
      const db = openWechatDb(STATE_DIR)
      const store = makeSessionStateStore(db)
      isExpired = (botDirName: string) => store.isExpired(botDirName)
    } catch { /* db absent or schema older than session_state migration — leave undefined */ }
    const result = await pollSetupQrStatus({
      qrcode: args.qrcode,
      ...(args['base-url'] !== undefined ? { baseUrl: args['base-url'] } : {}),
      stateDir: STATE_DIR,
      ...(isExpired ? { isExpired } : {}),
    })
    if (args.json) console.log(JSON.stringify(SetupPollOutput.parse(result), null, 2))
    else console.log(result.status)
  },
})
