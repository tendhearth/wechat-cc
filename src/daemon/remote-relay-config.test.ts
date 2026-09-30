import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRemoteRelays, mergeOnlineDevices } from './remote-relay-config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-relay-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveRemoteRelays', () => {
  it('远程访问关 ⇒ null', () => {
    expect(resolveRemoteRelays(dir, {}, () => {})).toBeNull()
  })
  it('开:老中继照旧 + 新中继缺省生产;remoteInfo 用新的', () => {
    const r = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    expect(r.legacy.id).toMatch(/^t[0-9a-f]{36}$/)
    expect(r.legacy.daemonUrl).toBe('wss://cc.tendhearth.com/tunnel/daemon')
    expect(r.v2!.daemonUrl).toBe('wss://relay.tendhearth.com/v2/daemon')
    expect(r.remoteInfo).toEqual({ id: r.v2!.identity.id, relay: 'wss://relay.tendhearth.com/v2/phone' })
  })
  it('relay_v2_url 覆盖(去尾斜杠)', () => {
    const r = resolveRemoteRelays(dir, { remote_tunnel: true, relay_v2_url: 'wss://relay-staging.tendhearth.com/' }, () => {})!
    expect(r.v2!.phoneUrl).toBe('wss://relay-staging.tendhearth.com/v2/phone')
  })
  it('身份文件坏 ⇒ 只连老中继,remoteInfo 回老的,记日志', () => {
    writeFileSync(join(dir, 'relay-identity.json'), 'garbage')
    const log = vi.fn()
    const r = resolveRemoteRelays(dir, { remote_tunnel: true }, log)!
    expect(r.v2).toBeNull()
    expect(r.remoteInfo).toEqual({ id: r.legacy.id, relay: 'wss://cc.tendhearth.com/tunnel/phone' })
    expect(log).toHaveBeenCalledWith('TUNNEL', expect.stringContaining('relay_identity_corrupt'))
  })
  it('老 id 稳定(第二次读同一个)', () => {
    const a = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    const b = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    expect(b.legacy.id).toBe(a.legacy.id)
    expect(b.v2!.identity.id).toBe(a.v2!.identity.id)
  })
  it('两条隧道的在线设备合并(按设备 id 去重)', () => {
    const idOf = (t: string) => t.slice(0, 2)
    expect([...mergeOnlineDevices([['aa1'], ['aa2', 'bb1']], idOf)].sort()).toEqual(['aa', 'bb'])
  })
})
