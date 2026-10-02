import { describe, it, expect } from 'vitest'
import { LAN_ONLY_OPS, LINK_ROUTES, PHONE_ROUTES, PHONE_TOPICS, phoneRouteAllowed, phoneTopicAllowed } from './phone-routes'

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

describe('phoneTopicAllowed', () => {
  it('三个固定主题精确命中', () => {
    expect(phoneTopicAllowed('home')).toBe(true)
    expect(phoneTopicAllowed('approvals')).toBe(true)
    expect(phoneTopicAllowed('agents')).toBe(true)
  })
  it('matter/<id>:id 合法就放行', () => {
    expect(phoneTopicAllowed('matter/abc123')).toBe(true)
    expect(phoneTopicAllowed('matter/a')).toBe(true)
    expect(phoneTopicAllowed(`matter/${'a'.repeat(64)}`)).toBe(true)
  })
  it('matter/ 前缀本身、id 超长、id 里有非法字符、路径穿越 ⇒ 拒', () => {
    expect(phoneTopicAllowed('matter/')).toBe(false)
    expect(phoneTopicAllowed(`matter/${'a'.repeat(65)}`)).toBe(false)
    expect(phoneTopicAllowed('matter/../x')).toBe(false)
    expect(phoneTopicAllowed('matter/a b')).toBe(false)
    expect(phoneTopicAllowed('matter/a/b')).toBe(false)
  })
  it('未知主题 ⇒ 拒', () => {
    expect(phoneTopicAllowed('unknown')).toBe(false)
    expect(phoneTopicAllowed('')).toBe(false)
    expect(phoneTopicAllowed('Home')).toBe(false)
  })
})
