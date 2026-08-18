import { describe, expect, it, vi } from 'vitest'
import { agyVersionOk, type AgyVersionProbeHandle } from './agy-version-check'

function fakeSpawn(handle: AgyVersionProbeHandle) {
  return vi.fn(() => handle)
}

describe('agyVersionOk', () => {
  it('resolves true when the probe exits 0', async () => {
    const spawnFn = fakeSpawn({ exited: Promise.resolve(0), kill: vi.fn() })
    await expect(agyVersionOk('/usr/local/bin/agy', { spawnFn })).resolves.toBe(true)
  })

  it('resolves false on a nonzero exit code', async () => {
    const spawnFn = fakeSpawn({ exited: Promise.resolve(1), kill: vi.fn() })
    await expect(agyVersionOk('/usr/local/bin/agy', { spawnFn })).resolves.toBe(false)
  })

  it('resolves false when spawning throws synchronously (e.g. ENOENT)', async () => {
    const spawnFn = vi.fn(() => { throw new Error('spawn agy ENOENT') })
    await expect(agyVersionOk('/no/such/agy', { spawnFn })).resolves.toBe(false)
  })

  it('resolves false when `exited` rejects (async spawn error)', async () => {
    const spawnFn = fakeSpawn({ exited: Promise.reject(new Error('boom')), kill: vi.fn() })
    await expect(agyVersionOk('/usr/local/bin/agy', { spawnFn })).resolves.toBe(false)
  })

  it('resolves false and kills the child on timeout — a wedged binary can never stall boot', async () => {
    const kill = vi.fn()
    // Never resolves — simulates a hung `agy --version`.
    const spawnFn = fakeSpawn({ exited: new Promise<number>(() => {}), kill })
    await expect(agyVersionOk('/usr/local/bin/agy', { spawnFn, timeoutMs: 20 })).resolves.toBe(false)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
