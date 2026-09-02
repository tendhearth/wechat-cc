import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireSocial } from './wire-social'
import { openTestDb } from '../../lib/db'
import type { A2AEventsStore } from '../../core/a2a-events-store'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { AgentConfig } from '../../lib/agent-config'
import type { A2AAgentRecord } from '../../lib/agent-config'

// ─── peer-closeness ranked fan-out (2026-08-13 discover-peer-closeness, T2) ─
//
// Task 1 (core/peer-closeness.ts, rankPeersByCloseness) is unit-tested on
// its own; this file covers the WIRING — that both fan-out sites in
// wire-social.ts (degree-1 broker.discover and the hop+1
// forward-to-own-peers path) actually call it with the real
// A2AEventsStore-shaped dep, AND that doing so did not drop either site's
// existing eligibility filters (paused; the forward site's
// id !== excludeAgentId + mailbox-without-url exclusion) — only the
// ordering + cap changed.

function agent(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `http://${id}.test/a2a/notify`,
    inbound_api_key: '0123456789abcdef', outbound_api_key: 'k',
    capabilities: [], paused: false, transport: 'push',
    ...overrides,
  }
}

/** Fake PeerEventsView (A2AEventsStore-shaped): peers named in `recent` read
 *  back as clearly closer (recent + mutual in/out) than any peer omitted
 *  (falls to the {inbound:0, outbound:0}/no-recent-event default → score 0). */
function makeFakeEventsStore(recent: Record<string, { inbound: number; outbound: number; ts: string }>): A2AEventsStore {
  return {
    append: () => {},
    counts: (id) => recent[id] ? { inbound: recent[id].inbound, outbound: recent[id].outbound } : { inbound: 0, outbound: 0 },
    recentForAgent: (id) => recent[id]
      ? [{ id: `${id}-ev`, ts: recent[id].ts, direction: 'in' as const, agent_id: id, text: '', urgency: null, status: 'ok' as const, http_status: null }]
      : [],
  }
}

const baseConfiguredAgent: AgentConfig = {
  provider: 'claude',
  dangerouslySkipPermissions: false,
  autoStart: false,
  closeStopsDaemon: false,
  social_enabled: true,
  social_disclosure_policy: '兴趣可说；住址不可',
}

describe('wireSocial — peer-closeness ranked fan-out (PC T2)', () => {
  it('broker.discover (via propose→confirmSeek→forage) sends to the closer peer first, still excludes a paused peer', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-discover-'))
    try {
      const sent: string[] = []
      const peers = [agent('near'), agent('far'), agent('paused-peer', { paused: true })]
      const a2aRegistry: A2ARegistry = {
        list: () => peers,
        get: (id) => peers.find(a => a.id === id) ?? null,
        verifyBearer: () => null,
        add: () => {}, remove: () => {}, setPaused: () => {},
        update: () => { throw new Error('not used by this test') },
      }
      const a2aClient: A2AClient = {
        fetchAgentCard: async () => { throw new Error('not used by this test') },
        send: async ({ url }) => { sent.push(url); return { ok: true } },
      }
      const registry = {
        getCheapEval: () => async () => JSON.stringify({ violation: false }),
        getCheapEvalBudgetMs: () => 12_000,
      } as unknown as ProviderRegistry
      // 'near' has recent (now) + mutual (in>0,out>0) events; 'far' has none
      // — rankPeersByCloseness must place 'near' first regardless of the
      // registry.list() enumeration order above.
      const eventsStore = makeFakeEventsStore({ near: { inbound: 3, outbound: 3, ts: new Date().toISOString() } })

      const wiring = await wireSocial({
        log: () => {}, stateDir, db: openTestDb(), configuredAgent: baseConfiguredAgent, selfId: 'test-self',
        registry, defaultProviderId: 'claude', pluginMcp: {}, currentClaudeModel: () => 'claude-opus-4-8',
        claudeBin: undefined, resolveOperatorChatId: () => null, sendAssistantText: undefined,
        a2aRegistry, a2aClient, eventsStore,
      })

      const proposed = await wiring.social!.broker.propose('找摄影搭子')
      expect(proposed.ok).toBe(true)
      if (!proposed.ok) return
      const confirmed = wiring.social!.broker.confirmSeek(proposed.intent_id)
      expect(confirmed.ok).toBe(true)

      await vi.waitFor(() => expect(sent.length).toBe(2))
      // Closeness order (near first), and the paused peer never fanned out to
      // at all — eligibility filter preserved, ranker changed ordering only.
      expect(sent).toEqual(['http://near.test/a2a/intent', 'http://far.test/a2a/intent'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('hop+1 forward-to-own-peers sends to the closer peer first, still excludes paused/sender/url-less-mailbox peers', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-forward-'))
    try {
      const sent: string[] = []
      const peers = [
        agent('near'),
        agent('far'),
        agent('paused-peer', { paused: true }),
        agent('sender'), // same id as the inbound event's sender — must be excluded (never forward to the sender)
        agent('nomail', { transport: 'mailbox', url: undefined, mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://r/'] }),
      ]
      const a2aRegistry: A2ARegistry = {
        list: () => peers,
        get: (id) => peers.find(a => a.id === id) ?? null,
        verifyBearer: () => null,
        add: () => {}, remove: () => {}, setPaused: () => {},
        update: () => { throw new Error('not used by this test') },
      }
      const a2aClient: A2AClient = {
        fetchAgentCard: async () => { throw new Error('not used by this test') },
        send: async ({ url }) => { sent.push(url); return { ok: true } },
      }
      // The judge's runTurn throwing is fine — social-judge.ts fails a throwing
      // runTurn closed to {match:'no'} (no echo attempted); this test only
      // cares about the ② forward fan-out, which the responder runs
      // unconditionally on ①'s outcome.
      const registry = {
        getCheapEval: () => async () => { throw new Error('judge unused by this test') },
        getCheapEvalBudgetMs: () => 12_000,
      } as unknown as ProviderRegistry
      const eventsStore = makeFakeEventsStore({ near: { inbound: 4, outbound: 4, ts: new Date().toISOString() } })

      const wiring = await wireSocial({
        log: () => {}, stateDir, db: openTestDb(), configuredAgent: baseConfiguredAgent, selfId: 'test-self',
        registry, defaultProviderId: 'claude', pluginMcp: {}, currentClaudeModel: () => 'claude-opus-4-8',
        claudeBin: undefined, resolveOperatorChatId: () => null, sendAssistantText: undefined,
        a2aRegistry, a2aClient, eventsStore,
      })

      expect(wiring.onIntent).toBeDefined()
      const card = { intent_id: 'intent-1', kind: 'seek' as const, topic: '找摄影搭子', expires_at: new Date(Date.now() + 60_000).toISOString(), hop: 1 }
      const receipt = await wiring.onIntent!({ agent: agent('sender'), card })
      expect(receipt.async).toBe(true)

      await vi.waitFor(() => {
        const forwardSends = sent.filter(u => u.endsWith('/a2a/intent'))
        expect(forwardSends.length).toBe(2)
      })
      const forwardSends = sent.filter(u => u.endsWith('/a2a/intent'))
      expect(forwardSends).toEqual(['http://near.test/a2a/intent', 'http://far.test/a2a/intent'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
