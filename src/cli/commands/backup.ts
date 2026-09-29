// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
const backupCreateCmd = defineCommand({
  meta: { name: 'create', description: '立即做一次备份快照（仅不可再生数据，约 2MB）' },
  args: { keep: { type: 'string', description: '备份后仅保留最新 N 份（默认不清理）' } },
  async run({ args }) {
    const { createBackup, pruneBackups } = await import('../../lib/backup')
    const r = await createBackup({ stateDir: STATE_DIR })
    console.log(`✓ 已备份 → ${r.path} (${Math.round(r.bytes / 1024)}KB, ${r.entries.length} 项)`)
    const keep = Number(args.keep)
    if (Number.isFinite(keep) && keep > 0) {
      const removed = pruneBackups(STATE_DIR, keep)
      if (removed > 0) console.log(`已清理 ${removed} 份旧备份，保留最新 ${keep} 份`)
    }
  },
})

const backupListCmd = defineCommand({
  meta: { name: 'list', description: '列出已有备份（新→旧）' },
  async run() {
    const { listBackups } = await import('../../lib/backup')
    const all = listBackups(STATE_DIR)
    if (all.length === 0) { console.log('还没有备份 — 跑 `wechat-cc backup create` 做第一份。'); return }
    for (const b of all) console.log(`${b.path}  ${Math.round(b.bytes / 1024)}KB`)
  },
})

const backupRestoreCmd = defineCommand({
  meta: { name: 'restore', description: '从备份恢复（需先停掉 daemon；被替换的文件会存进 restore-undo-*）' },
  args: { file: { type: 'positional', required: true, description: '备份文件路径（backup list 里的一行）' } },
  async run({ args }) {
    const { restoreBackup } = await import('../../lib/backup')
    const daemonRunning = () => {
      try {
        const info = JSON.parse(require('node:fs').readFileSync(join(STATE_DIR, 'internal-api-info.json'), 'utf8'))
        // Liveness = the recorded pid still exists. A sync signal-0 probe —
        // no fetch, no async, works even when the http face is wedged.
        if (typeof info.pid === 'number') { process.kill(info.pid, 0); return true }
        return false
      } catch { return false }
    }
    const r = await restoreBackup({ stateDir: STATE_DIR, file: String(args.file), daemonRunning })
    if (!r.ok) {
      if (r.error === 'daemon_running') {
        console.error('✗ daemon 正在运行 — 先 `wechat-cc daemon stop`（或停掉 LaunchAgent）再恢复。')
      } else {
        console.error(`✗ 备份文件读不了：${r.detail ?? r.error}`)
      }
      process.exit(1)
    }
    console.log(`✓ 已恢复 ${r.restored.length} 项。被替换的旧文件在 ${r.undoDir} — 确认无误后可删。`)
  },
})

export const backupCmd = defineCommand({
  meta: { name: 'backup', description: '备份/恢复不可再生数据（记忆、事实库、配置）' },
  subCommands: { create: backupCreateCmd, list: backupListCmd, restore: backupRestoreCmd },
})
