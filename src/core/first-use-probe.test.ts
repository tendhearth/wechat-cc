import { describe, it, expect, vi } from 'vitest'
import { withFirstUseProbe } from './first-use-probe'
import type { AgentProvider } from './agent-provider'

function inner(): AgentProvider & { spawns: number } {
  const p = {
    spawns: 0,
    async spawn() { p.spawns++; return { dispatch: async function* () {}, close: async () => {} } as never },
    async cheapEval(prompt: string) { return `echo:${prompt}` },
  }
  return p as never
}
const ctx = { tierProfile: {} as never, permissionMode: 'strict' as const, chatId: 'c' }

describe('withFirstUseProbe', () => {
  it('probes once on first spawn, then passes through; concurrent first spawns share one probe', async () => {
    const probe = vi.fn(async () => 'ok')
    const results: unknown[] = []
    const p = withFirstUseProbe(inner(), { probe, failureMessage: d => `bad: ${d}`, onResult: r => results.push(r) })
    expect(p.probeStatus().state).toBe('untested')
    await Promise.all([p.spawn({ alias: 'a', path: '/p' }, ctx), p.spawn({ alias: 'a', path: '/p' }, ctx)])
    await p.spawn({ alias: 'a', path: '/p' }, ctx)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(p.probeStatus().state).toBe('ok')
    expect(results).toEqual([expect.objectContaining({ ok: true, detail: 'ok' })])
  })
  it('empty reply = failure (the silent-mismatch symptom); spawn throws the human message; retry only after the window', async () => {
    let t = 0
    const probe = vi.fn(async () => '')
    const p = withFirstUseProbe(inner(), { probe, failureMessage: d => `codex 不可用:${d}`, retryAfterMs: 1000, now: () => t })
    await expect(p.spawn({ alias: 'a', path: '/p' }, ctx)).rejects.toThrow('codex 不可用:探测拿到了空回复')
    expect(p.probeStatus().state).toBe('failed')
    await expect(p.spawn({ alias: 'a', path: '/p' }, ctx)).rejects.toThrow('codex 不可用')
    expect(probe).toHaveBeenCalledTimes(1)          // inside the window: no re-probe
    t = 2000
    probe.mockResolvedValueOnce('ok')
    await p.spawn({ alias: 'a', path: '/p' }, ctx)  // window passed: re-probe, now healthy
    expect(probe).toHaveBeenCalledTimes(2)
    expect(p.probeStatus().state).toBe('ok')
  })
  it('a throwing probe surfaces its message; cheapEval is gated by the same probe', async () => {
    const p = withFirstUseProbe(inner(), { probe: async () => { throw new Error('400 requires a newer version of Codex') }, failureMessage: d => `codex:${d}` })
    await expect(p.cheapEval!('x')).rejects.toThrow('requires a newer version of Codex')
    expect(p.probeStatus()).toMatchObject({ state: 'failed', detail: expect.stringContaining('newer version') })
  })
})
