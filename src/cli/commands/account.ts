// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { AccountRemoveOutput } from '../schema'
const accountRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Decommission a bound bot — wipes account dir + related state. Restart daemon afterwards.' },
  args: {
    botId: { type: 'positional', required: true, description: 'Bot id', valueHint: 'bot-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAccount } = await import('../account-remove.ts')
    // Best-effort SQLite session_state cleanup. The legacy file path is
    // dead post-PR7 migration; without this hook every `account remove`
    // on a previously-expired bot leaves an orphan SQLite row forever.
    let clearSessionStateBot: ((botId: string) => boolean) | undefined
    try {
      const { openWechatDb } = await import('../../lib/db')
      const { makeSessionStateStore } = await import('../../core/session-state')
      const db = openWechatDb(STATE_DIR)
      const store = makeSessionStateStore(db)
      clearSessionStateBot = (botId: string) => {
        if (!store.isExpired(botId)) return false
        store.clear(botId)
        return true
      }
    } catch { /* db absent / migration not run yet — fall through to legacy-file-only cleanup */ }
    try {
      const result = removeAccount({
        stateDir: STATE_DIR,
        ...(clearSessionStateBot ? { clearSessionStateBot } : {}),
      }, args.botId)
      if (args.json) {
        console.log(JSON.stringify(AccountRemoveOutput.parse({ ok: true, ...result, restartRequired: true }), null, 2))
      } else {
        console.log(`removed: ${result.botId}`)
        for (const r of result.removed) console.log(`  - ${r}`)
        for (const w of result.warnings) console.log(`  ! ${w}`)
        console.log('\nrestart daemon for the change to take effect.')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify(AccountRemoveOutput.parse({ ok: false, error: msg })))
      else console.error(`account remove failed: ${msg}`)
      process.exit(1)
    }
  },
})

/**
 * 口令保护的是 bot 的凭证:放在命令行参数里,本机任何用户 `ps` 都看得见、还进 shell 历史。
 * 优先读环境变量 WECHAT_CC_PASSPHRASE;--passphrase 留着兼容(桌面 / 旧脚本)。
 */
export function accountPassphrase(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const p = flag ?? env.WECHAT_CC_PASSPHRASE
  if (!p) throw new Error('passphrase required — set WECHAT_CC_PASSPHRASE (or pass --passphrase)')
  return p
}

const accountExportCmd = defineCommand({
  meta: { name: 'export', description: 'Export a bound bot (encrypted) so another machine can drive it — no re-scan' },
  args: {
    'bot-id': { type: 'string', description: 'Which account (default: the sole bound one)' },
    passphrase: { type: 'string', description: 'Encrypts the bundle (you type the same on import). Prefer env WECHAT_CC_PASSPHRASE — a flag is visible in `ps` and shell history' },
    out: { type: 'string', description: 'Output file (default: <botId>.wccaccount)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { resolveAccountId, exportAccount, markMultiDevice } = await import('../account-transfer.ts')
    try {
      const id = resolveAccountId(STATE_DIR, args['bot-id'])
      const blob = exportAccount(STATE_DIR, id, accountPassphrase(args.passphrase))
      // Exporting = this bot is now shared → mark the source too, so when the
      // other device takes over, THIS machine also stands by gracefully.
      markMultiDevice(STATE_DIR, id)
      const outPath = args.out ?? join(process.cwd(), `${id}.wccaccount`)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(outPath, blob, { mode: 0o600 })
      if (args.json) { console.log(JSON.stringify({ ok: true, botId: id, out: outPath, bytes: blob.length })); return }
      console.log(`exported ${id} → ${outPath} (${blob.length}B, encrypted)`)
      console.log('⚠ 这个文件含你 bot 的完整凭证 — 安全传到另一台机器,用同一口令 `account import` 导入。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account export failed: ${msg}`); process.exit(1)
    }
  },
})

const accountImportCmd = defineCommand({
  meta: { name: 'import', description: 'Import an account bundle from another machine — drive the same bot without re-scanning' },
  args: {
    file: { type: 'positional', required: true, description: 'The .wccaccount bundle', valueHint: 'file' },
    passphrase: { type: 'string', description: 'The passphrase used on export. Prefer env WECHAT_CC_PASSPHRASE — a flag is visible in `ps` and shell history' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { importAccount } = await import('../account-transfer.ts')
    try {
      const { readFileSync } = await import('node:fs')
      const blob = readFileSync(args.file)
      const res = importAccount(STATE_DIR, blob, accountPassphrase(args.passphrase))
      if (args.json) { console.log(JSON.stringify({ ok: true, ...res })); return }
      console.log(`imported ${res.botId}${res.overwritten ? ' (overwrote existing)' : ''}`)
      console.log('\n重启 daemon 即接管该 bot(会从另一台手里接管会话,对方退到后台)。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account import failed: ${msg}`); process.exit(1)
    }
  },
})

const accountTakeoverCmd = defineCommand({
  meta: { name: 'takeover', description: 'Take over the bot session on THIS machine (re-poll a stood-by account) — no daemon restart' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestTakeover } = await import('../account-transfer.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestTakeover({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 接管 —— 重读账号、重启待命的轮询。`)
      console.log('几秒后这台成为活跃端,另一台会优雅待命。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account takeover failed: ${msg}`); process.exit(1)
    }
  },
})


export const accountCmd = defineCommand({
  meta: { name: 'account', description: 'Account management (export/import + takeover for multi-device, decommission a bound bot)' },
  subCommands: { remove: accountRemoveCmd, export: accountExportCmd, import: accountImportCmd, takeover: accountTakeoverCmd },
})
