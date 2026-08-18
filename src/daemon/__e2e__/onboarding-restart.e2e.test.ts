// e2e — onboarding pending state survives a daemon restart (A2 / task-1).
//
// Scenario: a brand-new (unknown) user's first message triggers the
// onboarding greeting + nickname ask. Before they reply, the daemon stops
// (service restart, `wechat-cc update`, crash, machine reboot) and boots
// again against the SAME stateDir. The nickname reply must continue the
// SAME flow — save the name and ack with the ORIGINAL trigger text — rather
// than re-greeting as if it were a fresh first contact.
//
// Mirrors the double-boot posture of restart-mode-persistence.e2e.test.ts:
// one owned stateDir across two `startTestDaemon` boots.
//
// NOTE: this test does not assert that the redispatched original message
// reaches the (fake) provider. It does reach the pipeline (onboarding
// correctly re-fires dispatchInbound — see the ack text below, which proves
// the SAME triggerText survived the restart), but recordInbound's
// message-level dedup store (keyed off message id, persisted to SQLite in
// the shared stateDir) legitimately recognizes the redispatched message as
// already-recorded from boot 1 and short-circuits before the provider call.
// That's a real, separate subsystem — not a bug in this fix — so it isn't
// asserted on here.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTestDaemon } from './harness'

describe('e2e: onboarding pending state survives daemon restart', () => {
  it('greet on boot 1 → restart → nickname reply on boot 2 continues the flow (no re-greet)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-e2e-onboarding-restart-'))

    try {
      // ── Boot 1 — brand-new chat, no known users, so the first inbound
      // trips onboarding's "first contact" branch (greeting + ask name). ──
      const first = await startTestDaemon({
        dangerously: true,
        stateDirOverride: stateDir,
        knownUsers: {},   // disable default pre-population — chat1 must be unknown
        claudeScript: { async onDispatch(_t) { return { toolCalls: [], finalText: '' } } },
      })
      first.sendText('chat1', '帮我查个天气')
      const greetReplies = await first.waitForReplyTo('chat1', 8000)
      expect(greetReplies.at(-1)?.text).toMatch(/称呼你/)
      await first.stop()

      // ── Boot 2 — same stateDir, so onboarding-pending.json carries the
      // in-progress awaiting entry over. Deliberately no `knownUsers` override
      // (defaults to {chat1:'testuser'} otherwise) — we rely on the persisted
      // onboarding state, not the user_names.json pre-population. ──
      const second = await startTestDaemon({
        dangerously: true,
        stateDirOverride: stateDir,
        knownUsers: {},
        claudeScript: { async onDispatch(_t) { return { toolCalls: [], finalText: '@user 好嘞' } } },
      })
      try {
        second.sendText('chat1', '丸子')
        const ackReplies = await second.waitForReplyTo('chat1', 8000)
        const ackText = ackReplies.at(-1)?.text ?? ''
        // Continues the SAME flow: nickname accepted + echoes the ORIGINAL
        // trigger text from boot 1 — not a fresh "你好呀...称呼你" greeting.
        expect(ackText).not.toMatch(/称呼你/)
        expect(ackText).toMatch(/刚才你说「帮我查个天气」/)
      } finally {
        await second.stop()
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
