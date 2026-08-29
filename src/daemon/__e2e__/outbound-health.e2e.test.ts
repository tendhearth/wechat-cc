// End-to-end acceptance test for outbound send-health on the real HTTP
// surface (spec 2026-08-22-outbound-health Task 5).
//
// Task 2 (src/daemon/ilink-glue.outbound.test.ts) already proves
// degraded→recovery at the ADAPTER level — makeIlinkAdapter constructed
// directly against startFakeIlink(), asserting outboundHealth() snapshots.
// Task 3 (routes-health.test.ts) proves the /v1/health ROUTE renders the
// dep correctly with a stub `outbound()` thunk. Neither proves the real
// wiring chain: real ilink-glue adapter → main.ts's `outbound: () =>
// ilink.outboundHealth()` dep → createInternalApi's route table → an actual
// HTTP response.
//
// This is that missing link. It boots the real daemon (bootDaemon, same
// path as cli.ts) via the __e2e__ harness against a fake ilink server,
// drives real inbound→reply turns so the real adapter makes real wire
// sendmessage calls, and reads the outcome back over real loopback HTTP
// using the daemon's own discovery file + token — the same pattern
// internal-api-tier-authz.e2e.test.ts uses to reach the internal API as an
// external caller would.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

interface ApiInfo { baseUrl: string; tokenFilePath: string }

function readApiInfo(stateDir: string): ApiInfo {
  return JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as ApiInfo
}

interface HealthBody {
  outbound?: { state: string; consecutive_failures: number; last_ok_at: string | null; last_error: string | null }
}

async function getHealth(baseUrl: string, token: string): Promise<HealthBody> {
  const r = await fetch(`${baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` } })
  expect(r.status).toBe(200)
  return (await r.json()) as HealthBody
}

/** Poll GET /v1/health until `predicate(body.outbound)` is true or timeout. */
async function waitForOutboundHealth(
  baseUrl: string,
  token: string,
  predicate: (o: NonNullable<HealthBody['outbound']>) => boolean,
  timeoutMs = 8000,
): Promise<NonNullable<HealthBody['outbound']>> {
  const deadline = Date.now() + timeoutMs
  let last: HealthBody['outbound']
  while (Date.now() < deadline) {
    const body = await getHealth(baseUrl, token)
    last = body.outbound
    if (last && predicate(last)) return last
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for outbound health condition; last snapshot: ${JSON.stringify(last)}`)
}

describe('e2e: outbound send-health is visible end-to-end on GET /v1/health', () => {
  it('degrades after 2 failed sends, recovers to ok after the next success', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ack' } } },
    })
    try {
      const { baseUrl, tokenFilePath } = readApiInfo(daemon.stateDir)
      const token = readFileSync(tokenFilePath, 'utf8').trim()

      // Settle the boot-time startup notify (notify-startup.ts fires a
      // fire-and-forget sendMessage to admins on first boot — see main.ts's
      // runStartupSweeps). It targets the default admin chat ('testadmin'),
      // not the 'chat1' this test drives, but it shares the SAME adapter-
      // level health tracker. Wait for it to land (state leaves 'unknown')
      // or for a bounded quiet period to pass, so it can't race our
      // controlled failure count below. Either way the tracker is left at
      // consecutive_failures===0 (a success resets it; never-touched is 0
      // from init) — this is just eliminating a timing race, not a
      // meaningful assertion.
      const settleDeadline = Date.now() + 1500
      let settled = await getHealth(baseUrl, token)
      while (Date.now() < settleDeadline && settled.outbound?.state === 'unknown') {
        await new Promise(r => setTimeout(r, 50))
        settled = await getHealth(baseUrl, token)
      }
      expect(settled.outbound?.consecutive_failures).toBe(0)

      // 1. Force the wire to fail (default errcode -6, non-retryable — same
      // toggle + default Task 2 uses, for the same reason: one wire attempt
      // per sendMessage call, no 1s retry backoff to wait out).
      daemon.ilink.failSendMessage()

      daemon.sendText('chat1', 'trigger-fail-1')
      await waitForOutboundHealth(baseUrl, token, o => o.consecutive_failures >= 1)

      daemon.sendText('chat1', 'trigger-fail-2')
      const degraded = await waitForOutboundHealth(baseUrl, token, o => o.consecutive_failures >= 2)

      expect(degraded.state).toBe('degraded')
      expect(degraded.consecutive_failures).toBe(2)
      expect(degraded.last_error).toContain('auth failed')

      // 2. Flip the wire back to success and drive one more turn — recovery.
      daemon.ilink.succeedSendMessage()
      daemon.sendText('chat1', 'trigger-recover')
      const recovered = await waitForOutboundHealth(baseUrl, token, o => o.state === 'ok')

      expect(recovered.state).toBe('ok')
      expect(recovered.consecutive_failures).toBe(0)
      expect(recovered.last_ok_at).not.toBeNull()

      // Corroborate via the outbox too: the recovery send actually reached
      // fake-ilink and was captured (not just that the tracker flipped).
      const replies = await daemon.waitForReplyTo('chat1', 2000)
      expect(replies.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1')).toBe(true)
    } finally {
      await daemon.stop()
    }
  }, 30_000)
})
