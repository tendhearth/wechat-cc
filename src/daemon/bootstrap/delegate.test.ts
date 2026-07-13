import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDelegateDispatch } from './delegate'
import { makeFakeSession } from '../../core/test-helpers'
import type { AgentProvider } from '../../core/agent-provider'

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), 'delegate-'))
}

describe('buildDelegateDispatch — openai/Kimi peer wiring', () => {
  it('reports unknown_peer for openai when the backend is NOT configured', async () => {
    // No agent-config.json in the temp state dir → openaiBaseUrl/openaiModel
    // undefined → the bare openai delegate is never built (null), regardless
    // of any ambient WECHAT_OPENAI_API_KEY.
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('openai', 'hi')
    expect(r).toEqual({ ok: false, reason: 'unknown_peer: openai' })
  })

  it('routes peer "openai" through the delegate map and returns its reply', async () => {
    // Inject a fake provider for openai (bypasses real construction / network),
    // proving the (peer → provider) routing handles openai. Before openai was
    // wired into the switch this returned unknown_peer.
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'text', text: 'kimi-here' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toBe('kimi-here')
  })

  it('still reports unknown_peer for a genuinely unknown provider', async () => {
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('bogus-provider', 'hi')
    expect(r).toEqual({ ok: false, reason: 'unknown_peer: bogus-provider' })
  })
})
