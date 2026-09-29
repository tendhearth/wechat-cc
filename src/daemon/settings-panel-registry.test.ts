/**
 * 手机面板的令牌走内部 API 同一个 token-registry(梳理第 6 步,2026-09-29)。
 * 计划:docs/superpowers/plans/2026-09-29-device-token-registry.md Task 4。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../lib/test-temp'
import { makeTokenRegistry, type TokenRegistry } from './internal-api/token-registry'
import { makeSettingsPanel, SETTINGS_LINK_TTL_MS, type SettingsPanel } from './settings-panel'

let dir: string, tokens: TokenRegistry, panel: SettingsPanel, base: string, nowMs: number
const OWNER = 'owner'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'panel-registry-'))
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  nowMs = 1_000_000
  tokens = makeTokenRegistry(undefined, () => nowMs)
  panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER,
    chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    remote: { isEnabled: () => false, setEnabled: () => {}, requestRestart: () => {} },
    log: () => {}, now: () => nowMs, tokens,
  })
  base = `http://127.0.0.1:${(await panel.start(0)).port}`
})
afterEach(async () => { await panel.stop(); removeTempDir(dir) })

const get = (path: string, tok: string) => fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${tok}`)
const post = (path: string, tok: string, body?: unknown) =>
  fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
async function pair(): Promise<string> {
  const r = await (await post('/set/api/pair', panel.issueToken())).json() as { device_token: string }
  return r.device_token
}
type Dev = { id: string; created_at: string; last_seen_at: string; label?: string; current: boolean }
const devices = async (tok: string) => ((await (await get('/set/api/state', tok)).json()) as { remote: { devices: Dev[] } }).remote.devices

describe('面板令牌登记在共享注册表里', () => {
  it('链接令牌是 link、设备令牌是 device,都能在注册表里查到', async () => {
    const link = panel.issueToken()
    expect(tokens.resolve(link)).toMatchObject({ origin: 'link', sessionKey: 'link', tier: 'admin' })
    const dev = await pair()
    expect(tokens.resolve(dev)).toMatchObject({ origin: 'device', tier: 'admin' })
    expect(panel.deviceTokens()).toEqual([dev])
  })

  it('内部 API 的会话 / 文件 / operator 令牌打不开面板(裁决 5)', async () => {
    const session = tokens.mint('admin', 'claude/x')
    tokens.registerFileToken('ff'.repeat(32)); tokens.registerOperatorToken('00'.repeat(32))
    for (const t of [session, 'ff'.repeat(32), '00'.repeat(32)]) {
      expect(panel.validToken(t)).toBe(false)
      expect((await get('/set/api/state', t)).status).toBe(401)
    }
  })

  it('链接令牌 10 分钟过期:/set 回过期页 401,/m 回 bootstrap 页;activeLinkToken 为 null', async () => {
    const link = panel.issueToken()
    expect(panel.activeLinkToken()).toBe(link)
    nowMs += SETTINGS_LINK_TTL_MS
    const set = await get('/set', link)
    expect(set.status).toBe(401)
    expect(await set.text()).toMatch(/^<!doctype html>/)
    expect((await get('/m', link)).status).toBe(200)
    expect(panel.activeLinkToken()).toBeNull()
  })

  it('重发链接令牌 ⇒ 旧的立刻失效', () => {
    const a = panel.issueToken(), b = panel.issueToken()
    expect(panel.validToken(a)).toBe(false)
    expect(panel.validToken(b)).toBe(true)
  })

  it('旧格式设备文件:重建面板后老令牌照常能用', async () => {
    await panel.stop()
    const old = 'd' + 'c'.repeat(48)
    writeFileSync(join(dir, 'settings-devices.json'), JSON.stringify({ [old]: { created_at: '2026-09-01T00:00:00.000Z' } }))
    const t2 = makeTokenRegistry()
    panel = makeSettingsPanel({ stateDir: dir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {}, tokens: t2 })
    base = `http://127.0.0.1:${(await panel.start(0)).port}`
    expect(t2.resolve(old)?.origin).toBe('device')
    expect((await get('/m/api/state', old)).status).toBe(200)
  })
})

describe('按台撤销、标签与设备列表', () => {
  it('remote.devices 是数组,当前这台标 current', async () => {
    const a = await pair(), b = await pair()
    const list = await devices(a)
    expect(list).toHaveLength(2)
    expect(list.filter(d => d.current)).toHaveLength(1)
    expect(list.find(d => d.current)!.id).toBe(tokens.resolve(a)!.sessionKey!.slice('device:'.length))
    expect((await devices(b)).find(d => d.current)!.id).toBe(tokens.resolve(b)!.sessionKey!.slice('device:'.length))
  })

  it('revoke_device 只撤那一台:它 401,另一台 200;不存在的 id ⇒ unknown_device', async () => {
    const a = await pair(), b = await pair()
    const idA = tokens.resolve(a)!.sessionKey!.slice('device:'.length)
    expect(await (await post('/set/api/apply', b, { op: 'revoke_device', id: idA })).json()).toEqual({ ok: true })
    expect((await get('/m/api/state', a)).status).toBe(401)
    expect((await get('/m/api/state', b)).status).toBe(200)
    expect(await panel.apply({ op: 'revoke_device', id: idA })).toMatchObject({ ok: false, error: 'unknown_device' })
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings-devices.json'), 'utf8')))).toEqual([b])
  })

  it('label_device 往返;超长截到 24 字', async () => {
    const a = await pair()
    const id = tokens.resolve(a)!.sessionKey!.slice('device:'.length)
    expect(await panel.apply({ op: 'label_device', id, label: '客厅的平板' })).toEqual({ ok: true })
    expect((await devices(a))[0]!.label).toBe('客厅的平板')
    expect(await panel.apply({ op: 'label_device', id: 'ffffffff', label: 'x' })).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  it('forget_devices:每台都失效', async () => {
    const a = await pair(), b = await pair()
    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    expect(panel.validToken(a)).toBe(false)
    expect(panel.validToken(b)).toBe(false)
    expect(panel.deviceTokens()).toEqual([])
  })
})

describe('路由门与只允局域网', () => {
  it('有效令牌访问不在册的路径 ⇒ 403 route_not_allowed', async () => {
    const r = await get('/m/api/nope', panel.issueToken())
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'route_not_allowed' })
  })

  it('路径在册、方法不对 ⇒ 照旧交给处理器(不是 403)', async () => {
    const r = await get('/set/api/apply', panel.issueToken())
    expect(r.status).not.toBe(403)
  })

  it('LAN_ONLY_OPS 每条经隧道都被拒;局域网照常', async () => {
    const dev = await pair()
    const id = tokens.resolve(dev)!.sessionKey!.slice('device:'.length)
    for (const body of [{ op: 'set_remote', enabled: true }, { op: 'revoke_device', id }, { op: 'forget_devices' }]) {
      expect(await (await post('/set/api/apply?_via=tunnel', dev, body)).json()).toEqual({ ok: false, error: 'lan_only' })
    }
    expect(panel.validToken(dev)).toBe(true)
    expect(await (await post('/set/api/apply?_via=tunnel', dev, { op: 'label_device', id, label: '外面也能改名' })).json()).toEqual({ ok: true })
  })
})
