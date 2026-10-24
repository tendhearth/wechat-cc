import { describe, expect, it } from 'vitest'

import { NetworkUnprotectedError } from '../../../lib/network-gate'
import { pausedReason } from './paused'

describe('pausedReason', () => {
  it('网络守护拦下的、被拒退避期里的 ⇒ 一句不带「失败」的原因;别的照旧 null', () => {
    expect(pausedReason(new NetworkUnprotectedError({ source: 'bx' } as never, 'Gemini'))).toContain('网络守护')
    expect(pausedReason(Object.assign(new Error('x'), { providerErrorCode: 'region_unavailable' }))).toContain('退避期')
    expect(pausedReason(new Error('model down'))).toBeNull()
    expect(pausedReason(Object.assign(new Error('x'), { providerErrorCode: 'quota_exhausted' }))).toBeNull()
  })
})
