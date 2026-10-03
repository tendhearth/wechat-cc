import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildLifecycleDeps } from './lifecycle-deps'
import { openTestDb } from '../../lib/db'
import type { Bootstrap } from '../bootstrap'
import type { IlinkAdapter } from '../ilink-glue'
import type { TickBodies } from './tick-bodies'
import type { CallTarget } from '../../lib/network-gate'

// busy-registry hold forwarding (spec 2026-08-11 §2, Task 6 code review #1) —
// buildLifecycleDeps is "pure field mapping, no business logic" per its own
// header, but that mapping is exactly what connects boot.holdBusy to the
// three companion schedulers. Task 5 wired scheduler.ts to ACCEPT holdBusy;
// Task 6 wired lifecycle.ts to FORWARD it; this is the seam in between —
// without it, deleting any one `holdBusy: boot.holdBusy` line here leaves
// tsc and the rest of the suite green while companion busy-tracking
// silently regresses to the pre-Task-6 broken state. This test fails loudly
// if that happens (verified via stash-mutation: deleting any one of the
// three lines turns this test red).
describe('buildLifecycleDeps — holdBusy forwarding', () => {
  function makeFixture() {
    const stateDir = mkdtempSync(join(tmpdir(), 'lifecycle-deps-holdbusy-'))
    const db = openTestDb()
    const holdBusy = vi.fn((label: string) => vi.fn(() => { void label }))
    // Only the fields buildLifecycleDeps actually reads are populated —
    // it's a pure mapper, not a full Bootstrap consumer (see its own
    // "Pure field mapping, no business logic" header comment).
    const boot = {
      holdBusy,
      sessionManager: {},
      sessionStore: {},
      conversationStore: {},
      health: { onSuccess: vi.fn(), onFailure: vi.fn() },
    } as unknown as Bootstrap
    const ilink = {
      flush: async () => {},
      getUpdatesForLoop: async () => ({ ok: true, updates: [] }),
      resolveUserName: () => null,
    } as unknown as IlinkAdapter
    const ticks: TickBodies = {
      ingestTick: async () => {},
      pushTick: async () => {},
      introspectTick: async () => {},
    }
    const deps = buildLifecycleDeps(
      { stateDir, db, ilink, accounts: [], boot, dangerously: false, log: () => {} },
      ticks,
    )
    return { deps, holdBusy, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) }
  }

  it('threads boot.holdBusy into all three companion scheduler deps (same reference, not a copy)', () => {
    const { deps, holdBusy, cleanup } = makeFixture()
    try {
      expect(deps.companionPushDeps.holdBusy).toBe(holdBusy)
      expect(deps.companionIntrospectDeps.holdBusy).toBe(holdBusy)
      expect(deps.companionIngestDeps.holdBusy).toBe(holdBusy)
    } finally {
      cleanup()
    }
  })

  it('the forwarded holdBusy is actually callable through each companion*Deps object (not just present)', () => {
    const { deps, holdBusy, cleanup } = makeFixture()
    try {
      for (const [label, d] of [
        ['push', deps.companionPushDeps],
        ['introspect', deps.companionIntrospectDeps],
        ['ingest', deps.companionIngestDeps],
      ] as const) {
        const release = d.holdBusy?.(`companion-${label}`)
        expect(typeof release).toBe('function')
      }
      expect(holdBusy).toHaveBeenCalledTimes(3)
    } finally {
      cleanup()
    }
  })
})

// 暂停在跑的任务(主人 2026-10-03):scheduler.onReading → suspender → workbench / 对话会话。
describe('buildLifecycleDeps — network guard suspends running tasks', () => {
  const reading = (source: 'bx' | 'probe', safe: boolean) => ({ ip: null, reachable: safe, lastChecked: new Date().toISOString(), lastError: null, source, safe, detail: '' })
  function makeFixture() {
    const stateDir = mkdtempSync(join(tmpdir(), 'lifecycle-deps-suspend-'))
    const shutdownProtected = vi.fn(async () => 1)
    const boot = { holdBusy: vi.fn(), sessionManager: { shutdownProtected }, sessionStore: {}, conversationStore: {}, health: { onSuccess: vi.fn(), onFailure: vi.fn() } } as unknown as Bootstrap
    const ilink = { flush: async () => {}, getUpdatesForLoop: async () => ({ ok: true, updates: [] }), resolveUserName: () => null } as unknown as IlinkAdapter
    const ticks: TickBodies = { ingestTick: async () => {}, pushTick: async () => {}, introspectTick: async () => {} }
    const seen: Array<{ protected: string | null }> = []
    const workbench = {
      suspendForNetwork: vi.fn((select: (run: { providerId: string; model: string | null; target: CallTarget }) => string | null) => {
        seen.push({ protected: select({ providerId: 'claude', model: null, target: { provider: 'claude', model: 'claude-opus-5' } }) })
        seen.push({ protected: select({ providerId: 'cursor', model: null, target: { provider: 'cursor', model: 'auto' } }) })
        return { suspended: 1, stopped: 0 }
      }),
      resumeFromNetwork: vi.fn(() => 1),
      stopSuspendedForNetwork: vi.fn(() => 1),
    }
    const deps = buildLifecycleDeps({ stateDir, db: openTestDb(), ilink, accounts: [], boot, dangerously: false, log: () => {}, workbench }, ticks)
    return { deps, workbench, shutdownProtected, seen, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) }
  }

  it('bx unsafe never suspends or closes anything; probe unsafe twice suspends protected runs + closes protected chat sessions; safe resumes', async () => {
    const { deps, workbench, shutdownProtected, seen, cleanup } = makeFixture()
    try {
      for (let i = 0; i < 5; i++) await deps.guardDeps.onReading!(reading('bx', false))
      expect(workbench.suspendForNetwork).not.toHaveBeenCalled()
      expect(shutdownProtected).not.toHaveBeenCalled()
      await deps.guardDeps.onReading!(reading('probe', false))
      expect(workbench.suspendForNetwork).not.toHaveBeenCalled()
      await deps.guardDeps.onReading!(reading('probe', false))
      expect(workbench.suspendForNetwork).toHaveBeenCalledTimes(1)
      expect(shutdownProtected).toHaveBeenCalledTimes(1)
      // 选择器按实际目标判:Claude 需要保护,Cursor auto 不需要(不动)。
      expect(seen[0]!.protected).toContain('Claude')
      expect(seen[1]!.protected).toBeNull()
      await deps.guardDeps.onReading!(reading('probe', true))
      expect(workbench.resumeFromNetwork).toHaveBeenCalledTimes(1)
      expect(workbench.stopSuspendedForNetwork).not.toHaveBeenCalled()
      // 网络翻转本身不再关对话会话(bx 来源也会翻转,而 bx 来源从不停在跑的东西)。
      expect(deps.guardDeps.onStateChange).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
