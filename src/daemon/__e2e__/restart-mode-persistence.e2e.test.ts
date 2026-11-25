// Tier 3 / T3.3 — daemon restart preserves chat mode through SQLite.
//
// Scenario: user sets chat to chatroom, daemon stops (service restart,
// `wechat-cc update`, crash, machine reboot), daemon starts again.
// Mode must survive. Pre-PR7 this was a JSON file; post-PR7 it's a row
// in `wechat-cc.db`. This test pins the round-trip so a future
// migration / schema rename doesn't silently lose user prefs.
//
// What this catches:
//   - conversation-store schema regressions
//   - migration source consumed but data not transferred
//   - boot sequence opens db at the wrong path
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTestDaemon } from './harness'

describe('e2e: chat mode survives daemon stop+start cycle', () => {
  it('chatroom mode persisted in first boot is honored on the second', async () => {
    // We own the stateDir across both boots so the SQLite db carries over.
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-e2e-restart-'))
    // Chatroom needs two admitted providers. Codex is unavailable to guests.
    const access = { admins: ['chat1'], allowFrom: ['chat1'] }
    const verdict = '聊天室裁决已完成。'
    let modCalledOnSecondBoot = false

    try {
      // ── First boot — set mode=chatroom for chat1, then stop. ─────────
      const first = await startTestDaemon({
        dangerously: true,
        stateDirOverride: stateDir,
        access,
        modes: { chat1: { kind: 'chatroom' } },
        claudeScript: { async onDispatch(_t) { return { toolCalls: [], finalText: '' } } },
        codexScript: { async onDispatch(_t) { return { toolCalls: [], finalText: '' } } },
      })
      await first.stop()

      // ── Second boot — same stateDir, NO modes preset. If persistence
      // works, conversation-store reads the chatroom row from SQLite and
      // the inbound triggers the moderator path (proving chatroom mode).
      const second = await startTestDaemon({
        dangerously: true,
        stateDirOverride: stateDir,
        access,
        // Deliberately omit `modes` — must come from the persisted db.
        claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'Claude 开场' } } },
        codexScript: { async onDispatch() { return { toolCalls: [], finalText: 'Codex 开场' } } },
        moderatorScript: {
          async onEval(prompt) {
            if (!prompt.includes('给出最终裁决')) return JSON.stringify({ contested: [], agreed: [] })
            modCalledOnSecondBoot = true
            return verdict
          },
        },
      })
      try {
        second.sendText('chat1', '你好')
        // Opening replies can arrive before the moderator runs.
        await expect.poll(() => second.ilink.outbox().some(reply =>
          reply.endpoint === 'sendmessage' && reply.chatId === 'chat1' && reply.text?.startsWith(`🎯 ${verdict}`),
        ), { timeout: 8000 }).toBe(true)
        expect(modCalledOnSecondBoot).toBe(true)
      } finally {
        await second.stop()
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
