import { describe, it, expect, vi } from 'vitest'
import { devPushKeyAction, fallbackPushToken, makeDevPushToken } from './dev-token'

const DEV = 'dev' + 'a'.repeat(48)
const REAL = 'd' + 'b'.repeat(48)

describe('点通知的兜底令牌', () => {
  it('有配对 ⇒ 永远用配对的设备令牌(开发令牌不顶替)', () => {
    expect(fallbackPushToken(REAL, DEV, true)).toBe(REAL)
    expect(fallbackPushToken(REAL, null, false)).toBe(REAL)
  })
  it('没配对:只有开发构建、且是开发令牌形状,才用开发令牌', () => {
    expect(fallbackPushToken(null, DEV, true)).toBe(DEV)
    expect(fallbackPushToken(undefined, DEV, false)).toBeNull()
    expect(fallbackPushToken(null, REAL, true)).toBeNull()
    expect(fallbackPushToken(null, null, true)).toBeNull()
  })
  it('开发令牌只在内存:set 通知订阅者,形状不对不收', () => {
    const s = makeDevPushToken()
    const fn = vi.fn()
    const off = s.subscribe(fn)
    s.set(REAL)
    expect(s.get()).toBeNull()
    expect(fn).not.toHaveBeenCalled()
    s.set(DEV)
    expect(s.get()).toBe(DEV)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    s.set('dev' + 'c'.repeat(48))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('/dev-push-key 该不该动钥匙串', () => {
  it('发布构建 ⇒ 什么都不做', () => {
    expect(devPushKeyAction(false, DEV, false)).toBe('none')
    expect(devPushKeyAction(false, DEV, true)).toBe('none')
  })
  it('形状不对 ⇒ rejected', () => {
    expect(devPushKeyAction(true, REAL, false)).toBe('rejected')
    expect(devPushKeyAction(true, undefined, false)).toBe('rejected')
  })
  it('已配对的开发构建 ⇒ paired(不写共享钥匙串:那里放着真配对推出的推送密钥)', () => {
    expect(devPushKeyAction(true, DEV, true)).toBe('paired')
  })
  it('没配对的开发构建 + 开发令牌 ⇒ apply', () => {
    expect(devPushKeyAction(true, DEV, false)).toBe('apply')
  })
})
