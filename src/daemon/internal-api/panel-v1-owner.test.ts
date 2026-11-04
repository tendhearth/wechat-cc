/**
 * P3c-3 并的四条(设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3c」):收回的话、恢复一条、
 * 待办改状态、看到哪了。手机令牌从面板那一口走 `/v1` 那一个处理器以后,能做的和并之前 `/m/api` 手机处理器让它做的**一样多**,不多一点。
 *
 * 要盯的是写的那两条:`/v1/knowledge/facts/set_fact_status` 给 operator / MCP 用,认任何状态(superseded …)、认正文里的 `now`;
 * 手机待办页并之前只认 resolved / active / rejected、时间由 daemon 定。`/v1/journal/seen` 给桌面用,推到现在;手机那条带 `until`、
 * 夹到 now、只往后推。这里拿真配对的设备令牌、真发的链接令牌,新键(`/v1/…`)和别名键(`/m/api/…`)两条路都打,
 * 再拿 operator / 文件令牌从 127.0.0.1 打同一条作对照(那边一字不变)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, type InternalApi } from './index'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { memoryRoutes } from '../../features/memory/routes'
import { journalRoutes } from '../../features/journal/routes'

const NOW = Date.UTC(2026, 10, 5, 2, 0, 0)
const ITEMS = [{ key: 'c:abc123', section: '喜好', text: '爱喝美式', day: '2026-11-01', verdict: 'outdated', note: '' }]

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string, fileToken: string
let device: string, link: string, seenAt: string | null
let spies: {
  retractions: ReturnType<typeof vi.fn<() => typeof ITEMS>>
  restore: ReturnType<typeof vi.fn<(key: string) => Promise<{ restored: string[] } | null>>>
  setFactStatus: ReturnType<typeof vi.fn<(id: number, status: string, now: number) => { ok: boolean }>>
  write: ReturnType<typeof vi.fn<(iso: string) => void>>
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  stateDir = mkdtempSync(join(tmpdir(), 'panel-v1-owner-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  seenAt = null
  spies = {
    retractions: vi.fn(() => ITEMS),
    restore: vi.fn(async (key: string) => (key === 'c:abc123' ? { restored: ['爱喝美式'] } : null)),
    setFactStatus: vi.fn(() => ({ ok: true })),
    write: vi.fn((iso: string) => { seenAt = iso }),
  }
  // 同生产:knowledge 由 bootApi 交给内部 API;记忆 / 日志的路由由各自的模块挂
  api = createInternalApi({ stateDir, daemonPid: 1, knowledge: { facts: { setFactStatus: spies.setFactStatus } } as never })
  api.mount('memory', memoryRoutes({ stateDir, memoryLlm: () => null, memoryNightly: () => ({ retractions: spies.retractions, restore: spies.restore }) as never }))
  api.mount('journal', journalRoutes({ stateDir, journal: {} as never, seen: { read: () => seenAt, write: spies.write } }))
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  operator = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  fileToken = readFileSync(s.tokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => 'owner@im.wechat', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    log: () => {}, tokens: api.panelTokens, v1: api.panelDispatch,
  })
  device = ((await (await viaPanel('/set/api/pair', panel.issueToken(), { method: 'POST' })).json()) as { device_token: string }).device_token
  link = panel.issueToken()
})
afterEach(async () => {
  vi.useRealTimers()
  await panel.stop()
  await api.stop()
  removeTempDir(stateDir)
})

function viaPanel(path: string, tok: string, init: RequestInit = {}) {
  return panel.handleRequest(new Request(`http://127.0.0.1:1${path}${path.includes('?') ? '&' : '?'}${tok.startsWith('d') ? 'd' : 't'}=${tok}`, init))
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const viaLocal = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${localBase}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } })

describe('收回的话 / 恢复一条:手机令牌与 operator 同一份,链接令牌够不着', () => {
  it('设备令牌两条路读到的列表和 operator 一样;恢复两条路都能恢复、不在了 404', async () => {
    const op = await viaLocal('/v1/memory/retractions', operator)
    expect(op.status).toBe(200)
    expect(await op.json()).toEqual({ ok: true, items: ITEMS })
    for (const path of ['/v1/memory/retractions', '/m/api/memory/retractions']) {
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      expect(await r.json(), path).toEqual({ ok: true, items: ITEMS })
    }
    for (const path of ['/v1/memory/retractions/restore', '/m/api/memory/restore']) {
      const ok = await viaPanel(path, device, post({ key: 'c:abc123' }))
      expect(ok.status, path).toBe(200)
      expect(await ok.json(), path).toMatchObject({ ok: true, restored: ['爱喝美式'] })
      expect((await viaPanel(path, device, post({ key: 'c:gone' }))).status, path).toBe(404)
      // 键不像收回的那种(m: 开头 / 带空白)⇒ 400,恢复不跑
      spies.restore.mockClear()
      for (const key of ['m:aa01', 'c: x']) expect((await viaPanel(path, device, post({ key }))).status, `${path} ${key}`).toBe(400)
      expect(spies.restore).not.toHaveBeenCalled()
    }
    // 别名照旧要正文恰好一个 key(多一个键 ⇒ 400);新键走 /v1 的 schema,多出来的键丢掉、只用 key
    expect((await viaPanel('/m/api/memory/restore', device, post({ key: 'c:abc123', extra: 1 }))).status).toBe(400)
    expect(spies.restore).not.toHaveBeenCalled()
  })

  it('链接令牌四条路都 403,处理器不跑', async () => {
    for (const path of ['/v1/memory/retractions', '/m/api/memory/retractions']) expect((await viaPanel(path, link)).status, path).toBe(403)
    for (const path of ['/v1/memory/retractions/restore', '/m/api/memory/restore']) expect((await viaPanel(path, link, post({ key: 'c:abc123' }))).status, path).toBe(403)
    expect(spies.retractions).not.toHaveBeenCalled()
    expect(spies.restore).not.toHaveBeenCalled()
  })
})

describe('POST /v1/knowledge/facts/set_fact_status:手机令牌只能完成 / 捞回 / 不对,时间由 daemon 定', () => {
  it('设备令牌两条路:三个状态照改、时间是 daemon 的现在(正文里的 now 不认)', async () => {
    for (const path of ['/v1/knowledge/facts/set_fact_status', '/m/api/todo']) {
      for (const status of ['resolved', 'active', 'rejected']) {
        spies.setFactStatus.mockClear()
        const r = await viaPanel(path, device, post({ id: 7, status, now: 1 }))
        // 多出来的键(now)手机那条并之前就不看;新键由处理器按 caller 不认它
        expect(r.status, `${path} ${status}`).toBe(200)
        expect(spies.setFactStatus, `${path} ${status}`).toHaveBeenCalledWith(7, status, Math.floor(NOW / 1000))
      }
    }
  })

  it('设备令牌两条路:别的状态(superseded / archived / 随便一个)⇒ 400,不改', async () => {
    for (const path of ['/v1/knowledge/facts/set_fact_status', '/m/api/todo']) {
      for (const status of ['superseded', 'archived', 'pending']) {
        const r = await viaPanel(path, device, post({ id: 7, status }))
        expect(r.status, `${path} ${status}`).toBe(400)
      }
    }
    expect(spies.setFactStatus).not.toHaveBeenCalled()
  })

  it('链接令牌两条路都 403,不改', async () => {
    for (const path of ['/v1/knowledge/facts/set_fact_status', '/m/api/todo']) expect((await viaPanel(path, link, post({ id: 7, status: 'resolved' }))).status, path).toBe(403)
    expect(spies.setFactStatus).not.toHaveBeenCalled()
  })

  it('对照:operator 从 127.0.0.1 照旧认任何状态、认正文里的 now', async () => {
    const r = await viaLocal('/v1/knowledge/facts/set_fact_status', operator, post({ id: 7, status: 'superseded', now: 123 }))
    expect(r.status).toBe(200)
    expect(spies.setFactStatus).toHaveBeenCalledWith(7, 'superseded', 123)
  })
})

describe('POST /v1/journal/seen:手机带 until 夹到 now、只往后推;桌面不带照旧推到现在', () => {
  it('设备令牌新键:until 夹到 now、不后退、不是时间 400;不带 until ⇒ 推到现在(同桌面)', async () => {
    const path = '/v1/journal/seen'
    expect(await (await viaPanel(path, device, post({ until: new Date(NOW - 60_000).toISOString() }))).json()).toEqual({ ok: true, seen_until: new Date(NOW - 60_000).toISOString() })
    expect(await (await viaPanel(path, device, post({ until: new Date(NOW - 3_600_000).toISOString() }))).json()).toEqual({ ok: true, seen_until: new Date(NOW - 60_000).toISOString() })
    expect(await (await viaPanel(path, device, post({ until: '2099-01-01T00:00:00.000Z' }))).json()).toEqual({ ok: true, seen_until: new Date(NOW).toISOString() })
    for (const until of ['yesterday', null, 42]) expect((await viaPanel(path, device, post({ until }))).status, String(until)).toBe(400)
    expect(seenAt).toBe(new Date(NOW).toISOString())
    vi.setSystemTime(NOW + 1000)
    expect(await (await viaPanel(path, device, { method: 'POST' })).json()).toEqual({ ok: true, seen_until: new Date(NOW + 1000).toISOString() })
  })

  it('设备令牌别名键:一定要带 until(不带 / 不是时间 ⇒ 400 invalid_until,不会变成推到现在)', async () => {
    const path = '/m/api/seen'
    expect(await (await viaPanel(path, device, post({ until: '2099-01-01T00:00:00.000Z' }))).json()).toEqual({ ok: true, seen_until: new Date(NOW).toISOString() })
    spies.write.mockClear()
    for (const body of [{}, { until: 'yesterday' }]) {
      const r = await viaPanel(path, device, post(body))
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(await r.json()).toEqual({ ok: false, error: 'invalid_until' })
    }
    expect(spies.write).not.toHaveBeenCalled()
  })

  it('链接令牌两条路都 403,水位不动', async () => {
    for (const path of ['/v1/journal/seen', '/m/api/seen']) expect((await viaPanel(path, link, post({ until: new Date(NOW).toISOString() }))).status, path).toBe(403)
    expect(spies.write).not.toHaveBeenCalled()
  })

  it('对照:文件令牌从 127.0.0.1 不带正文 ⇒ 推到现在,一字不变', async () => {
    const r = await viaLocal('/v1/journal/seen', fileToken, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, seen_until: new Date(NOW).toISOString() })
  })
})
