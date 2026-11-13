import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { CheckupViewSchema, CheckupEstimateSchema, type CheckupTarget } from '@wechat-cc/protocol'
import { createInternalApi } from '../../daemon/internal-api'
import type { RouteHandler } from '../../daemon/internal-api/types'
import { AGY_STATIC_SESSION_KEY, type TokenInfo } from '../../daemon/internal-api/token-registry'
import { PANEL_V1_ROUTES, routesForToken } from '../../daemon/internal-api/route-tiers'
import { PHONE_ROUTES, LINK_ROUTES } from '../phone/phone-routes'
import { makeCheckupStore } from '../../adapters/store/checkup-store'
import type { CheckupSample } from '../../domain/butler-checkup'
import { checkupRoutes } from './routes'
import { makeCheckupService } from './service'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const keys = ['GET /v1/checkup', 'POST /v1/checkup/estimate', 'POST /v1/checkup/run', 'POST /v1/checkup/cancel', 'POST /v1/checkup/settings'] as const
const owner = { tier: 'admin' as const, origin: 'operator' as const }
const params = new URLSearchParams()
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'checkup-routes-'))
  dirs.push(dir)
  let target: CheckupTarget = { provider: 'fake', address: 'https://example.invalid/v1', model: 'fabricated-a', windowTokens: 8192, windowKnown: false }
  const run = vi.fn(async (sample: CheckupSample) => ({
    text: sample.kind === 'memory' ? JSON.stringify(sample.answers) : '',
    toolCalls: sample.kind === 'tool' ? [{ name: sample.tool, input: sample.input }] : [],
    firstTextMs: 1, durationMs: 2,
  }))
  const service = makeCheckupService({ store: makeCheckupStore(dir), resolveTarget: () => ({ ...target }), run, version: 'test' })
  return { dir, service, run, routes: checkupRoutes(service), setTarget: (next: Partial<CheckupTarget>) => { target = { ...target, ...next } } }
}
function bodyFor(key: string, expectedTargetKey: string) {
  return key.endsWith('/run') ? { expectedTargetKey } : key.endsWith('/settings') ? { periodicProbe: false } : {}
}

describe('checkup: owner-only routes and real dispatch', () => {
  it('registers the same feature routes for operator and paired devices, with no link scope', () => {
    const h = setup()
    expect(Object.keys(h.routes).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect(ROUTES[key]).toEqual({ module: 'checkup', desktop: { tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true }, phone: { link: 'none' } })
      expect(routesForToken('operator').has(key)).toBe(true)
      expect(PHONE_ROUTES.has(key)).toBe(true)
      expect(PANEL_V1_ROUTES.device.has(key)).toBe(true)
      expect(LINK_ROUTES.has(key)).toBe(false)
      expect(PANEL_V1_ROUTES.link.has(key)).toBe(false)
    }
  })

  it('denies every handler before data access or spending for non-owner and model/session origins', async () => {
    const h = setup(), targetKey = h.service.estimate().targetKey!
    const denied: Array<Parameters<RouteHandler>[2]> = [
      undefined,
      { tier: 'trusted', origin: 'operator' }, { tier: 'guest', origin: 'device' },
      { tier: 'admin', origin: 'file' }, { tier: 'admin', origin: 'session', chatId: 'owner' },
      { tier: 'admin', origin: 'session', sessionKey: AGY_STATIC_SESSION_KEY, turnChatId: 'owner', sharedTurn: 'bound' },
      { tier: 'admin', origin: 'link' },
    ]
    for (const caller of denied) for (const key of keys) {
      expect(await h.routes[key]!(params, bodyFor(key, targetKey), caller)).toEqual({ status: 403, body: { error: 'forbidden' } })
    }
    expect(h.run).not.toHaveBeenCalled()
    expect(h.service.view().attempt).toBeNull()
    expect(h.service.view().periodicProbe).toBe(false)
  })

  it('real HTTP rejects file, admin session, owner session and shared tokens; operator reads and estimates', async () => {
    const h = setup(), api = createInternalApi({ stateDir: h.dir, daemonPid: 1 })
    api.mount('checkup', h.routes)
    const server = await api.start()
    const call = (key: typeof keys[number], token: string) => {
      const [method, path] = key.split(' ')
      return fetch('http://127.0.0.1:' + server.port + path, {
        method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(bodyFor(key, h.service.estimate().targetKey!)) } : {}),
      })
    }
    try {
      const denied = [
        readFileSync(server.tokenFilePath, 'utf8').trim(),
        api.mintSessionToken('trusted', 'guest/claude'),
        api.mintSessionToken('admin', 'owner/claude'),
        api.mintSessionToken('admin', AGY_STATIC_SESSION_KEY),
      ]
      for (const token of denied) for (const key of keys) expect((await call(key, token)).status).toBe(403)
      expect((await call(keys[0], 'invalid-token')).status).toBe(401)
      expect(h.run).not.toHaveBeenCalled()
      const operator = readFileSync(server.operatorTokenFilePath, 'utf8').trim()
      const view = await call(keys[0], operator)
      expect(view.status).toBe(200)
      expect(CheckupViewSchema.safeParse(await view.json()).success).toBe(true)
      const estimate = await call(keys[1], operator)
      expect(estimate.status).toBe(200)
      expect(CheckupEstimateSchema.safeParse(await estimate.json()).success).toBe(true)
      expect(h.run).not.toHaveBeenCalled()
    } finally { await h.service.stop(); await api.stop() }
  })

  it('real panel dispatch allows paired device routes and denies links, non-admin devices and wrong entry origins', async () => {
    const h = setup(), api = createInternalApi({ stateDir: h.dir, daemonPid: 1 })
    api.mount('checkup', h.routes)
    const call = (key: typeof keys[number], caller: TokenInfo) => {
      const [method, path] = key.split(' ')
      return api.panelDispatch(new Request('https://relay.example' + path, {
        method, headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(bodyFor(key, h.service.estimate().targetKey!)) } : {}),
      }), caller, { frameBudget: 65536, client: 'app' })
    }
    const device: TokenInfo = { tier: 'admin', origin: 'device', sessionKey: 'device:fixture', routeAllow: PHONE_ROUTES }
    try {
      for (const key of keys) {
        expect((await call(key, { ...device, origin: 'link', routeAllow: new Set(keys) })).status).toBe(403)
        expect((await call(key, { ...device, tier: 'trusted' })).status).toBe(403)
        for (const origin of ['operator', 'file', 'session'] as const) expect((await call(key, { ...device, origin })).status).toBe(401)
      }
      expect(h.run).not.toHaveBeenCalled()
      const view = await call(keys[0], device)
      expect(view.status).toBe(200)
      expect(CheckupViewSchema.safeParse(await view.json()).success).toBe(true)
      expect((await call(keys[1], device)).status).toBe(200)
      expect((await call(keys[2], device)).status).toBe(202)
      expect((await call(keys[3], device)).status).toBe(200)
      expect((await call(keys[4], device)).status).toBe(200)
    } finally { await h.service.stop(); await api.stop() }
  })

  it('rejects model and endpoint changes after cost estimate before starting any model request', async () => {
    const h = setup(), first = h.service.estimate().targetKey!
    h.setTarget({ model: 'fabricated-b' })
    expect(await h.routes['POST /v1/checkup/run']!(params, { expectedTargetKey: first }, owner)).toEqual({ status: 409, body: { error: 'checkup_target_changed' } })
    const second = h.service.estimate().targetKey!
    h.setTarget({ address: 'https://other.example.invalid/v1' })
    expect(await h.routes['POST /v1/checkup/run']!(params, { expectedTargetKey: second }, owner)).toEqual({ status: 409, body: { error: 'checkup_target_changed' } })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.service.view().profile).toBeNull()
    expect(h.service.view().attempt).toBeNull()
  })
})

it('paired devices cannot select a backend or model, while local operators can',async()=>{
  const h=setup(),device={tier:'admin' as const,origin:'device' as const}
  for(const field of [{providerId:'other'},{model:'other-model'}]){
    for(const key of ['POST /v1/checkup/estimate','POST /v1/checkup/run']){
      expect(await h.routes[key]!(params,{...field,expectedTargetKey:h.service.estimate().targetKey},device)).toEqual({status:403,body:{error:'forbidden'}})
    }
  }
  expect(await h.routes['GET /v1/checkup']!(new URLSearchParams('provider=other'),undefined,device)).toEqual({status:403,body:{error:'forbidden'}})
  expect((await h.routes['POST /v1/checkup/estimate']!(params,{providerId:'other',model:'other-model'},owner))?.status).toBe(200)
  expect(h.run).not.toHaveBeenCalled()
})
it('paired manual requests are limited and operator requests can bypass the daily cap',async()=>{
  const h=setup(),device={tier:'admin' as const,origin:'device' as const},body={expectedTargetKey:h.service.estimate().targetKey}
  for(let i=0;i<3;i++){
    expect((await h.routes['POST /v1/checkup/run']!(params,body,device))?.status).toBe(202)
    await h.service.stop()
  }
  expect(await h.routes['POST /v1/checkup/run']!(params,body,device)).toEqual({status:429,body:{error:'checkup_rate_limited'}})
  expect((await h.routes['POST /v1/checkup/run']!(params,body,owner))?.status).toBe(202)
  await h.service.stop()
})
it('cannot upgrade a short estimate to a full run through the route',async()=>{
  const h=setup()
  expect(await h.routes['POST /v1/checkup/run']!(params,{expectedTargetKey:h.service.estimate().targetKey,full:true},owner)).toEqual({status:409,body:{error:'checkup_target_changed'}})
  expect(h.run).not.toHaveBeenCalled()
})
