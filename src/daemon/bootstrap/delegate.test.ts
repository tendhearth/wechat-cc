import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDelegateDispatch } from './delegate'
import { makeFakeSession } from '../../core/test-helpers'
import type { AgentProvider } from '../../core/agent-provider'

// Bug #86 regression seam — spy on the real factory so we can assert it is
// NEVER invoked when no codexPathOverride is supplied. This is the only way
// to observe "construction was skipped" from outside delegate.ts: the real
// createCodexAgentProvider eagerly constructs the SDK (new Codex() inside
// its factory), which is exactly what crashes boot in a compiled bundle
// (findCodexPath() can't resolve @openai/codex from /$bunfs). Mocking it
// here means these tests don't depend on that codepath actually throwing —
// they assert the conditional construction directly.
const createCodexAgentProviderMock = vi.fn((_opts?: unknown) => ({ spawn: vi.fn() }) as unknown as AgentProvider)
vi.mock('../../core/codex-agent-provider', () => ({
  createCodexAgentProvider: (opts?: unknown) => createCodexAgentProviderMock(opts),
}))

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

  it('surfaces a turn error event as ok:false instead of an empty success (collectTurn.error inspected)', async () => {
    // Providers surface failures as error EVENTS (openai auth failures, etc.)
    // rather than throwing — dispatch() must inspect result.error and NOT
    // just drain collectTurn into an always-ok:true empty response.
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'error', code: 'auth_failed', message: '401 unauthorized' },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('auth_failed')
  })

  it('still reports unknown_peer for a genuinely unknown provider', async () => {
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('bogus-provider', 'hi')
    expect(r).toEqual({ ok: false, reason: 'unknown_peer: bogus-provider' })
  })
})

// ─── codex delegate is conditional on a verified CLI (#86) ─────────────────
describe('buildDelegateDispatch — codex peer is conditional on codexPathOverride', () => {
  it('does NOT construct the codex provider when no codexPathOverride is passed (the boot-crash regression)', () => {
    createCodexAgentProviderMock.mockClear()
    buildDelegateDispatch({ stateDir: tmpState() })
    // The real factory eagerly constructs the SDK — never calling it at all
    // (not "call it and swallow the throw") is the fix: a refused/absent
    // codex CLI must not touch codex construction at boot.
    expect(createCodexAgentProviderMock).not.toHaveBeenCalled()
  })

  it('reports unknown_peer for codex when no codexPathOverride is passed', async () => {
    const dispatch = buildDelegateDispatch({ stateDir: tmpState() })
    const r = await dispatch('codex', 'hi')
    expect(r).toEqual({ ok: false, reason: 'unknown_peer: codex' })
  })

  it('logs a BOOT-visible line when the codex delegate is skipped', () => {
    const log = vi.fn()
    buildDelegateDispatch({ stateDir: tmpState(), log })
    expect(log).toHaveBeenCalledWith('BOOT', expect.stringContaining('codex delegate not registered'))
  })

  it('DOES construct the codex provider when codexPathOverride is passed (verified CLI)', () => {
    createCodexAgentProviderMock.mockClear()
    const log = vi.fn()
    buildDelegateDispatch({ stateDir: tmpState(), codexPathOverride: '/usr/local/bin/codex', log })
    expect(createCodexAgentProviderMock).toHaveBeenCalledTimes(1)
    expect(createCodexAgentProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ codexPathOverride: '/usr/local/bin/codex' }),
    )
    // No skip line when the delegate was actually built.
    expect(log).not.toHaveBeenCalledWith('BOOT', expect.stringContaining('codex delegate not registered'))
  })
})

// ─── busy-registry hold (spec 2026-08-11 §2, Task 4 step 3) ────────────────
describe('buildDelegateDispatch — busy-registry hold', () => {
  it('holds a token spanning spawn→dispatch→close, released after the session settles', async () => {
    const events: string[] = []
    const release = vi.fn(() => events.push('release'))
    const holdBusy = vi.fn((label: string) => { events.push(`hold:${label}`); return release })
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        // At the moment the session actually does work, the hold must already
        // be active and not yet released — proves it spans the real work, not
        // just bookend log lines.
        onDispatch: () => {
          expect(holdBusy).toHaveBeenCalledTimes(1)
          expect(release).not.toHaveBeenCalled()
        },
        events: [
          { kind: 'text', text: 'kimi-here' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    expect(holdBusy).toHaveBeenCalledWith('a2a-delegate')
    expect(release).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['hold:a2a-delegate', 'release'])
  })

  it('releases the token even when the peer session throws (spawn failure)', async () => {
    const release = vi.fn()
    const holdBusy = vi.fn(() => release)
    const throwingOpenai: AgentProvider = { spawn: async () => { throw new Error('spawn boom') } }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: throwingOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(false)
    expect(holdBusy).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('never holds a token for unknown_peer — the short-circuit before any session work', async () => {
    const holdBusy = vi.fn()
    const dispatch = buildDelegateDispatch({ stateDir: tmpState(), holdBusy })
    const r = await dispatch('bogus-provider', 'hi')
    expect(r).toEqual({ ok: false, reason: 'unknown_peer: bogus-provider' })
    expect(holdBusy).not.toHaveBeenCalled()
  })

  it('a holdBusy that throws never breaks dispatch (defensive catch)', async () => {
    const holdBusy = vi.fn(() => { throw new Error('registry exploded') })
    const fakeOpenai: AgentProvider = {
      spawn: async () => makeFakeSession({
        events: [
          { kind: 'text', text: 'ok' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      }),
    }
    const dispatch = buildDelegateDispatch({
      stateDir: tmpState(),
      delegateProviders: { openai: fakeOpenai },
      holdBusy,
    })
    const r = await dispatch('openai', 'ping')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response).toBe('ok')
  })
})
