// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readJsonFile } from '../../lib/read-json-file'
import { STATE_DIR } from '../../lib/config'
// ── connection probe — wechat-cc connection probe [--json] ─────────────────
//
// Walks STATE_DIR/accounts/<id>/{account.json,token}, calls probeConnection
// for each bound account, and emits { accounts: ProbeResult[] }.
// On taken_over the daemon's SQLite session_state row is written so the
// dashboard's expiredBots list reflects it on next doctor poll.

const connectionProbeCmd = defineCommand({
  meta: { name: 'probe', description: 'Test whether THIS machine holds the live WeChat connection' },
  args: { json: { type: 'boolean', description: 'machine-readable output' } },
  async run({ args }) {
    const { ilinkGetUpdates } = await import('../../lib/ilink')
    const { probeConnection } = await import('../../daemon/connection-probe')
    const { openWechatDb } = await import('../../lib/db')
    const { makeSessionStateStore } = await import('../../core/session-state')
    const { readFileSync, existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')

    const PROBE_TIMEOUT_MS = 5000
    const dir = join(STATE_DIR, 'accounts')
    const ids = existsSync(dir) ? readdirSync(dir).filter(n => !n.includes('.superseded.')) : []

    // Open db only when accounts exist to avoid creating an empty db in a
    // non-existent STATE_DIR (the db file lives inside STATE_DIR).
    let db: import('../../lib/db').Db | null = null
    const accounts: import('../../daemon/connection-probe').ProbeResult[] = []
    try {
      if (ids.length > 0) db = openWechatDb(STATE_DIR)
      const store = db ? makeSessionStateStore(db) : null
      for (const id of ids) {
        const acctDir = join(dir, id)
        const metaPath = join(acctDir, 'account.json')
        const tokenPath = join(acctDir, 'token')
        if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
        const meta = readJsonFile<{ botId: string; baseUrl: string }>(metaPath)
        const token = readFileSync(tokenPath, 'utf8').trim()
        const result = await probeConnection({
          account: { id, botId: meta.botId, baseUrl: meta.baseUrl, token },
          getUpdates: (baseUrl, tok, timeoutMs) => ilinkGetUpdates(baseUrl, tok, '', timeoutMs),
          markExpired: (accountId, reason) => store ? store.markExpired(accountId, reason) : false,
          clearExpired: (accountId) => store?.clear(accountId),
          probeTimeoutMs: PROBE_TIMEOUT_MS,
        })
        accounts.push(result)
      }
    } finally {
      db?.close()
    }

    const out = { accounts }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else if (accounts.length === 0) console.log('no bound accounts found')
    else for (const a of accounts) console.log(`${a.id}: ${a.state}${a.detail ? ` (${a.detail})` : ''}`)
  },
})

export const connectionCmd = defineCommand({
  meta: { name: 'connection', description: "Inspect this machine's WeChat connection" },
  subCommands: { probe: connectionProbeCmd },
})
