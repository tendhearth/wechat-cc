import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enablePhoneRelay, makeRemoteToggle, relayV2Configured } from './remote-toggle'
import { phoneRoutes } from './routes'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { createInternalApi } from '../../daemon/internal-api'
import { readRouteUsage } from '../../lib/route-usage'
import * as jsonFiles from '../../lib/json-file'
import type { AtomicWriteOptions } from '../../lib/json-file'

let dir: string
let panel: SettingsPanel | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'enable-relay-')) })
afterEach(async () => { vi.restoreAllMocks(); await panel?.stop(); panel = undefined; rmSync(dir, { recursive: true, force: true }) })
const operator = { tier: 'admin' as const, origin: 'operator' as const }
const path = '/v1/phone/enable-relay'
function setup(config: object, atomic?: AtomicWriteOptions) {
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
  const restart = vi.fn(), audit = vi.fn()
  panel = makeSettingsPanel({ stateDir: dir, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
    relayV2Configured: () => relayV2Configured(dir), remote: makeRemoteToggle(dir, restart) })
  const route = phoneRoutes({ phoneConnect: () => ({ link: o => panel!.phoneLink(o), devices: () => [] }), enableRelay: () => enablePhoneRelay(dir, atomic), log: audit })[`POST ${path}`]!
  return { route, restart, audit, read: () => JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8')) }
}

describe('enable-relay: explicit desktop consent', () => {
  it('real API rejects file/session and all panel/relay callers; operator records desktop route usage', async () => {
    const h = setup({ future: 'keep' })
    const api = createInternalApi({ stateDir: dir, daemonPid: 1 })
    api.mount('phone', { [`POST ${path}`]: h.route })
    const server = await api.start()
    try {
      const request = (token: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-CC-Desktop-Version': '1.8.0', 'Content-Type': 'application/json' }, body: '{}' })
      expect((await request(readFileSync(server.tokenFilePath, 'utf8').trim())).status).toBe(403)
      const before = readFileSync(join(dir, 'agent-config.json'), 'utf8')
      for (const origin of ['operator', 'device', 'link'] as const) {
        const remote = await api.panelDispatch(new Request(`https://relay.example${path}`, { method: 'POST', body: '{}' }), { tier: 'admin', origin, routeAllow: new Set([`POST ${path}`]) }, { frameBudget: 65536, client: 'app' })
        expect(remote.status).toBe(origin === 'operator' ? 401 : 403)
      }
      expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(before)
      expect((await request(readFileSync(server.operatorTokenFilePath, 'utf8').trim())).status).toBe(200)
      expect(readRouteUsage(dir)?.rows).toContainEqual(expect.objectContaining({ client: 'desktop', version: '1.8.0', alias: '', count: 1 }))
    } finally { await api.stop() }
  })

  it('atomically merges relay + tunnel, preserves arbitrary keys, starts once and audits operator/time once', async () => {
    const original = { provider: 'claude', model: 'custom', future: { nested: ['keep'] }, remote_tunnel: false }
    const h = setup(original)
    expect(await h.route(new URLSearchParams(), {}, operator)).toEqual({ status: 200, body: { ok: false, state: 'starting' } })
    expect(h.read()).toEqual({ ...original, relay_v2_url: 'wss://relay.tendhearth.com', remote_tunnel: true })
    expect(h.restart).toHaveBeenCalledTimes(1)
    const after = readFileSync(join(dir, 'agent-config.json'), 'utf8')
    await h.route(new URLSearchParams(), {}, operator)
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(after)
    expect(h.restart).toHaveBeenCalledTimes(1)
    expect(h.audit).toHaveBeenCalledTimes(1)
    expect(h.audit.mock.calls[0]?.join(' ')).toMatch(/operator.*\d{4}-\d{2}-\d{2}T/)
  })
  it('never replaces a custom nonempty relay, including when enabling its tunnel', async () => {
    const config = { relay_v2_url: '  wss://my-relay.example  ', remote_tunnel: false, future: 7 }
    const h = setup(config)
    await h.route(new URLSearchParams(), {}, operator)
    expect(h.read()).toEqual({ ...config, remote_tunnel: true })
    expect(h.restart).toHaveBeenCalledTimes(1)
    expect(h.audit).not.toHaveBeenCalled()
  })
  it('configured ready returns code directly without writing or restarting', async () => {
    const h = setup({ relay_v2_url: 'wss://custom.example', remote_tunnel: true, future: 3 })
    const ready = { ok: true as const, state: 'ready' as const, url: 'https://custom.example/pset/#t=test', expires_at: Date.now() + 600000, check_code: 'USZ-YAY' }
    const route = phoneRoutes({ phoneConnect: () => ({ link: async () => ready, devices: () => [] }), enableRelay: () => enablePhoneRelay(dir), log: h.audit })[`POST ${path}`]!
    const before = readFileSync(join(dir, 'agent-config.json'), 'utf8')
    expect((await route(new URLSearchParams(), {}, operator)).body).toEqual(ready)
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(before)
    expect(h.restart).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })
  it('refuses non-operator and any supplied relay/parameters without writing', async () => {
    const h = setup({ future: 1 })
    for (const caller of [undefined, { tier: 'trusted', origin: 'session' }, { tier: 'admin', origin: 'session' }, { tier: 'admin', origin: 'file' }, { tier: 'trusted', origin: 'operator' }] as const) {
      expect((await h.route(new URLSearchParams(), {}, caller)).status).toBe(403)
    }
    for (const body of [{ relay_v2_url: 'wss://evil.example' }, { url: 'wss://evil.example' }, [], 'x']) expect((await h.route(new URLSearchParams(), body, operator)).status).toBe(400)
    expect(h.read()).toEqual({ future: 1 })
    expect(h.restart).not.toHaveBeenCalled()
  })
  it('atomic rename failure preserves old bytes and leaves no partial/temp file or restart/audit', async () => {
    const h = setup({ future: { keep: true } }, { rename: () => { throw new Error('disk failure') } })
    const before = readFileSync(join(dir, 'agent-config.json'), 'utf8')
    expect(await h.route(new URLSearchParams(), {}, operator)).toEqual({ status: 503, body: { error: 'phone_relay_enable_failed' } })
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(before)
    expect(readdirSync(dir).filter(p => p.includes('agent-config'))).toEqual(['agent-config.json'])
    expect(h.restart).not.toHaveBeenCalled()
    expect(h.audit.mock.calls.some(c => c[0] === 'AUDIT')).toBe(false)
  })
  it.each([true, false])('re-reads concurrent configuration changes (custom relay=%s) before merging', custom => {
    const h = setup({ future: 'before' })
    const read = jsonFiles.readJsonObject
    vi.spyOn(jsonFiles, 'readJsonObject').mockImplementationOnce(path => {
      const snapshot = read(path)
      // A separate writer saves after our first read, before our merge.
      writeFileSync(path, JSON.stringify({ future: 'concurrent', ...(custom ? { relay_v2_url: 'wss://owner.example', remote_tunnel: false } : {}) }))
      return snapshot
    })
    expect(enablePhoneRelay(dir)).toBe(!custom)
    expect(h.read()).toEqual(custom
      ? { future: 'concurrent', relay_v2_url: 'wss://owner.example', remote_tunnel: false }
      : { future: 'concurrent', relay_v2_url: 'wss://relay.tendhearth.com', remote_tunnel: true })
  })
  it('unreadable config is refused, never replaced with defaults', async () => {
    const h = setup({})
    writeFileSync(join(dir, 'agent-config.json'), '{unfinished')
    expect(await h.route(new URLSearchParams(), {}, operator)).toEqual({ status: 409, body: { error: 'config_unreadable' } })
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe('{unfinished')
    expect(h.restart).not.toHaveBeenCalled()
  })
})
