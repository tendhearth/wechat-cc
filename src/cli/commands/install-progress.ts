// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
export const installProgressCmd = defineCommand({
  meta: {
    name: 'install-progress',
    description: 'Read the current service-install progress (JSON: {step, total, label, ts}). Used by the desktop wizard to poll real install state instead of guessing. Empty {} when no install is in flight.',
  },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (default; flag is for symmetry with other commands)' },
  },
  async run() {
    const { readInstallProgress } = await import('../install-progress.ts')
    const result = readInstallProgress(STATE_DIR)
    if (result.kind === 'progress') {
      console.log(JSON.stringify(result.value))
      return
    }
    if (result.kind === 'invalid') {
      // Wizard polls at ~250ms; never crash it. Surface the validation
      // error to stderr (visible in `wechat-cc logs` when run via service)
      // but keep stdout = `{}` so the wizard treats it as "no progress yet".
      console.error(`install-progress.json invalid: ${result.error}`)
    }
    console.log('{}')
  },
})
