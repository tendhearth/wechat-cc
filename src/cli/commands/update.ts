// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { SOURCE_REPO_ROOT } from '../repo-root'
import { compiledRepoRoot } from '../../lib/runtime-info'
import { UpdateCheckOutput, UpdateApplyOutput } from '../schema'
export const updateCmd = defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest + reinstall deps + restart service. --check probes only (no side effects).',
  },
  args: {
    check: { type: 'boolean', description: 'Probe only — no side effects' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const check = Boolean(args.check)
    const json = Boolean(args.json)
    const { analyzeUpdate, applyUpdate, defaultUpdateDeps } = await import('../update.ts')
    // Compiled-bundle short-circuit: when the binary is shipped inside a
    // desktop .app/.exe, there is no git repo nearby. Surface this with a
    // dedicated `not_a_git_repo` reason instead of bubbling up an empty-
    // stderr fetch_failed (which the GUI couldn't tell from a real outage).
    const { existsSync } = await import('node:fs')
    // 原来 here = dirname(fileURLToPath(import.meta.url))(= 仓库根);搬家后改从 repo-root 取。
    const repoRoot = compiledRepoRoot() ?? SOURCE_REPO_ROOT
    const hasGitRepo = existsSync(join(repoRoot, '.git'))
    if (!hasGitRepo) {
      const synthetic = {
        ok: false as const,
        mode: check ? ('check' as const) : ('apply' as const),
        reason: 'not_a_git_repo' as const,
        message: 'no git repo at this binary\'s location; in-place updates are not available for desktop bundles (download a newer version from GitHub Releases instead)',
        details: { repoRoot },
      }
      if (json) console.log(JSON.stringify((check ? UpdateCheckOutput : UpdateApplyOutput).parse(synthetic), null, 2))
      else console.error(`update: not_a_git_repo — ${synthetic.message}`)
      if (!json) process.exit(1)
      return
    }
    const deps = defaultUpdateDeps(repoRoot, STATE_DIR)
    if (check) {
      const probe = analyzeUpdate(deps)
      if (json) {
        console.log(JSON.stringify(UpdateCheckOutput.parse(probe), null, 2))
      } else if (!probe.ok) {
        console.error(`update check: ${probe.reason} — ${probe.message}`)
        process.exit(1)
      } else {
        console.log(probe.updateAvailable
          ? `update available: ${probe.currentCommit} → ${probe.latestCommit} (${probe.behind} commits${probe.lockfileWillChange ? ', lockfile changes' : ''})`
          : `up to date (${probe.currentCommit})`)
      }
      return
    }
    const result = await applyUpdate(deps)
    if (json) {
      console.log(JSON.stringify(UpdateApplyOutput.parse(result), null, 2))
    } else if (!result.ok) {
      console.error(`update failed: ${result.reason} — ${result.message}`)
      process.exit(1)
    } else {
      const lockNote = result.lockfileChanged ? ', deps reinstalled' : ''
      console.log(`updated: ${result.fromCommit} → ${result.toCommit}${lockNote}, daemon=${result.daemonAction} (${result.elapsedMs}ms)`)
    }
  },
})
