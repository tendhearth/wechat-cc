import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAtelierCycle, type AtelierContext, type AtelierRuntimeDeps } from './atelier-runtime'
import { makeAtelierStore } from './atelier-store'
import type { ArtworkRenderer, RenderedArtwork } from './artwork-renderer'

const context: AtelierContext = {
  recentObservations: ['海边散步'], activeThreads: [], personaExcerpt: '温和而好奇',
  recentWorks: [], nowLocal: '2026-09-01 12:00',
}
const impulse = {
  shouldPaint: true as const, feeling: '潮水退去后的一点牵挂', whyNow: '仅留在本机的原因',
  subject: '两条错开的鱼', surface: '潮湿的沙滩', medium: '小树枝',
  gesture: '轻轻反复', composition: '水线旁的大块留白', shareIntent: 'private' as const,
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0])

function deps(overrides: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'wcc-atelier-runtime-'))
  const store = makeAtelierStore(stateDir, { makeId: () => 'work-1' })
  const renderer: ArtworkRenderer = {
    id: 'fake-brush',
    render: vi.fn(async (): Promise<RenderedArtwork> => ({ bytes: png, mime: 'image/png', rendererId: 'fake-brush', elapsedMs: 1 })),
  }
  return {
    stateDir, mode: 'private' as const, planner: { plan: vi.fn(async () => impulse) }, renderer, store, context,
    now: () => new Date('2026-09-01T12:00:00Z'), ...overrides,
  } as AtelierRuntimeDeps
}

describe('atelier runtime', () => {
  it('off mode makes zero planner or renderer calls', async () => {
    const d = deps({ mode: 'off' as const })
    const result = await runAtelierCycle(d)
    expect(result).toEqual({ status: 'skipped_off' })
    expect(d.planner.plan).not.toHaveBeenCalled()
    expect(d.renderer?.render).not.toHaveBeenCalled()
  })

  it('no renderer makes zero planner calls', async () => {
    const d = deps({ renderer: null })
    expect(await runAtelierCycle(d)).toEqual({ status: 'skipped_no_renderer' })
    expect(d.planner.plan).not.toHaveBeenCalled()
  })

  it('no impulse makes zero renderer/store calls', async () => {
    const d = deps({ planner: { plan: vi.fn(async () => ({ shouldPaint: false })) } })
    const save = vi.spyOn(d.store, 'save')
    expect(await runAtelierCycle(d)).toEqual({ status: 'no_impulse' })
    expect(d.renderer?.render).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('private mode saves before any notification and preserves whyNow locally', async () => {
    const d = deps({ notify: vi.fn(async () => {}) })
    const result = await runAtelierCycle(d)
    expect(result).toMatchObject({ status: 'created', recordId: 'work-1', shared: false })
    expect(d.notify).not.toHaveBeenCalled()
    const record = d.store.load('work-1')!
    expect(record.impulse).not.toHaveProperty('whyNow')
    expect(record.privateCauseSummary).toBe(impulse.whyNow)
  })

  it('share mode sends only after save and keeps pending on notify failure', async () => {
    const d = deps({
      mode: 'share' as const,
      planner: { plan: vi.fn(async () => ({ ...impulse, shareIntent: 'now' as const })) },
      canShare: () => true,
      notify: vi.fn(async () => { throw new Error('transport down') }),
    })
    const result = await runAtelierCycle(d)
    expect(result).toMatchObject({ status: 'created', shared: false })
    expect(d.store.load('work-1')?.shareState).toBe('pending')
    expect(d.notify).toHaveBeenCalledWith('work-1')
  })

  it('persists the 30-hour and rolling two-per-week cadence', async () => {
    const d = deps()
    expect((await runAtelierCycle(d)).status).toBe('created')
    const samePeriod = await runAtelierCycle({ ...d, store: makeAtelierStore(d.stateDir, { makeId: () => 'work-2' }) })
    expect(samePeriod.status).toBe('skipped_cadence')
    const next = await runAtelierCycle({
      ...d, store: makeAtelierStore(d.stateDir, { makeId: () => 'work-2' }),
      now: () => new Date('2026-09-02T19:00:00Z'),
    })
    expect(next.status).toBe('created')
    const capped = await runAtelierCycle({
      ...d, store: makeAtelierStore(d.stateDir, { makeId: () => 'work-3' }),
      now: () => new Date('2026-09-03T20:00:00Z'),
    })
    expect(capped.status).toBe('skipped_cadence')
  })
})
