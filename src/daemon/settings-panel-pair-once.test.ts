import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'

// 单次配对(spec 2026-10-01-tendhearth-pairing-ux §3、D1、D2)。
const OWNER = 'owner_chat@im.wechat'
let dir: string
let panel: SettingsPanel

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-once-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER,
    chatPrefs: { get: () => ({}), set: (_c, p) => p },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {},
  })
})
afterEach(async () => { await panel.stop(); rmSync(dir, { recursive: true, force: true }) })

const post = (q: string) => panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?${q}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))

describe('一个码只能配一台(裁决 1)', () => {
  it('第一次成功;同一个码第二次 ⇒ 401 unauthorized;隧道也不再认它', async () => {
    const link = panel.issueToken()
    const first = await post(`t=${link}`)
    expect(first.status).toBe(200)
    const body = await first.json() as { ok: boolean; device_token: string }
    expect(body.ok).toBe(true)
    expect(panel.validToken(body.device_token)).toBe(true)
    expect(panel.validToken(link)).toBe(false)
    expect(panel.activeLinkToken()).toBeNull()
    const second = await post(`t=${link}`)
    expect(second.status).toBe(401)
    expect(await second.json()).toEqual({ error: 'unauthorized' })
  })
  it('重发码作废旧码(不变)', async () => {
    const old = panel.issueToken()
    const fresh = panel.issueToken()
    expect((await post(`t=${old}`)).status).toBe(401)
    expect((await post(`t=${fresh}`)).status).toBe(200)
  })
  it('设备满了 ⇒ device_limit,码不消耗', async () => {
    for (let i = 0; i < 20; i++) expect((await post(`t=${panel.issueToken()}`)).status).toBe(200)
    const link = panel.issueToken()
    expect(await (await post(`t=${link}`)).json()).toEqual({ ok: false, error: 'device_limit' })
    expect(panel.validToken(link)).toBe(true)
  })
  it('设备令牌不能再铸设备令牌 ⇒ 403 link_only(D1)', async () => {
    const dev = (await (await post(`t=${panel.issueToken()}`)).json() as { device_token: string }).device_token
    const r = await post(`d=${dev}`)
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ ok: false, error: 'link_only' })
  })
  it('两台手机几乎同时用同一个码:恰好一台配上(Review Focus 1)', async () => {
    const link = panel.issueToken()
    const [a, b] = await Promise.all([post(`t=${link}`), post(`t=${link}`)])
    expect([a.status, b.status].sort()).toEqual([200, 401])
    expect(panel.deviceTokens()).toHaveLength(1)
  })
})
