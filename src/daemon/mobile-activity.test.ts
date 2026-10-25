import { describe, expect, it } from 'vitest'
import { mobileActivityRoutes } from './mobile-activity'
import { routePhone } from './phone-route-table'
import { PHONE_API_SCHEMAS } from '../../packages/protocol/src/api'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const run = async (deps: Parameters<typeof mobileActivityRoutes>[0], path: string, method = 'GET') => {
  const r = await routePhone(mobileActivityRoutes(deps), new URL('http://x' + path), new Request('http://x' + path, { method }))
  return r && { status: r.status, body: await r.json() as any }
}
const items = Array.from({ length: 5 }, (_, i) => ({ id: `job:${i}`, kind: 'job' as const, at: NOW - i * 60_000, title: `定时 j${i}:说了` }))

describe('GET /m/api/activity', () => {
  it('pages with a cursor, passes the schema, reports degraded sources', async () => {
    const deps = { sources: () => ({ log: items, letters: null }), now: () => NOW }
    const p1 = await run(deps, '/m/api/activity?limit=2')
    expect(p1!.status).toBe(200)
    PHONE_API_SCHEMAS['GET /m/api/activity']!.parse(p1!.body)
    expect(p1!.body.items.map((i: any) => i.id)).toEqual(['job:0', 'job:1'])
    expect(p1!.body.degraded).toEqual(['letters'])
    const p2 = await run(deps, `/m/api/activity?limit=2&cursor=${p1!.body.next}`)
    expect(p2!.body.items.map((i: any) => i.id)).toEqual(['job:2', 'job:3'])
  })
  it('not wired ⇒ 503; throws ⇒ 500; non-GET ⇒ 405; bad limit ⇒ clamped; other paths ⇒ null', async () => {
    expect((await run(undefined, '/m/api/activity'))!.status).toBe(503)
    expect((await run({ sources: () => { throw new Error('x') }, now: () => NOW }, '/m/api/activity'))!.status).toBe(500)
    expect((await run({ sources: () => ({}), now: () => NOW }, '/m/api/activity', 'POST'))!.status).toBe(405)
    expect((await run({ sources: () => ({ log: items }), now: () => NOW }, '/m/api/activity?limit=abc'))!.body.items).toHaveLength(5)
    expect(await run({ sources: () => ({}), now: () => NOW }, '/m/api/other')).toBeNull()
  })
})

describe('GET /m/api/activity · 向前兼容', () => {
  it('a newer daemon adding a kind / ref type still passes the schema (old apps keep drawing the page)', () => {
    const body = { ok: true, items: [{ id: 'x:1', kind: 'future_kind', at: NOW, title: '新的一类', ref: { type: 'future_ref', id: 'z' } }], next: null, degraded: [] }
    expect(PHONE_API_SCHEMAS['GET /m/api/activity']!.safeParse(body).success).toBe(true)
  })
})
