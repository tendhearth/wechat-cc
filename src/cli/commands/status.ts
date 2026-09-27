// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
/**
 * citty migration — batch 1.
 *
 * Subcommands listed in `MIGRATED_COMMANDS` go through the citty root below;
 * everything else still falls through to legacy `parseCliArgs` + the
 * executor switch in `main()`. Each batch will move ~5-10 more commands from
 * the legacy switch into `cittyRoot.subCommands` until the legacy parser is
 * empty.
 *
 * Subcommand `run` handlers preserve the dynamic-import pattern
 * (`await import('../X.ts')`) so cold-start cost stays the same.
 */
const statusListRun = async (cmd: 'status' | 'list'): Promise<void> => {
  const { runStatus } = await import('../cli-status.ts')
  await runStatus(cmd)
}

export const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show daemon status + accounts' },
  async run() { await statusListRun('status') },
})

export const listCmd = defineCommand({
  meta: { name: 'list', description: 'List bound accounts' },
  async run() { await statusListRun('list') },
})
