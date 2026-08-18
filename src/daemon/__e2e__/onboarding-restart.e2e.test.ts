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
// This is ALSO the only test in the repo that catches the mw-dedup
// regression from 7914f7b5 (2026-06-25): onboarding's echo re-dispatch
// re-fires the ORIGINAL trigger message through the pipeline with the SAME
// message id. mw-dedup already marked that id "handled" at the end of turn
// 1 — this is true on EVERY new-user onboarding, same boot, no restart
// required — so without ctx.redispatch bypassing mw-dedup's isHandled
// check, the echo dispatch is silently swallowed and the user's original
// question never reaches the provider. The assertion below on
// `dispatchedTexts` is the one that would have failed pre-fix.
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
      const dispatchedTexts: string[] = []
      const second = await startTestDaemon({
        dangerously: true,
        stateDirOverride: stateDir,
        knownUsers: {},
        claudeScript: {
          async onDispatch(t) {
            dispatchedTexts.push(t)
            return { toolCalls: [], finalText: '@user 好嘞' }
          },
        },
      })
      try {
        second.sendText('chat1', '丸子')
        // With the mw-dedup fix, the redispatched original message now
        // ALSO reaches the (fake) provider, which sends its own reply into
        // the same outbox — so wait on the specific ack text rather than
        // "any sendmessage", and don't assume ordering with `.at(-1)`.
        const ackReplies = await second.waitForOutbound(
          msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1' && (m.text ?? '').includes('刚才你说')),
          8000,
        )
        const ackText = ackReplies.find(m => (m.text ?? '').includes('刚才你说'))?.text ?? ''
        // Continues the SAME flow: nickname accepted + echoes the ORIGINAL
        // trigger text from boot 1 — not a fresh "你好呀...称呼你" greeting.
        expect(ackText).not.toMatch(/称呼你/)
        expect(ackText).toMatch(/刚才你说「帮我查个天气」/)

        // The original first message (turn-1's trigger) was re-dispatched
        // through the normal pipeline and reached the (fake) provider —
        // this is the mw-dedup regression assertion. onDispatch receives
        // the fully formatted prompt, not the raw text, so check by
        // substring.
        const start = Date.now()
        while (dispatchedTexts.length === 0 && Date.now() - start < 3000) {
          await new Promise(r => setTimeout(r, 50))
        }
        expect(dispatchedTexts.some(t => t.includes('帮我查个天气'))).toBe(true)
      } finally {
        await second.stop()
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // The actually-common path: no restart at all. A fresh user greets, sends
  // their nickname, and the ORIGINAL trigger message must reach the
  // provider in the SAME boot — this is what 7914f7b5 broke for every new
  // user, not just the restart edge case above.
  it('fresh user, single boot: greet → nickname → echo reaches the provider (no restart)', async () => {
    const dispatchedTexts: string[] = []
    const daemon = await startTestDaemon({
      dangerously: true,
      knownUsers: {},   // chat1 must be unknown so onboarding fires
      claudeScript: {
        async onDispatch(t) {
          dispatchedTexts.push(t)
          return { toolCalls: [], finalText: '@user 好嘞' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '帮我查个天气')
      const greetReplies = await daemon.waitForReplyTo('chat1', 8000)
      expect(greetReplies.at(-1)?.text).toMatch(/称呼你/)

      daemon.sendText('chat1', '丸子')
      // waitForReplyTo's predicate is satisfied by the greeting already in
      // the outbox, so wait on the specific ack text instead — otherwise
      // this would resolve immediately without observing turn 2 at all.
      const ackReplies = await daemon.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1' && (m.text ?? '').includes('刚才你说')),
        8000,
      )
      const ackText = ackReplies.find(m => (m.text ?? '').includes('刚才你说'))?.text ?? ''
      expect(ackText).toMatch(/刚才你说「帮我查个天气」/)

      const start = Date.now()
      while (dispatchedTexts.length === 0 && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50))
      }
      expect(dispatchedTexts.some(t => t.includes('帮我查个天气'))).toBe(true)
    } finally {
      await daemon.stop()
    }
  })
})
