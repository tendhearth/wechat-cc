/**
 * 模块门(第三批 3b):表里标了 module 的路由,那个模块此刻不是 ok ⇒ 鉴权之后统一 503,处理器不跑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ROUTES, MODULE_NAMES } from '@wechat-cc/protocol/routes'
import { createInternalApi, type InternalApi } from '../internal-api'
import type { SubsystemStatus } from '../subsystems'
import { moduleFor } from './route-tiers'

describe('模块门', () => {
  let stateDir: string
  let api: InternalApi | null = null
  let subsystems: SubsystemStatus[] = []
  let wishCalls = 0

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'module-gate-'))
    subsystems = []
    wishCalls = 0
  })
  afterEach(async () => {
    if (api) await api.stop()
    api = null
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function start() {
    api = createInternalApi({
      stateDir, daemonPid: 1,
      subsystems: () => subsystems,
      social: { wish: { list: () => { wishCalls++; return [] } } } as never,
    })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    return (path: string, auth = true) => fetch(`http://127.0.0.1:${port}${path}`, auth ? { headers: { Authorization: `Bearer ${token}` } } : {})
  }

  it('主人关的 ⇒ 503 module_off,处理器不跑', async () => {
    subsystems = [{ name: 'social', state: 'off', sinceIso: '2026-10-22T00:00:00.000Z' }]
    const get = await start()
    const r = await get('/v1/social/wishes')
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'module_off', module: 'social' })
    expect(wishCalls).toBe(0)
  })

  it('开着却没起来 ⇒ 503 module_degraded 带原因(不说成关了)', async () => {
    subsystems = [{ name: 'social', state: 'degraded', error: 'no cheap model', sinceIso: '2026-10-22T00:00:00.000Z' }]
    const get = await start()
    const r = await get('/v1/social/wishes')
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'module_degraded', module: 'social', detail: 'no cheap model' })
  })

  it('先鉴权:没带令牌照旧 401,拿不到 module_off(不让模块门变成探测口)', async () => {
    subsystems = [{ name: 'social', state: 'off', sinceIso: '2026-10-22T00:00:00.000Z' }]
    const get = await start()
    const r = await get('/v1/social/wishes', false)
    expect(r.status).toBe(401)
  })

  it('模块 ok,或 subsystems 里没登记这个模块 ⇒ 放给处理器', async () => {
    subsystems = [{ name: 'social', state: 'ok', sinceIso: '2026-10-22T00:00:00.000Z' }]
    const get = await start()
    expect((await get('/v1/social/wishes')).status).not.toBe(503)
    subsystems = []
    expect((await get('/v1/social/wishes')).status).not.toBe(503)
    expect(wishCalls).toBe(2)
  })

  it('开关路由本身不归模块管:社交关着也要能打开它', () => {
    expect(moduleFor('POST /v1/social/enable')).toBeUndefined()
  })

  it('表里每个 module 都是 MODULE_NAMES 里的名字', () => {
    const names = new Set<string>(MODULE_NAMES)
    for (const [key, spec] of Object.entries(ROUTES)) {
      if (spec.module !== undefined) expect(names.has(spec.module), key).toBe(true)
    }
  })
})

describe('功能模块自己挂路由(架构终态 A3:internalApi.mount)', () => {
  let stateDir: string
  let api: InternalApi | null = null
  let subsystems: SubsystemStatus[] = []
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'mount-')); subsystems = [] })
  afterEach(async () => { if (api) await api.stop(); api = null; rmSync(stateDir, { recursive: true, force: true }) })

  async function start() {
    api = createInternalApi({ stateDir, daemonPid: 1, subsystems: () => subsystems })
    const { port } = await api.start()
    const token = api.mintSessionToken('admin', 'claude/main/owner-chat')
    return (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  }
  const ok = { name: 'calendar', state: 'ok' as const, sinceIso: '2026-10-25T00:00:00.000Z' }

  it('挂上之后走模块自己的处理器', async () => {
    subsystems = [ok]
    const get = await start()
    api!.mount('calendar', { 'GET /v1/calendar/agenda': async () => ({ status: 200, body: { ok: true, text: 'x' } }) })
    const r = await get('/v1/calendar/agenda')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, text: 'x' })
  })
  it('模块开着、还没挂上(开机途中)⇒ 503 module_starting(不是关了、不是坏了、也不是 404)', async () => {
    subsystems = [ok]
    const get = await start()
    const r = await get('/v1/calendar/agenda')
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'module_starting', module: 'calendar' })
  })
  it('模块关着 ⇒ module_off;坏了 ⇒ module_degraded(处理器挂没挂都一样)', async () => {
    subsystems = [{ ...ok, state: 'off' }]
    const get = await start()
    expect(await (await get('/v1/calendar/agenda')).json()).toEqual({ error: 'module_off', module: 'calendar' })
    subsystems = [{ ...ok, state: 'degraded', error: 'osascript missing' }]
    expect(await (await get('/v1/calendar/agenda')).json()).toEqual({ error: 'module_degraded', module: 'calendar', detail: 'osascript missing' })
  })
  it('只能挂表里标给自己的路由;不能重复挂;不能顶掉总表里的', async () => {
    await start()
    expect(() => api!.mount('calendar', { 'GET /v1/social/wishes': async () => ({ status: 200, body: {} }) })).toThrow(/does not mark it/)
    api!.mount('calendar', { 'GET /v1/calendar/agenda': async () => ({ status: 200, body: {} }) })
    expect(() => api!.mount('calendar', { 'GET /v1/calendar/agenda': async () => ({ status: 200, body: {} }) })).toThrow(/already registered/)
  })
})
