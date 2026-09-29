import { describe, it, expect } from 'vitest'
import { LAN_ONLY_OPS, LINK_ROUTES, PHONE_ROUTES, phoneRouteAllowed } from './phone-routes'

describe('phoneRouteAllowed', () => {
  it('精确键命中', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/set/api/state')).toBe(true)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'POST', '/m/api/matter/create')).toBe(true)
  })
  it('前缀键(以 / 结尾)命中其下所有路径', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/sticker/abc.png')).toBe(true)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/sticker')).toBe(false)
  })
  it('路径在册但方法不同 ⇒ 放行,交给处理器回 405(裁决 2)', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/attachment/chunk')).toBe(true)
  })
  it('不在册的路径 ⇒ 拒', () => {
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/m/api/nope')).toBe(false)
    expect(phoneRouteAllowed(PHONE_ROUTES, 'GET', '/v1/health')).toBe(false)
  })
  it('链接令牌与设备令牌同一套(裁决 1);只允局域网的三条', () => {
    expect([...LINK_ROUTES].sort()).toEqual([...PHONE_ROUTES].sort())
    expect([...LAN_ONLY_OPS].sort()).toEqual(['forget_devices', 'revoke_device', 'set_remote'])
  })
})
