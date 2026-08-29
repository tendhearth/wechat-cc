/**
 * Reminders end-to-end — schedule through a live daemon boot, sweep,
 * deliver, and prove no double delivery (Task 7, spec
 * 2026-08-20-reminders-port-design). Boots the REAL daemon (main.ts's
 * bootDaemon) against a fake ilink server, exactly like
 * degraded-boot.e2e.test.ts / internal-api-tier-authz.e2e.test.ts —
 * copied harness posture, same fixture helpers (startTestDaemon), because
 * this is the nearest "boots the pipeline with a fake ilink" e2e and
 * reminders' /v1/reminders/* routes + sweeper are wired straight into that
 * same daemon boot (main.ts sup.start('reminders', ...)).
 *
 * What this drives end-to-end (real wiring, no mocks beyond the harness's
 * fake ilink/fake SDK):
 *   - a real Claude dispatch spawn for FIXTURE_CHAT (to recover a genuine
 *     session-origin bearer token scoped to that chat — the same
 *     recovery technique internal-api-tier-authz.e2e.test.ts uses)
 *   - a real HTTP POST to the daemon's internal-api loopback server,
 *     through token-registry resolve + route-tiers + routes-reminders.ts's
 *     scope check, writing a row via the real reminders store/db
 *   - a real delivery send over HTTP to the fake ilink server's
 *     /ilink/bot/sendmessage endpoint (ilinkSendMessage + botTextMessage —
 *     the exact primitive ilink-glue's IlinkAdapter.sendMessage calls),
 *     landing in the SAME outbox degraded-boot/guest-path assert against
 *
 * What this drives DIRECTLY rather than through the daemon's own timer:
 *   - runReminderSweep itself. bootDaemon has no reminders-specific
 *     intervalMs test seam (BootDaemonOpts.schedulerIntervalMs only governs
 *     the companion push/introspect schedulers), so per the task brief this
 *     test calls the pure runReminderSweep function directly against a
 *     SECOND connection to the daemon's own on-disk sqlite file (WAL mode,
 *     opened the same way openWechatDb does for the CLI), with `nowIso`
 *     pushed past due_at instead of a real wall-clock wait. `send` is wired
 *     to hit the real fake-ilink HTTP server so the delivery assertion is
 *     against daemon.ilink.outbox(), not a locally-captured array.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from '../__e2e__/harness'
import { runReminderSweep } from './sweeper'
import { makeRemindersStore } from './store'
import { openWechatDb } from '../../lib/db'
// NOTE: '../ilink-glue' and '../../lib/ilink' both statically import
// '../../lib/config' (STATE_DIR), which is a module-level `const` frozen at
// FIRST import from process.env.WECHAT_STATE_DIR. startTestDaemon only sets
// that env var once it runs (inside the test body); a top-level static
// import here would evaluate config.ts — via vitest's eager test-file load —
// BEFORE the harness ever sets the env var, permanently freezing STATE_DIR
// to the real default and pointing access.ts et al at the wrong directory
// for the rest of the process (same failure mode dynamic-importing
// '../main' in harness.ts exists to avoid). Deferred to dynamic import
// inside the test body, after startTestDaemon has set the env vars.

const FIXTURE_CHAT = 'chat1' // harness default knownUsers entry
const REMINDER_TEXT = '提醒:喝水'

interface ApiInfo { baseUrl: string; tokenFilePath: string }

function readApiInfo(stateDir: string): ApiInfo {
  return JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as ApiInfo
}

/** Recover the per-session token the daemon baked into a spawn's wechat MCP
 *  env (same technique as internal-api-tier-authz.e2e.test.ts's sessionAuthOf). */
function sessionTokenOf(opts: Record<string, unknown>): string | undefined {
  const mcp = opts.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
  return mcp?.wechat?.env?.WECHAT_SESSION_TOKEN
}

describe('e2e: reminders — schedule → sweep → deliver, then no double delivery', () => {
  it('POST /v1/reminders/schedule, one sweep delivers exactly once, a second sweep sends nothing', async () => {
    const spawns: Record<string, unknown>[] = []
    const daemon = await startTestDaemon({
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
      recordClaudeSpawnOptions: o => { spawns.push(o) },
    })
    let db2: ReturnType<typeof openWechatDb> | undefined
    try {
      // 1. A real dispatch for FIXTURE_CHAT mints a session-origin token
      // scoped to this chat (sessionKey = provider/alias/chatId, baked into
      // the spawn's wechat MCP env). This is the ONLY kind of caller
      // routes-reminders.ts's scopeDenied lets touch this chat_id — a
      // session caller may only ever schedule for its own chat.
      daemon.sendText(FIXTURE_CHAT, 'hi')
      await daemon.waitForReplyTo(FIXTURE_CHAT)
      const sessionToken = spawns.map(sessionTokenOf).find((t): t is string => !!t)
      expect(sessionToken, `${FIXTURE_CHAT} spawn must carry a session token`).toBeTruthy()

      const { baseUrl } = readApiInfo(daemon.stateDir)

      // 2. Schedule through the real HTTP route, as a real session caller
      // would (POST /v1/reminders/schedule with a Bearer session token).
      const scheduleRes = await fetch(`${baseUrl}/v1/reminders/schedule`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: FIXTURE_CHAT, text: REMINDER_TEXT, delay_seconds: 1 }),
      })
      expect(scheduleRes.status).toBe(200)
      const scheduled = await scheduleRes.json() as { ok: boolean; reminder_id: string; due_at: string }
      expect(scheduled.ok).toBe(true)
      expect(scheduled.reminder_id).toBeTruthy()

      // 3. Drive the sweep against the daemon's REAL db (a second WAL
      // connection to the same on-disk sqlite file main.ts opened at boot —
      // openWechatDb is the same convenience wrapper the CLI uses for this).
      // nowIso is pushed past due_at instead of a real wall-clock wait.
      db2 = openWechatDb(daemon.stateDir)
      const store = makeRemindersStore(db2)
      const { loadAllAccounts } = await import('../ilink-glue')
      const { ilinkSendMessage, botTextMessage } = await import('../../lib/ilink')
      const [account] = await loadAllAccounts(daemon.stateDir)
      expect(account, 'harness must have written a bot account').toBeTruthy()
      const send = async (chatId: string, text: string) => {
        try {
          await ilinkSendMessage(account!.baseUrl, account!.token, botTextMessage(chatId, text))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const past = new Date(Date.parse(scheduled.due_at) + 1000).toISOString()

      const deliveredCount = () => daemon.ilink.outbox().filter(
        m => m.endpoint === 'sendmessage' && m.chatId === FIXTURE_CHAT && m.text === REMINDER_TEXT,
      ).length

      const sweep1 = await runReminderSweep({ store, send, nowIso: past, log: () => {} })
      expect(sweep1).toEqual({ delivered: 1, retried: 0, failed: 0, deferred: 0 })
      expect(deliveredCount()).toBe(1)

      const rowAfter1 = (await store.list(FIXTURE_CHAT)).find(r => r.id === scheduled.reminder_id)
      expect(rowAfter1?.status).toBe('sent')

      // 4. THE FALSIFICATION HALF — a second sweep at a later "now" must
      // NOT deliver again: listDue only returns status='pending' rows, and
      // this one is already 'sent'.
      const later = new Date(Date.parse(past) + 5000).toISOString()
      const sweep2 = await runReminderSweep({ store, send, nowIso: later, log: () => {} })
      expect(sweep2).toEqual({ delivered: 0, retried: 0, failed: 0, deferred: 0 })
      expect(deliveredCount()).toBe(1)
    } finally {
      db2?.close()
      await daemon.stop()
    }
  }, 20_000)
})
