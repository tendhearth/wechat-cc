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
//   on `Codex.startThread()` at spawn time. Under strict mode
//   (dangerously=false) admin gets `workspace-write` + `never`; guest
//   gets `read-only` + `untrusted`. (Post-RFC-05, admin no longer gets
//   `danger-full-access` in strict mode — its destructive ops relay, and
//   codex can't honor a relay, so it drops to workspace-write. Only
//   `--dangerously` yields `danger-full-access`, regardless of tier.)
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
// `thread.run()` — the fake DOES implement `run()`, but it deliberately
// does not record a spawn there; see fake-sdk.ts's FakeCodexThread.run).
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
  it('admin gets tier-specific codex SDK options at startThread; a guest is refused before any spawn', async () => {
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

      // 访客:Codex 对访客关门(2026-10-10,guestSafe:false —— 只读沙盒照样能读整台电脑),
      // 根本不起 codex,收到一句说明。
      daemon.sendText('guest_chat', 'hi from guest')
      const guestReplies = await daemon.waitForReplyTo('guest_chat', 8000)
      expect(guestReplies.map(r => r.text).join('\n')).toContain('/codex 对访客不开放')

      // `run()` IS implemented in the fake (the first-use probe's cheapEval depends on it), but the
      // recorder is wired only inside `runStreamed`, so `run()` never fires it — cheapEval can't add records here.
      expect(spawns.length).toBe(1)

      const adminSpawn = spawns.find(s => s.sandboxMode === 'workspace-write')
      expect(adminSpawn, 'expected a workspace-write spawn for admin_chat').toBeTruthy()
      if (adminSpawn) {
        // Admin profile under strict mode: write within cwd, no approval
        // prompt. danger-full-access is --dangerously-only (see tierProfileToCodexSdkOpts).
        expect(adminSpawn.approvalPolicy).toBe('never')
      }
      expect(spawns.find(s => s.sandboxMode === 'read-only')).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })
})
