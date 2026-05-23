import { describe, it, expect } from 'vitest'
import { tierProfileToCursorSdkOpts } from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCursorSdkOpts', () => {
  it('admin → sandbox disabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.admin)
    expect(out.sandboxOptions.enabled).toBe(false)
  })

  it('trusted → sandbox enabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.trusted)
    expect(out.sandboxOptions.enabled).toBe(true)
  })

  it('guest → sandbox enabled (lossier than codex read-only; documented)', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.guest)
    expect(out.sandboxOptions.enabled).toBe(true)
  })
})
