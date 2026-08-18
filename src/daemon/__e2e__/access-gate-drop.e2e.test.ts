// End-to-end acceptance test for the allowlist gate (mw-access) — the README's
// "everyone else is blocked by default" promise, AS AMENDED by the guest path
// (spec docs/superpowers/specs/2026-08-18-guest-path-design.md §2/§7): a
// non-allowlisted sender no longer gets PURE silence — that's a DELIBERATE
// behavior change the spec calls out by name (§7: "非白名单好友从纯静默变为
// 一次中性回复") — they now get exactly ONE neutral reply (and the owner
// gets notified, covered end-to-end by guest-path.e2e.test.ts), with zero
// OTHER pipeline side effects: no typing indicator, no onboarding greeting,
// no agent dispatch, no API tokens spent.
//
// This still locks the security-critical middleware ORDER in build.ts:
// mw-access sits before typing/onboarding/welcome/dispatch, so a
// non-allowlisted sender must trigger ZERO of those downstream stages — a
// future reorder that moved access after them would leak a typing
// indicator / onboarding greeting / real agent turn to a blocked sender,
// and this test would catch it. Pre-guest-path, this test asserted zero
// outbound at all; that assertion is now WRONG on purpose (see above), so
// it's narrowed to "at most the one guest-path neutral reply, nothing else".
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: mw-access gates a non-allowlisted sender before any pipeline side effect', () => {
  it('blocked sender gets only the guest-path neutral reply (no typing/onboarding/dispatch); allowlisted sender still replies normally', async () => {
    const daemon = await startTestDaemon({
      access: { allowFrom: ['allowed-user'], admins: ['allowed-user'] },
      knownUsers: { 'allowed-user': 'u1' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
    })
    try {
      // Warm up allowed-user's context_token via its OWN inbound first —
      // ilink's sendMessage needs one cached before the guest branch's
      // owner-notify (fired below by the blocked sender) can actually send.
      // Not itself under test here (guest-path.e2e.test.ts covers the
      // notify contract) — just avoids a spurious retry-log path muddying
      // this test's real assertions.
      daemon.sendText('allowed-user', 'hi first', { createTimeMs: Date.now() })
      await daemon.waitForReplyTo('allowed-user', 8000)

      // Send from the NON-allowlisted chat first, then from the allowlisted
      // one again. The poll loop processes inbounds in order, so once the
      // second allowlisted reply lands the blocked message has already been
      // fully handled — deterministic, no arbitrary sleep.
      daemon.sendText('blocked-user', 'let me in', { createTimeMs: Date.now() + 1000 })
      daemon.sendText('allowed-user', 'again', { createTimeMs: Date.now() + 2000 })

      await daemon.waitForOutbound(
        msgs => msgs.filter(m => m.chatId === 'allowed-user' && m.endpoint === 'sendmessage').length >= 2,
        8000,
      )

      const out = daemon.ilink.outbox()
      const blockedOut = out.filter(m => m.chatId === 'blocked-user')
      expect(
        blockedOut,
        'a non-allowlisted sender gets ONLY the guest-path neutral reply — no typing, no onboarding, no agent dispatch',
      ).toHaveLength(1)
      expect(blockedOut[0]?.endpoint).toBe('sendmessage')
      expect(blockedOut[0]?.text).toBe('我需要主人确认一下,稍等哦~')

      // Sanity: the allowlisted user's normal turns still go through the
      // same pipeline (dispatch/typing/etc all intact for allowed senders).
      expect(out.filter(m => m.endpoint === 'sendmessage' && m.chatId === 'allowed-user').length).toBeGreaterThanOrEqual(2)
    } finally {
      // Belt-and-braces — access.ts's loadAccess() cache + invalidator are
      // process-global (user-tier.e2e.test.ts's convention); this test's
      // guest-path appendAllowFrom side effects (none expected here, but
      // the notify path does read access.json) must not leak into a
      // sibling e2e test file sharing the same worker process.
      try {
        const access = await import('../../lib/access')
        access._clearCache()
        access._resetSnapshotForTest()
      } catch { /* module not yet imported — nothing to reset */ }
      await daemon.stop()
    }
  })
})
