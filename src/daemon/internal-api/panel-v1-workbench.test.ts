/**
 * P3c-4 并的五条(设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3c」):交办选项、交办时问模型、
 * 扔掉一份材料、电脑上的原生会话列表 / 读一页。手机令牌从面板那一口走 `/v1/workbench/*` 那一个处理器以后,能做的和并之前
 * `/m/api` 手机处理器让它做的**一样多**,不多一点。
 *
 * 要盯的是桌面那几条比手机宽的地方:
 *   - `/v1/workbench/models` 给桌面认任意绝对路径(`path`)—— 手机只说得出项目目录 id,路径在电脑上解析;
 *   - `/v1/workbench/discard-attachment` 给桌面还能扔一次性上传的材料 —— 手机只扔自己分块上传的那一份(按手机表面);
 *   - `/v1/workbench/sessions` / `session` 给桌面完整路径 `cwd`、原生 id,认 `limit`(到 500)/ `cwd` 过滤 —— 手机只见目录名、
 *     一页 30 / 20、不认这两个参数,读法走单飞 + 短缓存。
 * 这里拿真配对的设备令牌、真发的链接令牌,新键(`/v1/…`)和别名键(`/m/api/…`)两条路都打,再拿 operator 从 127.0.0.1
 * 打同一条作对照(那边一字不变)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, type InternalApi } from './index'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { workbenchRoutes } from '../../features/workbench/routes'
import { phoneSessionsOf } from '../../features/workbench/phone-sessions'
import type { WorkbenchService } from '../../features/workbench'
import { encodeNativeHistoryKey } from '../../adapters/workbench/native-history'

const OWNER = 'owner@im.wechat'
const PROJECT = 'p-0123456789abcdef0123'
const UP = '66666666-6666-4666-8666-666666666666', DRAFT = '55555555-5555-4555-8555-555555555555'
const OPTIONS = { status: 'needs_connection' as const, defaultProviderId: null, providers: [], projects: [] }
const CATALOG = { models: [{ id: 'opus', displayName: 'Opus', reasoningEfforts: [] }], source: 'native' }
/** 原生会话的键(桌面那条会 decode 它)。 */
const KEY = encodeNativeHistoryKey('claude', '77777777-7777-4777-8777-777777777777')
const ITEM = { key: KEY, providerId: 'claude' as const, nativeId: 'native-s1', title: '修登录', titleSource: 'first_prompt' as const, cwd: '/Users/owner/secret/app', updatedAt: 5, remote: false, observedState: 'active' as const }
const PAGE = { items: [ITEM], nextCursor: null, coverage: 'native_supported_history' as const }
const PREVIEW = { session: ITEM, messages: [{ id: 'u1', role: 'user' as const, text: '修登录', truncated: false }], nextCursor: null, sourceFingerprint: 'fp', page: { limit: 20, cursor: null }, truncated: false }

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string
let device: string, link: string
let wb: {
  entryOptions: ReturnType<typeof vi.fn>; entryModels: ReturnType<typeof vi.fn>; modelCatalog: ReturnType<typeof vi.fn>
  discardAttachmentUpload: ReturnType<typeof vi.fn>; discardAttachment: ReturnType<typeof vi.fn>
  listNativeHistory: ReturnType<typeof vi.fn>; readNativeHistory: ReturnType<typeof vi.fn>; readRecentNativeHistory: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'panel-v1-workbench-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  wb = {
    entryOptions: vi.fn(() => OPTIONS), entryModels: vi.fn(async () => CATALOG), modelCatalog: vi.fn(async () => CATALOG),
    discardAttachmentUpload: vi.fn(), discardAttachment: vi.fn(),
    listNativeHistory: vi.fn(async () => PAGE), readNativeHistory: vi.fn(async () => PREVIEW), readRecentNativeHistory: vi.fn(async () => PREVIEW),
  }
  const service = wb as unknown as WorkbenchService
  api = createInternalApi({ stateDir, daemonPid: 1 })
  // 同生产(features/workbench/index.ts):工作台模块自己挂路由,手机读原生会话的那一份经 phoneSessionsOf(单飞 + 短缓存)
  api.mount('workbench', workbenchRoutes({ workbench: service, resolveAdminChatId: () => OWNER, phoneSessions: { sessions: phoneSessionsOf(service), executorName: id => `名字-${id}` } }))
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  operator = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
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
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const viaLocal = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${localBase}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } })
const PHONE_CTX = { ownerKey: OWNER, surface: 'phone' }

describe('交办选项:手机令牌按手机表面问,链接令牌够不着', () => {
  it('设备令牌两条路都是同一份选项,按手机表面问;operator 按桌面表面问', async () => {
    for (const path of ['/v1/workbench/entry-options', '/m/api/entry/options']) {
      wb.entryOptions.mockClear()
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      expect(await r.json(), path).toMatchObject(OPTIONS)
      expect(wb.entryOptions, path).toHaveBeenCalledExactlyOnceWith(PHONE_CTX)
    }
    wb.entryOptions.mockClear()
    expect((await viaLocal('/v1/workbench/entry-options', operator)).status).toBe(200)
    expect(wb.entryOptions).toHaveBeenCalledExactlyOnceWith({ ownerKey: OWNER, surface: 'desktop' })
  })
  it('链接令牌两条路都 403,处理器不跑', async () => {
    for (const path of ['/v1/workbench/entry-options', '/m/api/entry/options']) expect((await viaPanel(path, link)).status, path).toBe(403)
    expect(wb.entryOptions).not.toHaveBeenCalled()
  })
})

describe('GET /v1/workbench/models:手机只说得出执行者 + 项目目录 id,不认 path', () => {
  it('设备令牌两条路:按项目 id 问(路径在电脑上解析),不走按路径问的那一个', async () => {
    for (const path of [`/v1/workbench/models?providerId=codex&projectId=${PROJECT}`, `/m/api/entry/models?providerId=codex&projectId=${PROJECT}`]) {
      wb.entryModels.mockClear()
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      expect(await r.json(), path).toMatchObject({ catalog: CATALOG })
      expect(wb.entryModels, path).toHaveBeenCalledExactlyOnceWith({ providerId: 'codex', projectId: PROJECT }, PHONE_CTX)
    }
    expect(wb.modelCatalog).not.toHaveBeenCalled()
  })
  it('设备令牌带 path(桌面那条的参数)/ 多余参数 / 坏 id ⇒ 两条路都 400,什么都不问', async () => {
    for (const base of ['/v1/workbench/models', '/m/api/entry/models']) {
      for (const q of ['?providerId=codex&path=/Users/owner/secret', `?providerId=codex&projectId=${PROJECT}&path=/tmp`, '?providerId=codex&projectId=/Users/owner', '?providerId=Codex', '?providerId=codex&providerId=claude', '?providerId=codex&extra=1', '']) {
        expect((await viaPanel(base + q, device)).status, base + q).toBe(400)
      }
    }
    expect(wb.entryModels).not.toHaveBeenCalled()
    expect(wb.modelCatalog).not.toHaveBeenCalled()
  })
  it('链接令牌两条路都 403;对照:operator 照旧按绝对路径问', async () => {
    for (const path of [`/v1/workbench/models?providerId=codex&projectId=${PROJECT}`, `/m/api/entry/models?providerId=codex&projectId=${PROJECT}`]) expect((await viaPanel(path, link)).status, path).toBe(403)
    expect(wb.entryModels).not.toHaveBeenCalled()
    const r = await viaLocal('/v1/workbench/models?providerId=codex&path=/Users/owner/app', operator)
    expect(r.status).toBe(200)
    expect(wb.modelCatalog).toHaveBeenCalledExactlyOnceWith('codex', '/Users/owner/app')
    expect(wb.entryModels).not.toHaveBeenCalled()
  })
})

describe('POST /v1/workbench/discard-attachment:手机只扔自己分块上传的那一份', () => {
  it('设备令牌两条路:交给上传登记处(手机表面、正文原样),不走桌面那条能扔一次性上传的', async () => {
    for (const path of ['/v1/workbench/discard-attachment', '/m/api/attachment/discard']) {
      wb.discardAttachmentUpload.mockClear()
      const r = await viaPanel(path, device, post({ id: UP, draftId: DRAFT }))
      expect(r.status, path).toBe(200)
      expect(await r.json(), path).toEqual({ ok: true })
      expect(wb.discardAttachmentUpload, path).toHaveBeenCalledExactlyOnceWith({ id: UP, draftId: DRAFT }, PHONE_CTX)
    }
    expect(wb.discardAttachment).not.toHaveBeenCalled()
  })
  it('链接令牌两条路都 403;对照:operator 照旧走桌面那条', async () => {
    for (const path of ['/v1/workbench/discard-attachment', '/m/api/attachment/discard']) expect((await viaPanel(path, link, post({ id: UP, draftId: DRAFT }))).status, path).toBe(403)
    expect(wb.discardAttachmentUpload).not.toHaveBeenCalled()
    expect((await viaLocal('/v1/workbench/discard-attachment', operator, post({ id: UP, draftId: DRAFT }))).status).toBe(200)
    expect(wb.discardAttachment).toHaveBeenCalledExactlyOnceWith(UP, DRAFT)
    expect(wb.discardAttachmentUpload).not.toHaveBeenCalled()
  })
})

describe('原生会话:手机只见目录名、一页 30 / 20,不认 cwd / limit', () => {
  it('设备令牌两条路读列表:一页 30、行里没有 cwd / 原生 id', async () => {
    for (const [path, provider] of [['/v1/workbench/sessions?providerId=claude', 'claude'], ['/m/api/sessions?provider=codex', 'codex']] as const) {
      wb.listNativeHistory.mockClear()
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      const text = await r.text()
      expect(text, path).not.toContain('/Users')
      expect(text, path).not.toContain('native-s1')
      expect(JSON.parse(text).items[0], path).toEqual({ key: KEY, provider: 'claude', title: '修登录', project: 'app', updatedAt: 5, active: true, displayName: '名字-claude' })
      expect(wb.listNativeHistory, path).toHaveBeenCalledExactlyOnceWith(provider, { q: '', limit: 30 })
    }
  })
  it('设备令牌两条路读一页:一页 20、没有 cwd', async () => {
    for (const path of [`/v1/workbench/session?key=${KEY}`, `/m/api/session?key=${KEY}`]) {
      const r = await viaPanel(path, device)
      expect(r.status, path).toBe(200)
      const text = await r.text()
      expect(text, path).not.toContain('/Users')
      expect(JSON.parse(text), path).toMatchObject({ ok: true, managed: false, window: 'start', session: { project: 'app' } })
      // 单飞 + 短缓存:第二条路命中第一条的结果(同一份缓存,不再扫)
    }
    expect(wb.readNativeHistory).toHaveBeenCalledExactlyOnceWith(KEY, { limit: 20 })
  })
  it('设备令牌新键带 cwd / limit(桌面那条的参数)⇒ 400,什么都不读', async () => {
    for (const q of ['/v1/workbench/sessions?providerId=claude&cwd=/Users/owner/secret', '/v1/workbench/sessions?providerId=claude&limit=500', `/v1/workbench/session?key=${KEY}&limit=500`]) {
      expect((await viaPanel(q, device)).status, q).toBe(400)
    }
    expect(wb.listNativeHistory).not.toHaveBeenCalled()
    expect(wb.readNativeHistory).not.toHaveBeenCalled()
  })
  it('链接令牌四条路都 403,不读', async () => {
    for (const path of ['/v1/workbench/sessions?providerId=claude', '/m/api/sessions?provider=claude', `/v1/workbench/session?key=${KEY}`, `/m/api/session?key=${KEY}`]) expect((await viaPanel(path, link)).status, path).toBe(403)
    expect(wb.listNativeHistory).not.toHaveBeenCalled()
    expect(wb.readNativeHistory).not.toHaveBeenCalled()
  })
  it('对照:operator 从 127.0.0.1 照旧拿桌面那一份(完整路径、limit / cwd 照认、不经缓存)', async () => {
    const r = await viaLocal('/v1/workbench/sessions?providerId=claude&limit=5&cwd=/Users/owner/secret/app', operator)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(PAGE)
    expect(wb.listNativeHistory).toHaveBeenCalledExactlyOnceWith('claude', { q: '', limit: 5, cwd: normalize('/Users/owner/secret/app') })  // normalizeHistoryList 按平台 normalize(Windows 上是 \Users\…,不带盘符)
    const page = await viaLocal(`/v1/workbench/session?key=${KEY}&limit=7`, operator)
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual(PREVIEW)
    expect(wb.readNativeHistory).toHaveBeenCalledExactlyOnceWith(KEY, { limit: 7 })
  })
})
