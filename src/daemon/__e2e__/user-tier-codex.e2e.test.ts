// End-to-end acceptance test for the 3-tier permission feature — codex side.
//
// Symmetric to user-tier.e2e.test.ts (which covers the Claude side):
//   inbound  → coordinator → resolveTier → manager.acquire →
//   codex.spawn → tierProfileToCodexSdkOpts → codex SDK options
//
// The unit test in core/codex-agent-provider.test.ts already verifies the
// pure tierProfileToCodexSdkOpts function — what this catches is the
// wiring around it. If session-manager stops threading tierProfile into
// codex.spawn, if the coordinator routes to claude instead of codex when
// mode says codex, or if codex provider's spawnOpts contract drifts,
// this test fails.
//
// Scenario — tier maps to codex SDK options:
//   Two chats on the same daemon — one in `admins`, one not, both with
//   mode=solo+codex — produce different `sandboxMode` + `approvalPolicy`
//   on `Codex.startThread()` at spawn time. Admin gets
//   `danger-full-access` + `never`; guest gets `read-only` +
//   `untrusted`.
//
// Tier-change-invalidation is NOT re-exercised here — user-tier.e2e
// already proves that conceptual invariant (the access invalidator is
// provider-agnostic), and doubling it on the codex side would just
// duplicate the access.json plumbing without exercising any new path.
//
// The harness `recordCodexSpawnOptions` hook (added alongside this test)
// captures the thread options passed to every `Codex.startThread()` /
// `resumeThread()` whose thread is later run via `runStreamed` — i.e.
// every AgentSession spawn, not the cheapEval path (which uses
// `thread.run()`, not implemented in the fake).
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

interface CodexSpawnRecord {
  sandboxMode: string
  approvalPolicy: string
  workingDirectory?: string
}

function asCodexSpawnRecord(opts: Record<string, unknown>): CodexSpawnRecord {
  return {
    sandboxMode: String(opts.sandboxMode ?? ''),
    approvalPolicy: String(opts.approvalPolicy ?? ''),
    ...(typeof opts.workingDirectory === 'string' ? { workingDirectory: opts.workingDirectory } : {}),
  }
}

describe('e2e: user-tier permissions (codex)', () => {
  it('admin/guest get tier-specific codex SDK options at startThread', async () => {
    const spawns: CodexSpawnRecord[] = []
    const daemon = await startTestDaemon({
      // dangerously=false so resolveTier honors access.json rather than
      // forcing everyone to admin tier.
      dangerously: false,
      access: {
        allowFrom: ['admin_chat', 'guest_chat'],
        admins: ['admin_chat'],
      },
      knownUsers: { admin_chat: 'admin_user', guest_chat: 'guest_user' },
      // Pin both chats to solo+codex so the coordinator routes them
      // through the codex provider's spawn path (not claude).
      modes: {
        admin_chat: { kind: 'solo', provider: 'codex' },
        guest_chat: { kind: 'solo', provider: 'codex' },
      },
      codexScript: {
        async onDispatch(_text) {
          // Empty body — we only need the spawn to happen. The recorder
          // fires on runStreamed before any onDispatch logic runs.
          return { toolCalls: [], finalText: 'ok' }
        },
      },
      recordCodexSpawnOptions: opts => {
        spawns.push(asCodexSpawnRecord(opts))
      },
    })
    try {
      // Send from admin first, wait for reply (proves dispatch finished),
      // then from guest. Sequencing avoids races over the shared recorder
      // array.
      daemon.sendText('admin_chat', 'hi from admin')
      await daemon.waitForReplyTo('admin_chat', 8000)

      daemon.sendText('guest_chat', 'hi from guest')
      await daemon.waitForReplyTo('guest_chat', 8000)

      // Two spawns so far — one per chatId. The recorder is wired only
      // to the runStreamed path so cheapEval (thread.run, not
      // implemented in the fake) can't add records.
      expect(spawns.length).toBe(2)

      const adminSpawn = spawns.find(s => s.sandboxMode === 'danger-full-access')
      expect(adminSpawn, 'expected a danger-full-access spawn for admin_chat').toBeTruthy()
      if (adminSpawn) {
        // Admin profile: full access + no approval prompt — matches the
        // old --dangerously posture that session-manager used to emit
        // unconditionally pre-tiers.
        expect(adminSpawn.approvalPolicy).toBe('never')
      }

      const guestSpawn = spawns.find(s => s.sandboxMode === 'read-only')
      expect(guestSpawn, 'expected a read-only spawn for guest_chat').toBeTruthy()
      if (guestSpawn) {
        // The headline guarantee on the codex side: a chat that can DM
        // the bot but isn't an admin runs codex with no write access
        // and an approval prompt the daemon's headless setup can't
        // answer — i.e. functionally restricted to reading + replying.
        expect(guestSpawn.approvalPolicy).toBe('untrusted')
      }
    } finally {
      await daemon.stop()
    }
  })
})
