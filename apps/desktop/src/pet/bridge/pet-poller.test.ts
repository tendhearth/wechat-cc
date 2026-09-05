import { describe, it, expect, vi } from 'vitest'
import { createPetPoller } from './pet-poller.js'

describe('createPetPoller', () => {
  it('start 立即拉一次;slow 10 s;setFast(true) 改 2 s;拉失败发 null;stop 停', async () => {
    vi.useFakeTimers()
    try {
      const invokeApi = vi.fn().mockResolvedValue({ owner_last_contact_at: null, turn: { phase: 'idle', since: null }, last_done_at: null, pending_permissions: [] })
      const p = createPetPoller({ invokeApi })
      const got: unknown[] = []
      p.subscribe(t => got.push(t))
      p.start(); await vi.advanceTimersByTimeAsync(0)
      expect(invokeApi).toHaveBeenCalledTimes(1); expect(invokeApi.mock.calls[0]![0]).toBe('GET'); expect(invokeApi.mock.calls[0]![1]).toBe('/v1/companion/pet')
      await vi.advanceTimersByTimeAsync(10_000); expect(invokeApi).toHaveBeenCalledTimes(2)
      p.setFast(true); await vi.advanceTimersByTimeAsync(2_000); expect(invokeApi).toHaveBeenCalledTimes(3)
      invokeApi.mockRejectedValueOnce(new Error('503'))
      await vi.advanceTimersByTimeAsync(2_000); expect(got.at(-1)).toBeNull()
      p.stop(); await vi.advanceTimersByTimeAsync(20_000); expect(invokeApi).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })
})
