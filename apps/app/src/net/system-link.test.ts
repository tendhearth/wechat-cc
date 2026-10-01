import { describe, it, expect } from 'vitest'
import { setPendingLink, systemPairLink, takePendingLink } from './system-link'

const FRAG = `#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`

describe('systemPairLink(spec §6.3、D7)', () => {
  it('生产中继的 /pset 链接 ⇒ 规范化的 https 链接(锚点原样)', () => {
    expect(systemPairLink(`https://relay.tendhearth.com/pset/${FRAG}`, false)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
    expect(systemPairLink(`https://Relay.Tendhearth.com/pset${FRAG}`, false)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
  })
  it('锚点丢了也认出来(交给配对页说「没带全」)', () => {
    expect(systemPairLink('https://relay.tendhearth.com/pset/', false)).toBe('https://relay.tendhearth.com/pset/')
  })
  it('staging 与自定义 scheme 只在开发构建', () => {
    expect(systemPairLink(`https://relay-staging.tendhearth.com/pset/${FRAG}`, false)).toBeNull()
    expect(systemPairLink(`https://relay-staging.tendhearth.com/pset/${FRAG}`, true)).toBe(`https://relay-staging.tendhearth.com/pset/${FRAG}`)
    expect(systemPairLink(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, false)).toBeNull()
    expect(systemPairLink(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, true)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
  })
  it('别的主机、别的路径、带查询串 ⇒ null', () => {
    expect(systemPairLink(`https://evil.example/pset/${FRAG}`, true)).toBeNull()
    expect(systemPairLink('https://relay.tendhearth.com/healthz', false)).toBeNull()
    expect(systemPairLink(`https://relay.tendhearth.com/pset/?x=1${FRAG}`, false)).toBeNull()
    expect(systemPairLink('tendhearth://push-open?kind=task_done&taskId=a1b2c3d4', true)).toBeNull()
  })
})

describe('暂存一格,取后即焚(令牌不进路由参数)', () => {
  it('取一次就没了;新的覆盖旧的', () => {
    expect(takePendingLink()).toBeNull()
    setPendingLink('a'); setPendingLink('b')
    expect(takePendingLink()).toBe('b')
    expect(takePendingLink()).toBeNull()
  })
})
