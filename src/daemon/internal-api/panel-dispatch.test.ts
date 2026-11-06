/**
 * 一个分发、两个监听(P3b,设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3b」)。
 *
 * 内部 API 的分发抽成一个函数,手机设置面板收到的 `/v1/*` 也交给它。门还是两个:
 *   - 127.0.0.1 只认 file / session / operator —— 手机的 device / link 令牌在这里一律 401;
 *   - 面板(局域网 + 隧道)只认 device / link —— 桌面 / 本机凭据一律 401;
 *   - 面板上的 `/v1`:路由表那一行没有 `phone` 块 ⇒ 403 route_not_allowed,处理器不跑(今天表里一行都没有)。
 * 正向路径(有 phone 块的 /v1 行)今天表里没有,用 createInternalApi 的 `panelRoutes` 替身名单测。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ROUTES, type RouteSpec } from '@wechat-cc/protocol/routes'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, entryAccepts, type InternalApi, type InternalApiOptions } from './index'
import { PANEL_V1_ROUTES, panelV1RoutesOf } from './route-tiers'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { LINK_ROUTES, LINK_WRITE_OK, PHONE_ROUTES } from '../../features/phone/phone-routes'
import { MAX_MOBILE_DETAIL_BYTES } from '../../features/phone/mobile-matter-response'

const V1_KEYS = Object.keys(ROUTES).filter(k => / \/v1\//.test(k))

let stateDir: string
let api: InternalApi | null
let panel: SettingsPanel | null
let localBase: string
let fileToken: string, operatorToken: string
let seen: Array<{ query: Record<string, string>; caller: unknown }>
let wishPosts: number

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'panel-dispatch-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  api = null; panel = null; seen = []; wishPosts = 0
})
afterEach(async () => {
  if (panel) await panel.stop()
  if (api) await api.stop()
  removeTempDir(stateDir)
})

async function start(options: InternalApiOptions = {}) {
  api = createInternalApi({ stateDir, daemonPid: 1 }, options)
  // 两条替身(社交模块平时自己挂):看处理器跑没跑、拿到的查询串与 caller
  api.mount('social', {
    'GET /v1/social/wishes': async (query, _body, caller) => {
      seen.push({ query: Object.fromEntries(query.entries()), caller })
      return { status: 200, body: { wishes: [] } }
    },
    'POST /v1/social/wish/cancel': async () => { wishPosts++; return { status: 418, body: { error: 'teapot' } } },
  })
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  fileToken = readFileSync(s.tokenFilePath, 'utf8').trim()
  operatorToken = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => 'owner',
    chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    log: () => {}, tokens: api.panelTokens, v1: api.panelDispatch,
  })
}

/** 面板那一口(同 Bun.serve 与隧道共用的 handleRequest);令牌放查询串,同手机。 */
const viaPanel = (path: string, tok: string, init: RequestInit = {}) =>
  panel!.handleRequest(new Request(`http://127.0.0.1:1${path}${path.includes('?') ? '&' : '?'}${tok.startsWith('d') ? 'd' : 't'}=${tok}`, init))
/** 127.0.0.1 那一口(Bearer)。 */
const viaLocal = (path: string, tok: string, init: RequestInit = {}) =>
  fetch(`${localBase}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tok}` } })
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function pairDevice(): Promise<string> {
  const r = await (await viaPanel('/set/api/pair', panel!.issueToken(), { method: 'POST' })).json() as { device_token: string }
  return r.device_token
}

describe('两个监听各认各的令牌', () => {
  it('entryAccepts:127.0.0.1 只认 file / session / operator,面板只认 device / link', () => {
    for (const o of ['file', 'session', 'operator'] as const) { expect(entryAccepts('local', o)).toBe(true); expect(entryAccepts('panel', o)).toBe(false) }
    for (const o of ['device', 'link'] as const) { expect(entryAccepts('local', o)).toBe(false); expect(entryAccepts('panel', o)).toBe(true) }
  })

  it('内部 API 上 device / link 令牌一律 401,哪怕 routeAllow 里有这条、路由表也放给手机', async () => {
    await start({ panelRoutes: { device: new Set(['GET /v1/health']), link: new Set(['GET /v1/health']) } })
    const device = await pairDevice()
    const link = panel!.issueToken()
    // 再登记两枚 routeAllow 里明写着 /v1/health 的手机令牌(P3c 以后真令牌就是这样)
    api!.panelTokens.register('d' + 'a'.repeat(32), { tier: 'admin', origin: 'device', sessionKey: 'device:x', routeAllow: new Set(['GET /v1/health']) })
    api!.panelTokens.register('t' + 'b'.repeat(32), { tier: 'admin', origin: 'link', sessionKey: 'link2', routeAllow: new Set(['GET /v1/health']) })
    for (const tok of [device, link, 'd' + 'a'.repeat(32), 't' + 'b'.repeat(32)]) {
      // 手机令牌带字母前缀,Bearer 认的是 hex —— 两种写法都要 401
      for (const bearer of [tok, tok.slice(1)]) {
        const r = await viaLocal('/v1/health', bearer)
        expect(r.status, tok).toBe(401)
        expect(await r.json()).toEqual({ error: 'unauthorized' })
      }
      const m = await viaLocal('/m/api/matters', tok.slice(1))
      expect(m.status).toBe(401)
    }
    // 对照:桌面 / 本机凭据在这一口照旧能进
    expect((await viaLocal('/v1/health', fileToken)).status).toBe(200)
    expect((await viaLocal('/v1/health', operatorToken)).status).not.toBe(401) // operator 的 routeAllow 没有 health ⇒ 403,但过了这一口的门
  })

  it('面板上 operator / file / session 令牌一律 401(/v1、/m/api、/set/api 都是)', async () => {
    await start({ panelRoutes: { device: new Set(['GET /v1/health']), link: new Set(['GET /v1/health']) } })
    const session = api!.mintSessionToken('admin', 'claude/x/owner')
    for (const tok of [fileToken, operatorToken, session]) {
      for (const path of ['/v1/health', '/v1/social/wishes', '/m/api/matters', '/set/api/state']) {
        const r = await panel!.handleRequest(new Request(`http://127.0.0.1:1${path}?t=${tok}`))
        expect(r.status, `${path} ${tok.slice(0, 4)}`).toBe(401)
        const r2 = await panel!.handleRequest(new Request(`http://127.0.0.1:1${path}?d=${tok}`))
        expect(r2.status).toBe(401)
        // Bearer 头在面板上不算令牌
        const r3 = await panel!.handleRequest(new Request(`http://127.0.0.1:1${path}`, { headers: { Authorization: `Bearer ${tok}` } }))
        expect(r3.status).toBe(401)
      }
    }
    expect(seen).toEqual([])
  })

  it('panelDispatch 自己也只认 device / link(面板之外有人直接调也挡)', async () => {
    await start({ panelRoutes: { device: new Set(['GET /v1/health']), link: new Set(['GET /v1/health']) } })
    for (const origin of ['file', 'session', 'operator'] as const) {
      const r = await api!.panelDispatch(new Request('http://127.0.0.1:1/v1/health'), { tier: 'admin', origin }, { frameBudget: 1, client: 'web' })
      expect(r.status).toBe(401)
    }
  })
})

/** P3c-1 / P3c-2 / P3c-3 / P3c-4 起路由表里带 phone 块的 /v1 行(一份数据一个处理器,手机的旧路径是别名);链接令牌只读其中两条。 */
const T4_DEVICE = ['GET /v1/protocol/capabilities','GET /v1/matter/owner-chat/window','GET /v1/matter/owner-chat/work','GET /v1/matter/owner-chat/events','POST /v1/matter/owner-chat/stop','GET /v1/cli/activity','POST /v1/cli/decide','POST /v1/cli/session-say','POST /v1/cli/session-stop','GET /v1/memory/topics', 'GET /v1/memory/topics/detail', 'POST /v1/memory/topics/open', 'GET /v1/subscribe/topics']
const P3C1_DEVICE = ['GET /v1/cli/sessions', 'GET /v1/connections', 'GET /v1/matter', 'GET /v1/matter/owner-chat/file', 'GET /v1/matter/owner-chat/search', 'GET /v1/matters', 'GET /v1/memory/retractions', 'GET /v1/overseer/today', 'GET /v1/workbench/entry-options', 'GET /v1/workbench/models', 'GET /v1/workbench/session', 'GET /v1/workbench/sessions', 'POST /v1/companion/transcribe', 'POST /v1/journal/seen', 'POST /v1/knowledge/facts/set_fact_status', 'POST /v1/matter/say', 'POST /v1/memory/retractions/restore', 'POST /v1/workbench/discard-attachment']
const P3C1_LINK = ['GET /v1/matter', 'GET /v1/matters']
/** P3e 起一件事上的动作收进 /v1/matter/*(交给分发,处理器在内部 API):只有停下给链接令牌(同别名行冻结的)。 */
const P3E_DEVICE = ['GET /v1/matter/artifact', 'GET /v1/matter/create-receipt', 'POST /v1/matter/answer', 'POST /v1/matter/create', 'POST /v1/matter/handoff', 'POST /v1/matter/permission', 'POST /v1/matter/stop', 'POST /v1/matter/worktree',
  // P3e-2
  'GET /v1/matter/rewind', 'POST /v1/matter/rewind', 'GET /v1/matter/changes', 'POST /v1/matter/review-mark', 'POST /v1/matter/review-return', 'POST /v1/matter/review-comment', 'POST /v1/matter/review-comments-send']
const P3E_LINK = ['POST /v1/matter/stop']
/**
 * P3d 起手机独有的 /v1 行(只有 phone 块,PanelV1Key):处理器在面板这一口,不经分发 —— 不在 PANEL_V1_ROUTES 里,
 * 但在设备 / 链接令牌的集合里(链接令牌只读其中两条,同别名行冻结的)。
 */
const P3D_DEVICE = ['GET /v1/activity', 'GET /v1/home', 'GET /v1/jobs', 'GET /v1/letters/page', 'GET /v1/letters/sent', 'GET /v1/matter/input-receipt', 'GET /v1/matter/insight', 'GET /v1/phone/art/presence', 'GET /v1/phone/state', 'POST /v1/jobs/action', 'POST /v1/phone/push/register', 'POST /v1/phone/push/test',
  // P3d-2
  'GET /v1/companion/transcribe', 'GET /v1/matter/owner-chat/model', 'GET /v1/matter/owner-chat/page', 'GET /v1/matter/owner-chat/voice', 'GET /v1/memory/curated', 'GET /v1/stickers/file/',
  'GET /v1/workbench/attachment/upload', 'GET /v1/workbench/session/continue', 'POST /v1/matter/owner-chat/model', 'POST /v1/matter/owner-chat/say', 'POST /v1/memory/correct',
  'POST /v1/workbench/attachment/chunk', 'POST /v1/workbench/session/continue',
  // P3d-3 terminal actions now use the shared internal dispatcher.
  ]
const P3D_LINK = ['GET /v1/home', 'GET /v1/phone/art/presence']

describe('面板上的 /v1:没有 phone 块的路由,设备 / 链接令牌走不了', () => {
  it('交给分发的(带 desktop + phone 块的)/v1 行只有 P3c-1 / P3c-2 / P3c-3 / P3c-4 / P3e 并的那几条;PHONE_ROUTES / LINK_ROUTES 里的 /v1 键就是它们加 P3d 手机独有的', () => {
    expect([...PANEL_V1_ROUTES.device].sort()).toEqual([...P3C1_DEVICE, ...P3E_DEVICE, ...T4_DEVICE].sort())
    expect([...PANEL_V1_ROUTES.link].sort()).toEqual([...P3C1_LINK, ...P3E_LINK].sort())
    expect([...PHONE_ROUTES].filter(k => k.includes(' /v1/')).sort()).toEqual([...P3C1_DEVICE, ...P3D_DEVICE, ...P3E_DEVICE, ...T4_DEVICE].sort())
    expect([...LINK_ROUTES].filter(k => k.includes(' /v1/')).sort()).toEqual([...P3C1_LINK, ...P3D_LINK, ...P3E_LINK].sort())
    // 链接令牌能写的(LINK_WRITE_OK):/m/api、/set/api 那几条,外加 P3e 的停下(同别名行 POST /m/api/matter/stop 冻结的 write)
    expect(Object.keys(LINK_WRITE_OK).length).toBeGreaterThan(0)
    expect(Object.keys(LINK_WRITE_OK).filter(k => k.includes(' /v1/'))).toEqual(['POST /v1/matter/stop'])
  })

  it('真配对出来的设备令牌、真发的链接令牌:没有 phone 块的每一条 /v1 路由都 403 route_not_allowed,处理器不跑;有的那几条照 link 放', async () => {
    await start()
    const device = await pairDevice()
    const link = panel!.issueToken()
    expect(V1_KEYS.length).toBeGreaterThan(200)
    for (const tok of [device, link]) {
      for (const key of V1_KEYS) {
        const [method, path] = key.split(' ') as [string, string]
        const r = await viaPanel(path, tok, method === 'POST' ? post({}) : {})
        const open = tok === device ? [...P3C1_DEVICE, ...P3D_DEVICE, ...P3E_DEVICE, ...T4_DEVICE].includes(key) : [...P3C1_LINK, ...P3D_LINK, ...P3E_LINK].includes(key)
        if (open) { expect(r.status, `${tok[0]} ${key}`).not.toBe(403); continue }
        expect(r.status, `${tok[0]} ${key}`).toBe(403)
        expect(await r.json()).toEqual({ error: 'route_not_allowed' })
      }
    }
    expect(seen).toEqual([])
    expect(wishPosts).toBe(0)
  })

  it('不在表里的 /v1 路径也是 403(不让 404 / 503 变成探测口)', async () => {
    await start()
    const device = await pairDevice()
    const r = await viaPanel('/v1/does-not-exist', device)
    expect(r.status).toBe(403)
  })

  it('纵深:令牌 routeAllow 里硬塞了 /v1 键,但路由表那一行没有 phone 块 ⇒ 分发那一层 403', async () => {
    await start()
    const allow = new Set([...PHONE_ROUTES, 'GET /v1/social/wishes', 'POST /v1/social/wish/cancel', 'GET /v1/health'])
    api!.panelTokens.register('d' + 'c'.repeat(32), { tier: 'admin', origin: 'device', sessionKey: 'device:forged', routeAllow: allow })
    api!.panelTokens.register('t' + 'e'.repeat(32), { tier: 'admin', origin: 'link', sessionKey: 'link-forged', routeAllow: allow })
    for (const tok of ['d' + 'c'.repeat(32), 't' + 'e'.repeat(32)]) {
      expect((await viaPanel('/v1/social/wishes', tok)).status).toBe(403)
      expect((await viaPanel('/v1/social/wish/cancel', tok, post({}))).status).toBe(403)
      expect((await viaPanel('/v1/health', tok)).status).toBe(403)
    }
    expect(seen).toEqual([])
    expect(wishPosts).toBe(0)
  })
})

describe('面板上的 /v1:有 phone 块的路由(替身名单)', () => {
  const panelRoutes = {
    device: new Set(['GET /v1/social/wishes', 'POST /v1/social/wish/cancel', 'GET /v1/model']),
    link: new Set(['GET /v1/social/wishes']),
  }
  const allow = new Set([...PHONE_ROUTES, ...panelRoutes.device])
  const linkAllow = new Set([...LINK_ROUTES, ...panelRoutes.link])
  const DEV = 'd' + '1'.repeat(32), LINK = 't' + '2'.repeat(32)

  async function startWithPhoneRows() {
    await start({ panelRoutes })
    api!.panelTokens.register(DEV, { tier: 'admin', origin: 'device', sessionKey: 'device:p3b', routeAllow: allow })
    api!.panelTokens.register(LINK, { tier: 'admin', origin: 'link', sessionKey: 'link-p3b', routeAllow: linkAllow })
  }

  it('设备令牌能走:回包就是 /v1 的回包(不套 ok),头是 content-type + no-store、不回 CORS', async () => {
    await startWithPhoneRows()
    const r = await viaPanel('/v1/social/wishes', DEV, { headers: { origin: 'http://evil.example' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ wishes: [] })
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    // 同一条从 127.0.0.1 走,回包字节一样
    const local = await viaLocal('/v1/social/wishes', fileToken)
    expect(await local.json()).toEqual({ wishes: [] })
  })

  it('处理器拿到的查询串没有令牌与隧道标记;caller 带 frameBudget 与出生地,127.0.0.1 进来的不带', async () => {
    await startWithPhoneRows()
    await viaPanel('/v1/social/wishes?x=1&_via=tunnel', DEV)
    await viaLocal('/v1/social/wishes?x=1', fileToken)
    expect(seen).toEqual([
      { query: { x: '1' }, caller: { tier: 'admin', origin: 'device', chatId: undefined, frameBudget: MAX_MOBILE_DETAIL_BYTES, client: 'web' } },
      { query: { x: '1' }, caller: { tier: 'trusted', origin: 'file', chatId: undefined } },
    ])
  })

  it('同一路径另一个方法没有 phone 块 ⇒ 403(GET /v1/model 放给手机不等于 POST 也放)', async () => {
    await startWithPhoneRows()
    expect((await viaPanel('/v1/model', DEV, post({ provider: 'claude' }))).status).toBe(403)
  })

  it('链接令牌:只走 link 是 read / write 的行;设备那几条(写操作)一律 403', async () => {
    await startWithPhoneRows()
    expect((await viaPanel('/v1/social/wishes', LINK)).status).toBe(200)
    const w = await viaPanel('/v1/social/wish/cancel', LINK, post({}))
    expect(w.status).toBe(403)
    expect(await w.json()).toEqual({ error: 'route_not_allowed' })
    expect(wishPosts).toBe(0)
    // 设备令牌能写
    expect((await viaPanel('/v1/social/wish/cancel', DEV, post({}))).status).toBe(418)
    expect(wishPosts).toBe(1)
  })

  it('链接令牌哪怕 routeAllow 里硬塞了写路由,路由表那一行 link 不是 write ⇒ 分发那一层 403', async () => {
    await start({ panelRoutes })
    api!.panelTokens.register(LINK, { tier: 'admin', origin: 'link', sessionKey: 'link-p3b', routeAllow: allow })
    expect((await viaPanel('/v1/social/wish/cancel', LINK, post({}))).status).toBe(403)
    expect(wishPosts).toBe(0)
  })

  it('模块门、正文、坏 JSON 照分发走(面板上同 127.0.0.1 的码)', async () => {
    await startWithPhoneRows()
    const bad = await viaPanel('/v1/social/wish/cancel', DEV, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('malformed_json')
  })
})

describe('panelV1RoutesOf:令牌范围从路由表推', () => {
  it('只取同时有 desktop 与 phone 的 /v1 行;link 只收 read / write', () => {
    const table: Record<string, RouteSpec> = {
      'GET /v1/a': { desktop: { tier: 'admin' }, phone: { link: 'read', reason: 'page reads it' } },
      'POST /v1/a': { desktop: { tier: 'admin' }, phone: { link: 'none' } },
      'POST /v1/b': { desktop: { tier: 'admin' }, phone: { link: 'write', reason: 'page stops it' } },
      'GET /v1/c': { desktop: { tier: 'admin' } },
      'GET /m/api/a': { phone: { link: 'read', reason: 'old alias row' } },
      'GET /v1/d': { phone: { link: 'read', reason: 'no desktop half' } },
    }
    const r = panelV1RoutesOf(table)
    expect([...r.device].sort()).toEqual(['GET /v1/a', 'POST /v1/a', 'POST /v1/b'])
    expect([...r.link].sort()).toEqual(['GET /v1/a', 'POST /v1/b'])
  })
})
