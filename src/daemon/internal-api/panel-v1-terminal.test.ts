/**
 * P3c-2 并的三条(设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3c」):终端会话列表、「今天」、
 * CC 的连接。手机令牌从面板那一口走 `/v1` 那一个处理器以后,看得见的和并之前 `/m/api` 手机处理器让它看见的**一样多**,不多一点。
 *
 * 并之前 `/v1/cli/sessions`、`/v1/connections` 只给 operator(桌面 / CLI):登记处每行带完整路径 `cwd` 与 `origin_agent`、
 * 连接带插件目录与未就绪原因(`detail`)。手机那两条在自己的处理器里挑字段 / 去掉 detail。P3b 提醒过:`/v1` 处理器把
 * 「不是会话令牌」当成不受限 —— 手机令牌要是原样走进去,就和 operator 同权。这里拿真配对的设备令牌、真发的链接令牌,
 * 新键(`/v1/…`)和别名键(`/m/api/…`)两条路都打,再拿 operator 从 127.0.0.1 打同一条作对照(那边一字不变)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, type InternalApi } from './index'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { terminalRoutes, type TerminalRoutesDeps } from '../../features/terminal/routes'
import { phoneCliSessionRows } from '../../features/terminal/phone-sessions'
import { buildOverseerToday } from '../../domain/overseer-today'
import type { ConnectionsSnapshot } from '../connections'
import type { CliSessionView } from '../../ports/cli-session'

const NOW = 1_800_000_000_000
const view = (i: number, over: Partial<CliSessionView> = {}): CliSessionView => ({
  session_id: `sess-${i}`, code: `c${i}`.padEnd(6, '0').slice(0, 6), source: 'claude', status: 'idle', stale: false,
  project: 'secret-proj', cwd: `/Users/nate/work/secret-proj-${i}`, machine: 'mac', origin_agent: 'hand-agent-1', last_summary: '好了',
  last_event_at: NOW - i, last_prompt_at: null, created_at: 1, pending: null, ...over,
})
// 80 条:手机那一份最多 50;第一条在等批准(手机带中继开的码)
const VIEWS: CliSessionView[] = [view(0, { status: 'waiting', pending: { tool: 'Bash', summary: 'rm -rf ./tmp', since: NOW } }), ...Array.from({ length: 79 }, (_, i) => view(i + 1))]
const SNAP: ConnectionsSnapshot = {
  generatedAt: 1, computers: [{ id: 'home', label: 'Mac', online: true, since: 0, version: '1.7.8' }], recent: [], outputs: [],
  sources: [{ id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: '/Users/nate/plugins' } }],
}
const TODAY = buildOverseerToday({
  now: NOW, localMachine: 'mac', attention: [],
  terminal: [view(0, { last_summary: '改好了', last_event_at: NOW - 60_000 })],
  tasks: [{ id: 'a1b2c3d4', title: '修打包', path: '/Users/nate/work/melu', providerId: 'codex', phase: 'working', updatedAt: NOW - 1000, error: null, archivedAt: null }],
})

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string
let device: string, link: string
let spies: { list: ReturnType<typeof vi.fn<() => CliSessionView[]>>; today: ReturnType<typeof vi.fn<() => typeof TODAY>>; connections: ReturnType<typeof vi.fn<() => ConnectionsSnapshot>> }

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'panel-v1-terminal-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  spies = { list: vi.fn(() => VIEWS), today: vi.fn(() => TODAY), connections: vi.fn(() => SNAP) }
  api = createInternalApi({ stateDir, daemonPid: 1, connections: spies.connections })
  // 同 features/terminal/wire.ts:operator 读 cliEvents.list(桌面那一份),手机令牌读 phoneSessions(手机那一份)
  api.mount('terminal', terminalRoutes({
    cliEvents: { ingest: () => 'noop', list: (o?: { limit?: number }) => spies.list().slice(0, o?.limit ?? 100) },
    overseerToday: spies.today,
    phoneSessions: () => phoneCliSessionRows({
      list: () => spies.list(),
      actions: { pendingHash: (id: string) => (id === 'sess-0' ? 'abcde' : null), liveWindows: () => new Set<string>() } as never,
      executorName: () => 'Claude',
    }),
  } as Partial<TerminalRoutesDeps> as TerminalRoutesDeps))
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  operator = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => 'owner@im.wechat', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    log: () => {}, tokens: api.panelTokens, v1: api.panelDispatch,
  })
  device = ((await (await viaPanel('/set/api/pair', panel.issueToken(), { method: 'POST' })).json()) as { device_token: string }).device_token
  link = panel.issueToken()
})
afterEach(async () => {
  await panel.stop()
  await api.stop()
  removeTempDir(stateDir)
})

function viaPanel(path: string, tok: string, init: RequestInit = {}) {
  return panel.handleRequest(new Request(`http://127.0.0.1:1${path}${path.includes('?') ? '&' : '?'}${tok.startsWith('d') ? 'd' : 't'}=${tok}`, init))
}
const viaOperator = (path: string) => fetch(`${localBase}${path}`, { headers: { Authorization: `Bearer ${operator}` } })
type Row = Record<string, unknown> & { pending: Record<string, unknown> | null }

describe('GET /v1/cli/sessions:手机令牌只拿手机那一份', () => {
  it('设备令牌(新键与别名键,连带想多要的查询参数):没有 cwd / origin_agent、只给目录名、最多 50 条、等批准的带码;operator 照旧全量', async () => {
    for (const path of ['/v1/cli/sessions', '/v1/cli/sessions?ended=1&detail=1&limit=500', '/m/api/cli/sessions']) {
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      const text = await r.text()
      expect(text, path).not.toContain('/Users/')
      expect(text, path).not.toContain('hand-agent-1')
      const sessions = (JSON.parse(text) as { sessions: Row[] }).sessions
      expect(sessions, path).toHaveLength(50)
      for (const s of sessions) { expect('cwd' in s, path).toBe(false); expect('origin_agent' in s, path).toBe(false) }
      expect(sessions[0]).toMatchObject({ project: 'secret-proj', displayName: 'Claude', pending: { tool: 'Bash', hash: 'abcde', actionable: true } })
    }
    // 对照:operator 从 127.0.0.1 读同一条 —— 桌面那一份(带 cwd / origin_agent,默认 100 条),一字不变
    const op = await viaOperator('/v1/cli/sessions')
    expect(op.status).toBe(200)
    const opRows = ((await op.json()) as { sessions: Row[] }).sessions
    expect(opRows).toHaveLength(80)
    expect(opRows[0]).toEqual(VIEWS[0])
  })

  it('链接令牌两条路都 403,处理器不跑', async () => {
    spies.list.mockClear()
    for (const path of ['/v1/cli/sessions', '/m/api/cli/sessions']) {
      const r = await viaPanel(path, link)
      expect(r.status, path).toBe(403)
    }
    expect(spies.list).not.toHaveBeenCalled()
  })
})

describe('GET /v1/connections:手机令牌拿去掉 detail 的那一份', () => {
  it('设备令牌两条路都没有 detail(插件目录、未就绪原因);operator 照旧有', async () => {
    for (const path of ['/v1/connections', '/m/api/connections']) {
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      const text = await r.text()
      expect(text, path).not.toContain('/Users/')
      expect(text, path).not.toContain('missing')
      expect(text, path).not.toContain('"detail"')
    }
    const op = await viaOperator('/v1/connections')
    expect(op.status).toBe(200)
    expect(await op.json()).toEqual(SNAP)
  })

  it('链接令牌两条路都 403,处理器不跑', async () => {
    spies.connections.mockClear()
    for (const path of ['/v1/connections', '/m/api/connections']) expect((await viaPanel(path, link)).status, path).toBe(403)
    expect(spies.connections).not.toHaveBeenCalled()
  })
})

describe('GET /v1/overseer/today:手机令牌与 operator 同一份(本来就只有目录名)', () => {
  it('设备令牌两条路拿到的 today 和 operator 一样,和并之前手机那条一样(原样给)', async () => {
    const op = await viaOperator('/v1/overseer/today')
    expect(op.status).toBe(200)
    const want = ((await op.json()) as { today: unknown }).today
    expect(want).toEqual(JSON.parse(JSON.stringify(TODAY)))
    for (const path of ['/v1/overseer/today', '/m/api/today']) {
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      const body = (await r.json()) as { today: unknown }
      expect(body.today, path).toEqual(want)
      expect(JSON.stringify(body), path).not.toContain('/Users/')
    }
  })

  it('链接令牌两条路都 403,处理器不跑', async () => {
    spies.today.mockClear()
    for (const path of ['/v1/overseer/today', '/m/api/today']) expect((await viaPanel(path, link)).status, path).toBe(403)
    expect(spies.today).not.toHaveBeenCalled()
  })
})
