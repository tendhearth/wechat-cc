import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'

// 重新配对退旧位(spec 2026-10-01-tendhearth-pairing-ux §8、D5):app 用旧令牌经隧道 unpair_self,只撤它自己。
const OWNER = 'owner_chat@im.wechat'
let dir: string
let panel: SettingsPanel
let unregistered: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retire-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  unregistered = []
  const push = { register: () => true, test: async () => ({ ok: true, code: 'ok' }), unregister: (id: string) => { unregistered.push(id) }, forgetAll: () => {} }
  panel = makeSettingsPanel({ stateDir: dir, push, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => '大人', setUserName: async () => {}, log: () => {} })
})
afterEach(async () => { await panel.stop(); rmSync(dir, { recursive: true, force: true }) })

const req = (path: string, q: string, body: unknown) =>
  panel.handleRequest(new Request(`http://127.0.0.1${path}?${q}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const pair = async () => (await (await req('/set/api/pair', `t=${panel.issueToken()}`, {})).json() as { device_token: string }).device_token

describe('旧令牌经隧道 unpair_self', () => {
  it('A、B 两台;A 的令牌 unpair_self ⇒ 只剩 B,A 失效、B 照常', async () => {
    const a = await pair(), b = await pair()
    const r = await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })
    expect(await r.json()).toEqual({ ok: true })
    expect(panel.validToken(a)).toBe(false)
    expect(panel.validToken(b)).toBe(true)
    expect(panel.deviceTokens()).toEqual([b])
  })
  it('退旧位连带注销的是旧那台的推送登记,新那台的不动', async () => {
    const a = await pair()
    const [aId] = panel.phoneDevices().map(d => d.id)
    const b = await pair()
    const bId = panel.phoneDevices().map(d => d.id).find(id => id !== aId)
    expect(aId).toBeTruthy()
    expect(bId).toBeTruthy()
    await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })
    expect(unregistered).toEqual([aId])
    expect(panel.phoneDevices().map(d => d.id)).toEqual([bId])
    await req('/set/api/apply', `d=${b}&_via=tunnel`, { op: 'unpair_self' })
    expect(unregistered).toEqual([aId, bId])
  })
  it('撤过一次再撤 ⇒ 401(app 当 failed 吞掉)', async () => {
    const a = await pair()
    await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })
    expect((await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })).status).toBe(401)
  })
})
