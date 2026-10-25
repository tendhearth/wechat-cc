import { describe, it, expect } from 'vitest'
import {
  CAPABILITY_MATRIX,
  lookup,
  assertMatrixComplete,
  capabilitiesFor,
  capabilityProviderIds,
  type MatrixRow,
  type PermissionMode,
} from './capability-matrix'
import type { Mode, ProviderId } from './conversation'

describe('ProviderCapabilities.defaultPeer', () => {
  it('declares each provider\'s delegate_<peer> target (single source for primary_tool pairing)', () => {
    // Removes the old 2-provider `=== "codex" ? "claude" : "codex"` ternary in
    // bootstrap. Adding a provider = declare its defaultPeer, not edit a branch.
    expect(capabilitiesFor('claude').defaultPeer).toBe('codex')
    expect(capabilitiesFor('codex').defaultPeer).toBe('claude')
    expect(capabilitiesFor('cursor').defaultPeer).toBe('claude')
  })
})

describe('CAPABILITY_MATRIX', () => {
  it('contains exactly 48 rows (4 modes × 6 providers × 2 perms)', () => {
    expect(CAPABILITY_MATRIX).toHaveLength(48)
  })

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode round-trips through lookup',
    (row: MatrixRow) => {
      // Post-Phase-2: lookup() builds a fresh Capability from derive on
      // every call, so reference equality (toBe) no longer holds. Compare
      // semantic fields directly.
      const got = lookup(row.mode, row.provider, row.permissionMode)
      expect(got.askUser).toBe(row.askUser)
      expect(got.replyPrefix).toBe(row.replyPrefix)
      expect(got.delegate).toBe(row.delegate)
    },
  )

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode satisfies invariants',
    (row: MatrixRow) => {
      if (row.permissionMode === 'dangerously') expect(row.askUser).toBe('never')
      // B2(spec §4): delegate is loaded only when BOTH mode=primary_tool
      // AND the provider itself supportsDelegation — cursor/gemini/agy
      // can't be a delegating host (no delegate stdio channel).
      const canDelegate = row.provider === 'claude' || row.provider === 'codex' || row.provider === 'openai'
      if (row.mode === 'primary_tool' && canDelegate) expect(row.delegate).toBe('loaded')
      else                                             expect(row.delegate).toBe('unloaded')
      if (row.mode === 'parallel' || row.mode === 'chatroom') expect(row.replyPrefix).toBe('always')
      if (row.mode === 'solo') expect(row.replyPrefix).toBe('never')
      if (row.mode === 'primary_tool') expect(row.replyPrefix).toBe('on-fallback-only')
    },
  )
})

describe('lookup', () => {
  it('throws on unknown combo', () => {
    expect(() => lookup('solo' as Mode['kind'], 'mystery' as ProviderId, 'strict' as PermissionMode))
      .toThrow(/no row for/)
  })
})

describe('ghost-gemini — extensibility check (RFC 05 Phase 2)', () => {
  it('a hypothetical gemini ProviderCapabilities derives valid Capability rows for every (mode × pm) without touching the matrix', async () => {
    const { deriveCapability } = await import('./capability-matrix')
    const GEMINI_CAPABILITIES = {
      perToolCallback: true,
      adminMcpTools: true,
      sandboxLevels: new Set<'none' | 'read-only' | 'workspace-write' | 'full'>(),
      supportsDelegation: false,
      supportsResume: false,
      confines: { read_outside_workspace: 'per_tool', fs_write: 'per_tool', shell: 'per_tool', network: 'per_tool' } as const,
    }
    const modes: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
    const perms: PermissionMode[] = ['strict', 'dangerously']
    for (const m of modes) for (const pm of perms) {
      const cap = deriveCapability(GEMINI_CAPABILITIES, m, pm)
      // per-tool callback => askUser honors trait (per-tool in strict, never in dangerously)
      expect(cap.askUser).toBe(pm === 'strict' ? 'per-tool' : 'never')
      // this hypothetical gemini has supportsDelegation=false, so delegate
      // is 'unloaded' in every mode — including primary_tool (B2 conjunct).
      expect(cap.delegate).toBe('unloaded')
    }
  })

  it('assertMatrixComplete still passes for the three real providers (no regression)', () => {
    expect(() => assertMatrixComplete(['claude', 'codex', 'cursor'])).not.toThrow()
  })

  it('assertMatrixComplete throws clearly when an unregistered provider id is requested', () => {
    expect(() => assertMatrixComplete(['claude', 'unknown-provider' as ProviderId]))
      .toThrow(/unknown-provider/)
  })

  it('has a gemini capability row; assertMatrixComplete accepts gemini', async () => {
    const { GEMINI_CAPABILITIES } = await import('./gemini-agent-provider')
    // deriveCapability must work for all (mode × pm) without throwing
    const modes: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
    const perms: PermissionMode[] = ['strict', 'dangerously']
    const { deriveCapability } = await import('./capability-matrix')
    for (const m of modes) for (const pm of perms) {
      expect(() => deriveCapability(GEMINI_CAPABILITIES, m, pm)).not.toThrow()
    }
    // assertMatrixComplete must not throw now that the row is registered
    expect(() => assertMatrixComplete(['claude', 'codex', 'cursor', 'gemini'])).not.toThrow()
  })
})

describe('deriveCapability (RFC 05 Phase 2)', () => {
  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode equals deriveCapability(cap, mode, pm) on the semantic fields',
    async (row: MatrixRow) => {
      const { deriveCapability, capabilitiesFor } = await import('./capability-matrix')
      const cap = capabilitiesFor(row.provider)
      const derived = deriveCapability(cap, row.mode, row.permissionMode)
      expect(derived.askUser).toBe(row.askUser)
      expect(derived.replyPrefix).toBe(row.replyPrefix)
      expect(derived.delegate).toBe(row.delegate)
    },
  )
})

describe('capability-matrix openai', () => {
  it('includes openai and derives all combinations', () => {
    expect(capabilityProviderIds()).toContain('openai')
    expect(() => assertMatrixComplete(['openai'])).not.toThrow()
    expect(lookup('solo', 'openai', 'strict').askUser).toBe('per-tool') // perToolCallback true
  })
})

describe('capability-matrix — cursor rows', () => {
  it('cursor solo strict: askUser=never, replyPrefix=never, no delegate', () => {
    const cap = lookup('solo', 'cursor', 'strict')
    expect(cap.askUser).toBe('never')
    expect(cap.replyPrefix).toBe('never')
    expect(cap.delegate).toBe('unloaded')
  })

  it('cursor chatroom dangerously: askUser=never, replyPrefix=always', () => {
    const cap = lookup('chatroom', 'cursor', 'dangerously')
    expect(cap.askUser).toBe('never')
    expect(cap.replyPrefix).toBe('always')
  })

  it('cursor primary_tool: delegate unloaded (cursor cannot delegate — B2)', () => {
    const cap = lookup('primary_tool', 'cursor', 'strict')
    expect(cap.delegate).toBe('unloaded')
  })

  it('assertMatrixComplete accepts cursor', () => {
    expect(() => assertMatrixComplete(['claude', 'codex', 'cursor'])).not.toThrow()
  })
})

describe('capability-matrix — agy rows', () => {
  it('agy solo strict/dangerously: per-tool callback absent → askUser=never', () => {
    for (const pm of ['strict', 'dangerously'] as const) {
      const cap = lookup('solo', 'agy', pm)
      expect(cap.askUser).toBe('never') // perToolCallback:false flattens 'per-tool' to 'never'
      expect(cap.replyPrefix).toBe('never')
      expect(cap.delegate).toBe('unloaded')
    }
  })

  it('agy primary_tool: delegate unloaded (supportsDelegation:false — B2 conjunct)', () => {
    for (const pm of ['strict', 'dangerously'] as const) {
      expect(lookup('primary_tool', 'agy', pm).delegate).toBe('unloaded')
    }
  })

  it('AGY_CAPABILITIES field values (Task 3 declaration, asserted here too)', async () => {
    const { AGY_CAPABILITIES } = await import('./agy-agent-provider')
    expect(AGY_CAPABILITIES.perToolCallback).toBe(false)
    expect(AGY_CAPABILITIES.sandboxLevels.size).toBe(0)
    expect(AGY_CAPABILITIES.supportsDelegation).toBe(false)
    expect(AGY_CAPABILITIES.supportsResume).toBe(true)
    expect(AGY_CAPABILITIES.defaultPeer).toBe('claude')
  })

  it('assertMatrixComplete accepts agy', () => {
    expect(capabilityProviderIds()).toContain('agy')
    expect(() => assertMatrixComplete(['claude', 'codex', 'cursor', 'openai', 'gemini', 'agy'])).not.toThrow()
  })
})

describe('capability-matrix — supportsDelegation conjunct (B2, spec §4)', () => {
  it('cursor, gemini, agy primary_tool rows report delegate=unloaded (no delegate stdio channel)', () => {
    for (const pm of ['strict', 'dangerously'] as const) {
      expect(lookup('primary_tool', 'cursor', pm).delegate).toBe('unloaded')
      expect(lookup('primary_tool', 'gemini', pm).delegate).toBe('unloaded')
      expect(lookup('primary_tool', 'agy', pm).delegate).toBe('unloaded')
    }
  })

  it('claude, codex, openai primary_tool rows still report delegate=loaded', () => {
    for (const pm of ['strict', 'dangerously'] as const) {
      expect(lookup('primary_tool', 'claude', pm).delegate).toBe('loaded')
      expect(lookup('primary_tool', 'codex', pm).delegate).toBe('loaded')
      expect(lookup('primary_tool', 'openai', pm).delegate).toBe('loaded')
    }
  })
})

describe('provider id single source', () => {
  it('CAPABILITIES_BY_PROVIDER keys == lib/provider-ids PROVIDER_IDS (adding a provider = one list, not seven)', async () => {
    const { capabilityProviderIds } = await import('./capability-matrix')
    const { PROVIDER_IDS } = await import('../lib/provider-ids')
    expect([...capabilityProviderIds()].sort()).toEqual([...PROVIDER_IDS].sort())
  })
})

describe('replyTextStrategyFor — 按执行者类型(2026-10-03 修订)', () => {
  it('聊天型模型 all_segments;编码型执行者与没声明的 last_segment', async () => {
    const { replyTextStrategyFor } = await import('./capability-matrix')
    expect(replyTextStrategyFor('openai')).toBe('all_segments')
    expect(replyTextStrategyFor('agy')).toBe('all_segments')
    expect(replyTextStrategyFor('gemini')).toBe('all_segments')
    for (const p of ['claude', 'codex', 'cursor'] as const) expect(replyTextStrategyFor(p)).toBe('last_segment')
    expect(replyTextStrategyFor('no-such' as never)).toBe('last_segment')
  })
})
