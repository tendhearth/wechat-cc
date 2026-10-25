import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRemoteRelay } from './remote-relay-config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-relay-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveRemoteRelay', () => {
  it('远程访问关 ⇒ null', () => {
    expect(resolveRemoteRelay(dir, {}, () => {})).toBeNull()
  })
  it('开但没设 relay_v2_url ⇒ null(老中继随 v1 退休,不再连),记日志,不生成 tunnel-id.json', () => {
    const log = vi.fn()
    expect(resolveRemoteRelay(dir, { remote_tunnel: true }, log)).toBeNull()
    expect(log).toHaveBeenCalledWith('TUNNEL', expect.stringContaining('relay_v2_url is not set'))
    expect(existsSync(join(dir, 'tunnel-id.json'))).toBe(false)
  })
  it('只设 remote_relay_url(自建老中继)⇒ 也是 null,日志里点名它退休了', () => {
    const log = vi.fn()
    expect(resolveRemoteRelay(dir, { remote_tunnel: true, remote_relay_url: 'wss://my.example/tunnel/phone' }, log)).toBeNull()
    expect(log).toHaveBeenCalledWith('TUNNEL', expect.stringContaining('wss://my.example/tunnel/phone retired'))
  })
  it('relay_v2_url 空串 ⇒ null', () => {
    expect(resolveRemoteRelay(dir, { remote_tunnel: true, relay_v2_url: '  ' }, () => {})).toBeNull()
  })
  it('显式设 relay_v2_url ⇒ v2;remoteInfo 指 /v2/phone', () => {
    const r = resolveRemoteRelay(dir, { remote_tunnel: true, relay_v2_url: 'wss://relay.tendhearth.com' }, () => {})!
    expect(r.daemonUrl).toBe('wss://relay.tendhearth.com/v2/daemon')
    expect(r.identity.id).toMatch(/^r[a-z2-7]{26}$/)
    expect(r.remoteInfo).toEqual({ id: r.identity.id, relay: 'wss://relay.tendhearth.com/v2/phone' })
  })
  it('relay_v2_url 覆盖(去尾斜杠)', () => {
    const r = resolveRemoteRelay(dir, { remote_tunnel: true, relay_v2_url: 'wss://relay-staging.tendhearth.com/' }, () => {})!
    expect(r.phoneUrl).toBe('wss://relay-staging.tendhearth.com/v2/phone')
  })
  it('身份文件坏 ⇒ null,记日志', () => {
    writeFileSync(join(dir, 'relay-identity.json'), 'garbage')
    const log = vi.fn()
    expect(resolveRemoteRelay(dir, { remote_tunnel: true, relay_v2_url: 'wss://relay.tendhearth.com' }, log)).toBeNull()
    expect(log).toHaveBeenCalledWith('TUNNEL', expect.stringContaining('relay_identity_corrupt'))
  })
  it('id 稳定(第二次读同一个)', () => {
    const cfg = { remote_tunnel: true, relay_v2_url: 'wss://relay.tendhearth.com' }
    expect(resolveRemoteRelay(dir, cfg, () => {})!.identity.id).toBe(resolveRemoteRelay(dir, cfg, () => {})!.identity.id)
  })
})
