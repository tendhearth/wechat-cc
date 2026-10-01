import { describe, expect, it } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { mobileReadsRoute } from './mobile-reads'
import type { ConnectionsSnapshot } from './connections'

const SNAP: ConnectionsSnapshot = {
  generatedAt: 1, computers: [{ id: 'home', label: 'Mac', online: true, since: 0, version: '1.7.1' }], recent: [], outputs: [],
  sources: [{ id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: '/Users/nate/plugins' } }],
}
const run = async (deps: Parameters<typeof mobileReadsRoute>[0], path: string, method = 'GET') => {
  const r = await mobileReadsRoute(deps, new URL('http://x' + path), new Request('http://x' + path, { method }))
  return r && { status: r.status, body: await r.json() as any }
}

describe('GET /m/api/connections', () => {
  it('去掉 detail,过 schema', async () => {
    const r = await run({ connections: () => SNAP }, '/m/api/connections')
    expect(r!.status).toBe(200)
    const text = JSON.stringify(r!.body)
    expect(text).not.toContain('/Users')
    expect(text).not.toContain('missing')
    PHONE_API_SCHEMAS['GET /m/api/connections']!.parse(r!.body)
  })
  it('没接 ⇒ 503;抛 ⇒ 503 unavailable(裁定 7);别的路径 ⇒ null;非 GET ⇒ 405', async () => {
    expect((await run({}, '/m/api/connections'))!.status).toBe(503)
    const thrown = await run({ connections: () => { throw new Error('x') } }, '/m/api/connections')
    expect(thrown!.status).toBe(503)
    expect(thrown!.body).toEqual({ ok: false, error: 'unavailable' })
    expect(await run({}, '/m/api/matters')).toBeNull()
    expect((await run({ connections: () => SNAP }, '/m/api/connections', 'POST'))!.status).toBe(405)
  })
})
