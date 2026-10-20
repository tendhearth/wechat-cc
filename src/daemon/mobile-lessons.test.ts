import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProjectLessons } from '../core/workbench/project-lessons'
import { mobileLessonsRoute } from './mobile-lessons'
import { PHONE_API_SCHEMAS } from '../../packages/protocol/src/api'

const P = 'p-' + 'a'.repeat(20), Q = 'p-' + 'b'.repeat(20)
function setup() {
  const lessons = makeProjectLessons(mkdtempSync(join(tmpdir(), 'ml-')))
  const deps = { projects: () => [{ id: P, name: 'wechat-cc', path: '/w/wechat-cc' }, { id: Q, name: 'rici', path: '/w/rici' }], lessons }
  const run = async (path: string, method = 'GET', body?: unknown, d: unknown = deps) => {
    const r = await mobileLessonsRoute(d as never, new URL('http://x' + path), new Request('http://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return r && { status: r.status, body: await r.json() as any }
  }
  return { lessons, run }
}

describe('/m/api/lessons', () => {
  it('lists only projects with lessons, by catalog id + name, never paths; passes the schema', async () => {
    const s = setup()
    s.lessons.add('/w/wechat-cc', '用 bun')
    const r = await s.run('/m/api/lessons')
    expect(r!.status).toBe(200)
    PHONE_API_SCHEMAS['GET /m/api/lessons']!.parse(r!.body)
    expect(r!.body.projects).toEqual([{ id: P, name: 'wechat-cc', lessons: [{ id: expect.any(String), text: '用 bun' }] }])
    expect(r!.body.choices).toEqual([{ id: P, name: 'wechat-cc' }, { id: Q, name: 'rici' }])
    expect(JSON.stringify(r!.body)).not.toContain('/w/')
  })
  it('add / remove by project id + lesson id; errors are codes only', async () => {
    const s = setup()
    const a = await s.run('/m/api/lessons/add', 'POST', { project: Q, text: '不要动 assets' })
    expect(a!.body).toMatchObject({ ok: true })
    PHONE_API_SCHEMAS['POST /m/api/lessons/add']!.parse(a!.body)
    expect((await s.run('/m/api/lessons/add', 'POST', { project: Q, text: '不要动 assets' }))!.body).toEqual({ ok: false, error: 'duplicate' })
    expect((await s.run('/m/api/lessons/add', 'POST', { project: Q, text: 'a\nb' }))!.body).toEqual({ ok: false, error: 'invalid' })
    expect((await s.run('/m/api/lessons/add', 'POST', { project: 'p-' + 'c'.repeat(20), text: 'x' }))!.status).toBe(404)
    const id = s.lessons.list('/w/rici')[0]!.id
    expect((await s.run('/m/api/lessons/remove', 'POST', { project: Q, id: 'zzzz' }))!.body).toEqual({ ok: false, error: 'not_found' })
    const rm = await s.run('/m/api/lessons/remove', 'POST', { project: Q, id })
    PHONE_API_SCHEMAS['POST /m/api/lessons/remove']!.parse(rm!.body)
    expect(s.lessons.list('/w/rici')).toEqual([])
  })
  it('not wired / still starting ⇒ 503; wrong method ⇒ 405; bad body ⇒ 400; other paths ⇒ null', async () => {
    const s = setup()
    expect((await s.run('/m/api/lessons', 'GET', undefined, null))!.status).toBe(503)
    expect((await s.run('/m/api/lessons', 'GET', undefined, { projects: () => null, lessons: s.lessons }))!.status).toBe(503)
    expect((await s.run('/m/api/lessons', 'POST'))!.status).toBe(405)
    expect((await s.run('/m/api/lessons/add', 'GET'))!.status).toBe(405)
    expect((await s.run('/m/api/lessons/add', 'POST', { project: 1 }))!.status).toBe(400)
    expect(await s.run('/m/api/other')).toBeNull()
  })
})
