import { describe, it, expect, vi } from 'vitest'
import { mobileJobsRoutes, type MobileJobsDeps } from './mobile'
import { routePhone } from '../../daemon/phone-route-table'

const call = async (deps: MobileJobsDeps | undefined, path: string, method = 'GET', body?: unknown) => {
  const url = new URL(`http://x${path}`)
  return routePhone(mobileJobsRoutes(deps), url, new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }))
}
const view = { ok: true as const, timezone: 'Asia/Shanghai', executor: 'claude', jobs: [{ id: 'j1', label: '每天 08:00(上海)', text: '早报', brief: true, paused: false, last: null }] }

describe('mobileJobsRoutes(B7)', () => {
  it('not ours ⇒ null; wrong method ⇒ 405; unwired ⇒ 503', async () => {
    expect(await call(undefined, '/m/api/other')).toBeNull()
    expect((await call(undefined, '/m/api/jobs', 'POST'))!.status).toBe(405)
    expect((await call(undefined, '/m/api/jobs'))!.status).toBe(503)
    expect((await call(undefined, '/m/api/jobs/action', 'GET'))!.status).toBe(405)
    expect((await call(undefined, '/m/api/jobs/action', 'POST', { id: 'j1', action: 'pause' }))!.status).toBe(503)
  })
  it('GET returns the view; a broken file is 500 with the error', async () => {
    const deps: MobileJobsDeps = { view: () => view, action: vi.fn(() => ({ ok: true as const })) }
    const r = await call(deps, '/m/api/jobs')
    expect(r!.status).toBe(200)
    expect(await r!.json()).toEqual(view)
    const bad = await call({ view: () => ({ ok: false, error: 'jobs_unreadable' }), action: vi.fn() }, '/m/api/jobs')
    expect(bad!.status).toBe(500)
  })
  it('POST action: exactly {id, action}; validates both; not_found ⇒ 404', async () => {
    const action = vi.fn((id: string) => (id === 'j1' ? { ok: true as const } : { ok: false as const, error: 'not_found' as const }))
    const deps: MobileJobsDeps = { view: () => view, action }
    expect((await call(deps, '/m/api/jobs/action', 'POST', { id: 'j1', action: 'pause' }))!.status).toBe(200)
    expect(action).toHaveBeenCalledWith('j1', 'pause')
    for (const b of [{ id: 'j1' }, { id: 'j1', action: 'run' }, { id: '../x', action: 'pause' }, { id: 'j1', action: 'pause', extra: 1 }, 'x'])
      expect((await call(deps, '/m/api/jobs/action', 'POST', b))!.status, JSON.stringify(b)).toBe(400)
    expect((await call(deps, '/m/api/jobs/action', 'POST', { id: 'j9', action: 'remove' }))!.status).toBe(404)
  })
})
