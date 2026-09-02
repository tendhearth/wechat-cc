import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireSocial } from './wire-social'
import { openTestDb } from '../../lib/db'
import { makeA2AEventsStore } from '../../core/a2a-events-store'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { AgentConfig } from '../../lib/agent-config'

// ─── busy-registry hold (spec 2026-08-11 §2, Task 4 step 4) ────────────────
//
// End-to-end (through the real wireSocial() construction, not just the
// makeBusySchedule unit in wire-social.busy.test.ts): confirmSeek's
// `schedule(() => forage(...))` call must actually run through the
// holdBusy-wrapped schedule wired in below.
describe('wireSocial — busy-registry hold around forage()', () => {
  it('holds "social-forage" for the scheduled forage triggered by confirmSeek, released once it settles', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-busy-'))
    try {
      const events: string[] = []
      const release = vi.fn(() => events.push('release'))
      const holdBusy = vi.fn((label: string) => { events.push(`hold:${label}`); return release })

      const configuredAgent: AgentConfig = {
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }
      // No candidates → forage() resolves immediately after discover()
      // without needing a real a2aClient.send round-trip.
      const a2aRegistry: A2ARegistry = {
        list: () => [],
        get: () => null,
        verifyBearer: () => null,
        add: () => {},
        remove: () => {},
        setPaused: () => {},
        update: () => { throw new Error('not used by this test') },
      }
      const a2aClient: A2AClient = {
        fetchAgentCard: async () => { throw new Error('not used by this test') },
        send: async () => ({ ok: true }),
      }
      // gateOutbound (called by propose()) asks this for a verdict; no
      // violation → propose succeeds and confirmSeek can flip it to foraging.
      const registry = {
        getCheapEval: () => async () => JSON.stringify({ violation: false }),
        getCheapEvalBudgetMs: () => 12_000,
      } as unknown as ProviderRegistry

      const wiring = await wireSocial({
        log: () => {},
        stateDir,
        db: openTestDb(),
        configuredAgent,
        selfId: 'test-self',
        registry,
        defaultProviderId: 'claude',
        pluginMcp: {},   // judge no longer depends on pluginMcp (in-proc grounding via `knowledge`, SJ Task 3) — kept empty, just satisfying the required field
        currentClaudeModel: () => 'claude-opus-4-8',
        claudeBin: undefined,
        resolveOperatorChatId: () => null,
        sendAssistantText: undefined,
        a2aRegistry,
        a2aClient,
        eventsStore: makeA2AEventsStore(openTestDb()),
        holdBusy,
      })

      expect(wiring.social).toBeDefined()
      const proposed = await wiring.social!.broker.propose('找摄影搭子')
      expect(proposed.ok).toBe(true)
      if (!proposed.ok) return
      expect(holdBusy).not.toHaveBeenCalled()   // propose() itself doesn't forage

      const confirmed = wiring.social!.broker.confirmSeek(proposed.intent_id)
      expect(confirmed.ok).toBe(true)

      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
      expect(holdBusy).toHaveBeenCalledTimes(1)
      expect(holdBusy).toHaveBeenCalledWith('social-forage')
      expect(events).toEqual(['hold:social-forage', 'release'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
