import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeJobsStore } from '../../core/scheduled-jobs-store'
import { registerScheduledJobs, JOB_TURN_TIMEOUT_MS } from './runner'

function setup(o: { results?: string[]; tz?: string } = {}) {
  const store = makeJobsStore(mkdtempSync(join(tmpdir(), 'jobs-run-')))
  let t = Date.parse('2026-10-20T01:00:00Z')          // Asia/Shanghai 09:00,周二
  const results = [...(o.results ?? [])]
  const runTurn = vi.fn(async () => results.shift() ?? 'sent')
  const notifyOwner = vi.fn()
  const released: string[] = []
  const rt = registerScheduledJobs({
    store, timezone: () => o.tz ?? 'Asia/Shanghai', now: () => t, runTurn, notifyOwner,
    holdBusy: (l) => () => { released.push(l) }, log: () => {}, intervalMs: 3_600_000,
  })
  return { store, runTurn, notifyOwner, released, rt, tick: (ms: number) => { t += ms }, set: (iso: string) => { t = Date.parse(iso) } }
}
const at9 = { kind: 'daily' as const, at: '09:00' }

describe('registerScheduledJobs', () => {
  it('runs a due job once a day, holding busy, and records the result', async () => {
    const s = setup()
    s.store.add(at9, '看天气', new Date())
    await s.rt.tickOnce()
    await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(1)
    expect(s.store.state('j1')).toMatchObject({ lastRunDay: '2026-10-20', lastStatus: 'sent', failStreak: 0 })
    expect(s.released).toEqual(['scheduled-job'])
    await s.rt.stop()
  })
  it('paused and not-due jobs do not run', async () => {
    const s = setup()
    s.store.add({ kind: 'daily', at: '10:00' }, 'a', new Date())
    s.store.add(at9, 'b', new Date())
    s.store.setPaused('j2', true)
    await s.rt.tickOnce()
    expect(s.runTurn).not.toHaveBeenCalled()
    await s.rt.stop()
  })
  it('busy ⇒ retried next minute inside the window, missed after it', async () => {
    const s = setup({ results: ['skipped:busy', 'skipped:busy', 'sent'] })
    s.store.add(at9, 'x', new Date())
    await s.rt.tickOnce()
    expect(s.store.state('j1').lastRunDay).toBeNull()
    s.tick(60_000); await s.rt.tickOnce()
    s.tick(60_000); await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(3)
    expect(s.store.state('j1').lastStatus).toBe('sent')
    const late = setup({ results: ['skipped:busy'] })
    late.store.add(at9, 'x', new Date())
    await late.rt.tickOnce()
    late.tick(10 * 60_000); await late.rt.tickOnce()
    expect(late.runTurn).toHaveBeenCalledTimes(1)
    await s.rt.stop(); await late.rt.stop()
  })
  it('network / executor skips are recorded for the day and not retried', async () => {
    const s = setup({ results: ['skipped:network'] })
    s.store.add(at9, 'x', new Date())
    await s.rt.tickOnce()
    s.tick(60_000); await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(1)
    expect(s.store.state('j1')).toMatchObject({ lastRunDay: '2026-10-20', lastStatus: 'skipped:network' })
    await s.rt.stop()
  })
  it('at most 5 runs a day across all jobs', async () => {
    const s = setup()
    for (let i = 0; i < 7; i++) s.store.add(at9, `j${i}`, new Date())
    await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(5)
    expect(s.store.state('j6').lastStatus).toBe('skipped:cap')
    await s.rt.stop()
  })
  it('three failures in a row pause the job and tell the owner exactly once', async () => {
    const s = setup({ results: ['failed:quota', 'failed:quota', 'failed:quota'] })
    s.store.add(at9, '看 issue', new Date())
    for (let d = 0; d < 3; d++) { await s.rt.tickOnce(); s.tick(86_400_000) }
    expect(s.store.list().jobs[0]!.paused).toBe(true)
    expect(s.notifyOwner).toHaveBeenCalledTimes(1)
    expect(s.notifyOwner.mock.calls[0]![0]).toContain('定时 开 j1')
    await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(3)
    await s.rt.stop()
  })
  it('a turn that never returns is recorded as failed:timeout', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      s.runTurn.mockImplementationOnce(() => new Promise(() => {}))
      s.store.add(at9, 'x', new Date())
      const p = s.rt.tickOnce()
      await vi.advanceTimersByTimeAsync(JOB_TURN_TIMEOUT_MS)
      await p
      expect(s.store.state('j1')).toMatchObject({ lastStatus: 'failed:timeout', failStreak: 1 })
      await s.rt.stop()
    } finally { vi.useRealTimers() }
  })
  it('timezone decides the local day and time', async () => {
    const s = setup({ tz: 'UTC' })
    s.store.add(at9, 'x', new Date())
    await s.rt.tickOnce()                                    // UTC 01:00 — not due
    expect(s.runTurn).not.toHaveBeenCalled()
    s.set('2026-10-20T09:03:00Z'); await s.rt.tickOnce()
    expect(s.runTurn).toHaveBeenCalledTimes(1)
    await s.rt.stop()
  })
})
