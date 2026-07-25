import { describe, it, expect } from 'vitest'
import { makeRateLimiter } from './rate-limit'

describe('rate-limit', () => {
  it('allows up to capacity then refuses, and refills over time', () => {
    const rl = makeRateLimiter({ capacity: 2, refillPerSec: 1 })
    expect(rl.allow('ip', 0)).toBe(true)
    expect(rl.allow('ip', 0)).toBe(true)
    expect(rl.allow('ip', 0)).toBe(false)       // bucket empty
    expect(rl.allow('ip', 1000)).toBe(true)      // +1 token after 1s
    expect(rl.allow('other', 0)).toBe(true)      // independent key
  })
})
