import { describe, it, expect } from 'vitest'
import { uuid } from './uuid'

// 与 daemon mobile-workbench.ts / task-entry.ts 的 UUID 校验同形(小写 v4)。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  it('v4 形状,且每次不同', () => {
    const a = uuid(), b = uuid()
    expect(a).toMatch(UUID); expect(b).toMatch(UUID); expect(a).not.toBe(b)
  })
  it('全 0xff 的随机源也落在 v4 / variant 位上', () => {
    expect(uuid(x => x.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
