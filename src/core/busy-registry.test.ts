import { describe, it, expect } from 'vitest'
import { makeBusyRegistry } from './busy-registry'

describe('makeBusyRegistry', () => {
  it('初始不忙', () => {
    expect(makeBusyRegistry().busy()).toBe(false)
  })
  it('hold 之后忙,release 之后不忙', () => {
    const r = makeBusyRegistry()
    const release = r.hold('test')
    expect(r.busy()).toBe(true)
    release()
    expect(r.busy()).toBe(false)
  })
  it('多个 holder:全部释放才不忙', () => {
    const r = makeBusyRegistry()
    const a = r.hold('a'); const b = r.hold('b')
    a()
    expect(r.busy()).toBe(true)
    b()
    expect(r.busy()).toBe(false)
  })
  it('release 幂等:重复调用不把别人的 token 放掉', () => {
    const r = makeBusyRegistry()
    const a = r.hold('a'); const b = r.hold('b')
    a(); a(); a()
    expect(r.busy()).toBe(true)  // b 还在
    b()
    expect(r.busy()).toBe(false)
  })
})
