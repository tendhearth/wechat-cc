import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pairCheckCode } from '@wechat-cc/protocol'
import { makeSettingsPanel, SETTINGS_LINK_TTL_MS, type SettingsPanel } from './settings-panel'
import { makeRemoteToggle, relayV2Configured } from './remote-toggle'

// 不依赖这台机器有没有私网网卡(CI 可能没有):lanIp 固定
vi.mock('../lib/local-address', async (orig) => ({ ...(await orig<typeof import('../lib/local-address')>()), lanIp: () => '192.168.1.2' }))

const OWNER = 'owner_chat@im.wechat'
const RID = 'r' + 'a'.repeat(26)
const V2 = { relay: 'wss://relay.tendhearth.com/v2/phone', id: RID }
let dir: string
const panels: SettingsPanel[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phone-link-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude', relay_v2_url: 'wss://relay.tendhearth.com' }))
})
afterEach(async () => { for (const p of panels.splice(0)) await p.stop(); rmSync(dir, { recursive: true, force: true }) })

function mk(o: { v2?: boolean; v2AtBoot?: boolean; tunnel?: boolean; remote?: { relay: string; id: string } | null; owner?: string | null; wired?: boolean } = {}) {
  const calls = { enabled: [] as boolean[], restarts: 0, audit: [] as string[] }
  let tunnel = o.tunnel ?? false
  const panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => (o.owner === undefined ? OWNER : o.owner),
    chatPrefs: { get: () => ({}), set: (_c, p) => p },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {}, now: () => 1_000_000,
    audit: s => { calls.audit.push(s) },
    relayV2Configured: () => o.v2 ?? true,
    ...(o.v2AtBoot !== undefined ? { relayV2AtBoot: o.v2AtBoot } : {}),
    ...(o.remote ? { remoteInfo: () => o.remote! } : {}),
    ...(o.wired === false ? {} : { remote: { isEnabled: () => tunnel, setEnabled: (on: boolean) => { tunnel = on; calls.enabled.push(on) }, requestRestart: () => { calls.restarts++ } } }),
  })
  panels.push(panel)
  return { panel, calls }
}

describe('settingsPanel.phoneLink(spec §4.1)', () => {
  it('中继没开通 ⇒ relay_not_configured;不开隧道、不铸码', async () => {
    const { panel, calls } = mk({ v2: false })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'relay_not_configured' })
    expect(calls.enabled).toEqual([])
    expect(panel.activeLinkToken()).toBeNull()
  })
  it('隧道关着 + enableRemote ⇒ 打开、审计、重启,回 starting;面板自己不直接写配置(写盘只经 remote.setEnabled)', async () => {
    const before = readFileSync(join(dir, 'agent-config.json'), 'utf8')
    const { panel, calls } = mk({ tunnel: false })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(calls.enabled).toEqual([true])
    expect(calls.restarts).toBe(1)
    expect(calls.audit.some(a => a.includes('连接手机'))).toBe(true)
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(before)
    expect(panel.activeLinkToken()).toBeNull()
  })
  it('经真实写盘那一路(makeRemoteToggle):只翻 remote_tunnel,relay_v2_url 原样', async () => {
    let restarts = 0
    const panel = makeSettingsPanel({
      stateDir: dir, ownerChatId: () => OWNER,
      chatPrefs: { get: () => ({}), set: (_c, p) => p },
      getUserName: () => '大人', setUserName: async () => {}, log: () => {}, now: () => 1_000_000,
      relayV2Configured: () => relayV2Configured(dir),
      remote: makeRemoteToggle(dir, () => { restarts++ }),
    })
    panels.push(panel)
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    const after = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8')) as Record<string, unknown>
    expect(after.remote_tunnel).toBe(true)
    expect(after.relay_v2_url).toBe('wss://relay.tendhearth.com')
    expect(after.provider).toBe('claude')
    expect(restarts).toBe(1)
    // 已开 ⇒ 再点不再写、不再重启
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(restarts).toBe(1)
  })
  it('relayV2Configured 读当前配置:空串 / 缺省 ⇒ false', () => {
    expect(relayV2Configured(dir)).toBe(true)
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude', relay_v2_url: '  ' }))
    expect(relayV2Configured(dir)).toBe(false)
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    expect(relayV2Configured(dir)).toBe(false)
  })
  it('隧道关着、不许打开 ⇒ remote_off;没接 remote 时同样', async () => {
    expect(await mk({ tunnel: false }).panel.phoneLink({ enableRemote: false })).toEqual({ ok: false, state: 'remote_off' })
    expect(await mk({ wired: false }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'remote_off' })
  })
  it('配置已开、这次启动还没隧道 ⇒ starting;隧道是老中继 id ⇒ relay_unavailable', async () => {
    expect(await mk({ tunnel: true }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(await mk({ tunnel: true, remote: { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) } }).panel.phoneLink({ enableRemote: false }))
      .toEqual({ ok: false, state: 'relay_unavailable' })
  })
  it('M3:开机时隧道已开、之后才配 relay_v2_url(运行中是老 id)+ enableRemote ⇒ 重启一次、回 starting;同进程再点不再重启', async () => {
    const { panel, calls } = mk({ tunnel: true, remote: { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) } })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(calls.restarts).toBe(1)
    expect(calls.enabled).toEqual([])
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'relay_unavailable' })
    expect(calls.restarts).toBe(1)
  })
  it('I1:开机时 relay_v2_url 就已配置、运行中仍是老 id(v2 身份坏了)⇒ relay_unavailable,不重启;换一个进程(新面板)也不重启', async () => {
    const legacy = { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) }
    for (let proc = 0; proc < 2; proc++) {
      const { panel, calls } = mk({ tunnel: true, v2AtBoot: true, remote: legacy })
      expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'relay_unavailable' })
      expect(calls.restarts).toBe(0)
    }
  })
  it('I1:开机时没配 v2(之后才配)⇒ 仍重启一次', async () => {
    const { panel, calls } = mk({ tunnel: true, v2AtBoot: false, remote: { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) } })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(calls.restarts).toBe(1)
  })
  it('M3:运行中已是 v2 id ⇒ 不重启', async () => {
    const { panel, calls } = mk({ tunnel: true, remote: V2 })
    await panel.phoneLink({ enableRemote: true })
    expect(calls.restarts).toBe(0)
  })
  it('M1:面板起不来 ⇒ 抛错,且没有留下活的链接令牌', async () => {
    const { panel } = mk({ tunnel: true, remote: V2 })
    panel.start = async () => { throw new Error('bind failed') }
    await expect(panel.phoneLink({ enableRemote: true })).rejects.toThrow('bind failed')
    expect(panel.activeLinkToken()).toBeNull()
  })
  it('没主人 ⇒ no_owner', async () => {
    expect(await mk({ owner: null, tunnel: true, remote: V2 }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'no_owner' })
  })
  it('ready ⇒ 铸一枚链接令牌,链接指向 v2 壳页,10 分钟后过期', async () => {
    const { panel } = mk({ tunnel: true, remote: V2 })
    const r = await panel.phoneLink({ enableRemote: true })
    if (!r.ok) throw new Error(`expected ready, got ${r.state}`)
    expect(r.url).toMatch(new RegExp(`^https://relay\\.tendhearth\\.com/pset/#id=${RID}&t=t[0-9a-f]{32}&p=%2Fset(&lan=[^&]+)?$`))
    expect(r.expires_at).toBe(1_000_000 + SETTINGS_LINK_TTL_MS)
    expect(r.url).toContain(`t=${panel.activeLinkToken()}`)
    // 核对码(Task 9 fix round 1):由码里的 daemon id 派生,桌面显示、手机确认卡显示同一个
    expect(r.check_code).toBe(pairCheckCode(RID))
    expect(r.check_code).toMatch(/^[2-9A-HJ-NP-Z]{4}$/)
  })
  it('phoneDevices:配对后列出,不带令牌', async () => {
    const { panel } = mk({ tunnel: true, remote: V2 })
    await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${panel.issueToken()}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
    const list = panel.phoneDevices()
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['created_at', 'id', 'last_seen_at'])
  })
})
