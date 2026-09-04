import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { makeRoutes } from './routes'
import { modelStatusPath } from '../atelier-provision'
import { defaultCompanionConfig, saveCompanionConfig } from '../companion/config'

function routesWith(atelier: unknown) {
  return makeRoutes({ deps: { atelier } as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
}

function routesWithState(stateDir: string) {
  return makeRoutes({ deps: { stateDir } as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
}

function routesWithDeps(deps: unknown) {
  return makeRoutes({ deps: deps as never, getDelegate: () => null, maybePrefix: (_c, t) => t })
}

describe('GET /v1/atelier/works', () => {
  it('returns an empty list when the store is wired but has no works', async () => {
    const res = await routesWith({ list: () => [], imagePath: () => null })['GET /v1/atelier/works']!(new URLSearchParams(), undefined)
    expect(res).toEqual({ status: 200, body: { works: [] } })
  })

  it('clamps the requested limit and includes local PNG data when available', async () => {
    const png = Buffer.from('png-data')
    const imagePath = '/tmp/wcc-atelier-route-test.png'
    writeFileSync(imagePath, png)
    const work = { id: 'w1', createdAt: '2026-09-01T00:00:00.000Z', imageFile: 'w1.png', mime: 'image/png', width: 1, height: 1, rendererId: 'local', shareState: 'private', privateCauseSummary: 'secret', impulse: { shouldPaint: true, feeling: 'x', subject: 'fish', surface: 'paper', medium: 'watercolor', gesture: 'wash', composition: 'center', shareIntent: 'private' } }
    const res = await routesWith({ list: (limit: number) => { expect(limit).toBe(24); return [work] }, imagePath: () => imagePath })['GET /v1/atelier/works']!(new URLSearchParams('limit=999'), undefined)
    expect((res.body as any).works[0].image_data).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect((res.body as any).works[0].privateCauseSummary).toBeUndefined()
  })

  it('returns 503 when the store is not wired', async () => {
    const res = await routesWith(undefined)['GET /v1/atelier/works']!(new URLSearchParams(), undefined)
    expect(res.status).toBe(503)
  })
})

describe('GET /v1/atelier/model-status', () => {
  it('reports null before the atelier has ever been enabled', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-atelier-status-'))
    const res = await routesWithState(stateDir)['GET /v1/atelier/model-status']!(new URLSearchParams(), undefined)
    expect(res).toEqual({ status: 200, body: { status: null } })
  })

  it('surfaces the recorded paint-set download progress', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-atelier-status-'))
    const path = modelStatusPath(stateDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ state: 'downloading', attempt: 1, received: 10, total: 100 }))
    const res = await routesWithState(stateDir)['GET /v1/atelier/model-status']!(new URLSearchParams(), undefined)
    expect(res.body).toEqual({ status: { state: 'downloading', attempt: 1, received: 10, total: 100 } })
  })
})

describe('POST /v1/atelier/share', () => {
  async function setup(sendFile = vi.fn(async () => {})) {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-atelier-share-'))
    await saveCompanionConfig(stateDir, { ...defaultCompanionConfig(), default_chat_id: 'owner-chat' })
    const work = { id: 'work-1', shareState: 'private' }
    const transitionShare = vi.fn((_id: string, from: string, to: string) => ({ ...work, shareState: to }))
    const sendReply = vi.fn(async () => ({ msgId: 'm1' }))
    const routes = routesWithDeps({
      stateDir,
      atelier: { load: () => work, imagePath: () => '/safe/work-1.png', transitionShare },
      ilink: { sendFile, sendReply },
    })
    return { routes, transitionShare, sendFile, sendReply }
  }

  it('sends the image to the configured owner with user-reviewed background copy', async () => {
    const d = await setup()
    const res = await d.routes['POST /v1/atelier/share']!(new URLSearchParams(), {
      id: 'work-1', background: { title: '潮线', origin: '我想留住退潮后的安静。', approach: '用树枝留下会被海水擦掉的线。' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, background_sent: true })
    expect(d.sendFile).toHaveBeenCalledWith('owner-chat', '/safe/work-1.png')
    expect(d.sendReply).toHaveBeenCalledWith('owner-chat', '《潮线》\n\n我想留住退潮后的安静。\n\n用树枝留下会被海水擦掉的线。')
    expect(d.transitionShare.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['work-1', 'private', 'pending'], ['work-1', 'pending', 'shared'],
    ])
  })

  it('supports image-only sharing when the background is omitted', async () => {
    const d = await setup()
    const res = await d.routes['POST /v1/atelier/share']!(new URLSearchParams(), { id: 'work-1', background: null })
    expect(res.body).toMatchObject({ ok: true, background_sent: false })
    expect(d.sendReply).not.toHaveBeenCalled()
  })

  it('releases the pending claim when image sending fails', async () => {
    const d = await setup(vi.fn(async () => { throw new Error('send unavailable') }))
    const res = await d.routes['POST /v1/atelier/share']!(new URLSearchParams(), { id: 'work-1', background: null })
    expect(res.body).toEqual({ ok: false, error: 'send unavailable' })
    expect(d.transitionShare.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['work-1', 'private', 'pending'], ['work-1', 'pending', 'private'],
    ])
  })
})
