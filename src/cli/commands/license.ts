// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
// License / Pro entitlement. `activate DEV-anything` unlocks Pro locally for
// testing before Lemon Squeezy is wired.
const licenseStatusCmd = defineCommand({
  meta: { name: 'status', description: 'Show Pro entitlement (free / pro, expiry)' },
  args: { json: { type: 'boolean', description: 'JSON output' } },
  async run({ args }) {
    const { getEntitlement } = await import('../../daemon/license/license')
    const e = getEntitlement(STATE_DIR)
    if (args.json) { console.log(JSON.stringify(e, null, 2)); return }
    console.log(`${e.pro ? '★ Pro' : '· Free'} — ${e.reason}${e.expiresAt ? ` (until ${e.expiresAt})` : ''}`)
  },
})
const licenseActivateCmd = defineCommand({
  meta: { name: 'activate', description: 'Activate a license key (use DEV-xxx to unlock Pro locally for testing)' },
  args: { key: { type: 'positional', required: true, description: 'License key', valueHint: 'key' } },
  async run({ args }) {
    const { activate } = await import('../../daemon/license/license')
    const { hostname } = await import('node:os')
    const r = await activate(STATE_DIR, args.key, hostname())
    if (!r.ok) { console.error(`activation failed: ${r.error}`); process.exit(1) }
    console.log(`activated — ${r.entitlement.pro ? 'Pro' : 'not Pro'} (${r.entitlement.reason}). restart the daemon to apply.`)
  },
})
const licenseDeactivateCmd = defineCommand({
  meta: { name: 'deactivate', description: 'Remove the local license (back to Free)' },
  async run() {
    const { clearLicense } = await import('../../daemon/license/license')
    clearLicense(STATE_DIR)
    console.log('license removed — back to Free. restart the daemon to apply.')
  },
})
export const licenseCmd = defineCommand({
  meta: { name: 'license', description: 'Manage the Pro license' },
  subCommands: { status: licenseStatusCmd, activate: licenseActivateCmd, deactivate: licenseDeactivateCmd },
})
