import { describe, it, expect } from 'vitest'
import { lanIp, pickAdvertisableHost, type NetIfaces } from './local-address'

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })

describe('pickAdvertisableHost —— 配手时最贵的那一步,不该由用户来想', () => {
  it('有 Tailscale 就用它(跨网段也能通,比局域网稳)', () => {
    const ifs: NetIfaces = { en0: [v4('192.168.1.20')], tailscale0: [v4('100.101.102.103')] }
    expect(pickAdvertisableHost(ifs)).toEqual({ host: '100.101.102.103', why: 'tailscale' })
  })

  it('没有 Tailscale 就用局域网地址', () => {
    expect(pickAdvertisableHost({ en0: [v4('10.84.6.254')] })).toEqual({ host: '10.84.6.254', why: 'lan' })
  })

  it('100.x 但不在 CGNAT 段内的不算 Tailscale(100.0.0.0/8 是公网)', () => {
    const ifs: NetIfaces = { eth0: [v4('100.5.5.5')] }
    expect(pickAdvertisableHost(ifs)).toEqual({ host: '100.5.5.5', why: 'lan' })
  })

  it('只有回环 → null,**绝不**回落到 127.0.0.1', () => {
    // 回落到回环的话:配对会成功、派活永远失败,而症状离根因极远。
    // 2026-09-01 配对卡片广播 127.0.0.1 就是这个形状。
    expect(pickAdvertisableHost({ lo0: [v4('127.0.0.1', true)] })).toBeNull()
    expect(pickAdvertisableHost({})).toBeNull()
  })

  it('link-local(169.254.x)不算可达地址', () => {
    expect(pickAdvertisableHost({ en5: [v4('169.254.1.1')] })).toBeNull()
  })

  it('IPv6 不参与(A2A 的 url 拼装按 IPv4 走)', () => {
    const ifs: NetIfaces = { en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }] }
    expect(pickAdvertisableHost(ifs)).toBeNull()
  })
})

describe('lanIp', () => {
  it('en0 优先', () => {
    expect(lanIp({ eth9: [v4('10.0.0.9')], en0: [v4('192.168.1.5')] })).toBe('192.168.1.5')
  })
  it('跳过 internal 与 link-local', () => {
    expect(lanIp({ lo0: [v4('127.0.0.1', true)], en5: [v4('169.254.1.1')], en0: [v4('192.168.1.5')] })).toBe('192.168.1.5')
  })
})
