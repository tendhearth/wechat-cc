import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makePlacesStore } from '../../adapters/store/places-store'
import type { Matter } from '../../ports/matters'
import type { InternalApiDeps } from '../../daemon/internal-api/types'
import { makePlacesReader, placeKey, PLACES_WINDOW_MS } from './places-reader'
import { placesRoutes } from './places-routes'

const DAY = 24 * 3_600_000
const NOW = 100 * DAY
const m = (id: string, extra: Partial<Matter> = {}): Matter => ({ id, kind: 'task', title: `事 ${id}`, state: 'working', archivedAt: null, projectPath: '/w/rici', ownerChatId: null, originMatterId: null, originMessageId: `msg-${id}`, createdAt: 1, updatedAt: NOW - 60_000, ...extra })

function setup(rows: Matter[], terminals: any[] = [], now: () => number = () => NOW) {
  const db = openTestDb()
  const store = makePlacesStore(db)
  const list = (f: { kind?: string; state?: string; since?: number } = {}) =>
    rows.filter(r => (!f.kind || r.kind === f.kind) && (!f.state || r.state === f.state) && (f.since === undefined || r.updatedAt >= f.since))
  const reader = makePlacesReader({
    roster: { matters: { list, get: id => rows.find(r => r.id === id) ?? null }, terminals: () => terminals, seen: () => null, now },
    store,
    root: p => (p ? (p.startsWith('/private/tmp/claude-') ? `claude-scratch:${p.split('/')[4]}` : p.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')) : null),
  })
  return { reader, store }
}
const call = (deps: Partial<InternalApiDeps>, key: string, body: unknown, origin: 'operator' | 'device' | 'link' = 'operator', headers = new Headers()) =>
  placesRoutes(deps as InternalApiDeps)[key]!(new URLSearchParams(), body, { tier: 'admin', origin }, { signal: new AbortController().signal, onSent: () => {}, headers })

describe('地方:读', () => {
  it('同一项目的事并成一行;工作区认回主仓库;第一次见到的存进顺序表', () => {
    const { reader, store } = setup([m('aaaa0001'), m('aaaa0002', { projectPath: '/w/rici/.claude/worktrees/x' }), m('aaaa0003', { projectPath: '/w/melu', updatedAt: NOW })])
    const out = reader.read('operator')
    expect(out.places.map(p => [p.name, p.matterIds.length])).toEqual([['melu', 1], ['rici', 2]])
    expect(out.places[1]!.messageIds.sort()).toEqual(['msg-aaaa0001', 'msg-aaaa0002'])
    expect(store.list().map(r => r.name)).toEqual(['melu', 'rici'])
    expect(out.version).toMatch(/^[a-f0-9]{16}$/)
  })

  it('往回看 30 天:3 天前做完的还在那一行上,40 天前的不读', () => {
    const { reader } = setup([m('bbbb0001', { state: 'done', updatedAt: NOW - 3 * DAY }), m('bbbb0002', { state: 'done', projectPath: '/w/old', updatedAt: NOW - 40 * DAY })])
    expect(reader.read('operator').places.map(p => [p.name, p.status, p.line])).toEqual([['rici', 'done', '事 bbbb0001']])
    expect(PLACES_WINDOW_MS).toBe(30 * DAY)
  })

  it('挂着会话的终端事:用会话的 cwd 认项目', () => {
    const term = { session_id: 'sess-1', code: 'sess', source: 'claude', status: 'running', project: '/w/bx/sub', matter_id: 'cccc0001', last_summary: '在跑测试', last_event_at: NOW, pending: null }
    const { reader } = setup([m('cccc0001', { kind: 'terminal', projectPath: null })], [term])
    expect(reader.read('operator').places.map(p => [p.name, p.line, p.sessionIds])).toEqual([['sub', '在跑测试', ['sess-1']]])
  })

  it('Claude Code 临时目录里的会话:对回编码相同的已知项目;对不上的不成行', () => {
    const term = (id: string, project: string) => ({ session_id: id, code: id, source: 'claude', status: 'running', project, last_summary: '在查', last_event_at: NOW, pending: null })
    const { reader } = setup([m('gggg0001', { projectPath: '/w/1in8b' })], [
      term('s1', '/private/tmp/claude-501/-w-1in8b/sess/scratchpad/oce'),
      term('s2', '/private/tmp/claude-501/-w-unknown/sess/scratchpad'),
    ])
    const out = reader.read('operator').places
    expect(out.map(p => [p.name, p.sessionIds])).toEqual([['1in8b', ['s1']]])
  })

  it('主人挪过的顺序保持;状态变了也不重排', () => {
    const { reader } = setup([m('dddd0001'), m('dddd0002', { projectPath: '/w/melu', updatedAt: NOW })])
    reader.read('operator')
    expect(reader.move(placeKey('/w/rici'), 0)).toBe(true)
    expect(reader.read('operator').places.map(p => p.name)).toEqual(['rici', 'melu'])
  })
})

describe('地方:坐回来', () => {
  it('看过这一行以后:没再动 ⇒ 不加粗;之后动了两件 ⇒ 那一句是最近那件、另一件记作 alsoChanged', () => {
    let clock = NOW
    const rows = [
      m('hhhh0001', { state: 'done', updatedAt: NOW - 3 * DAY }),
      m('hhhh0002', { state: 'working', updatedAt: NOW - DAY }),
    ]
    const { reader } = setup(rows, [], () => clock)
    reader.read('operator')
    const key = placeKey('/w/rici')
    expect(reader.read('operator').places[0]!.alsoChanged).toBe(0)
    expect(reader.seen(key)).toBe(true)
    expect(reader.read('operator').places[0]).toMatchObject({ line: '事 hhhh0002', alsoChanged: 0, unseen: false })
    clock = NOW + DAY
    rows[0] = { ...rows[0]!, title: '收藏做好了', updatedAt: NOW + 2 * 3_600_000 }
    rows.push(m('hhhh0003', { title: '图标换好了', state: 'done', updatedAt: NOW + 3_600_000 }))
    expect(reader.read('operator').places[0]).toMatchObject({ line: '收藏做好了', alsoChanged: 1 })
    expect(reader.seen('p:0000000000000000')).toBe(false)
  })
})

describe('地方:路由', () => {
  it('看过:operator / device 都能写;link 403;body 不对 400;没有这个 key 404', async () => {
    const { reader } = setup([m('iiii0001')])
    reader.read('operator')
    const key = placeKey('/w/rici')
    expect(await call({ places: reader }, 'POST /v1/places/seen', { key })).toEqual({ status: 200, body: { ok: true } })
    expect(await call({ places: reader }, 'POST /v1/places/seen', { key }, 'device')).toEqual({ status: 200, body: { ok: true } })
    expect((await call({ places: reader }, 'POST /v1/places/seen', { key }, 'link')).status).toBe(403)
    expect((await call({ places: reader }, 'POST /v1/places/seen', { key, at: 1 })).status).toBe(400)
    expect((await call({ places: reader }, 'POST /v1/places/seen', { key: 'p:0000000000000000' })).status).toBe(404)
  })

  it('GET:operator / device 能读,link 403;If-None-Match 命中 304', async () => {
    const { reader } = setup([m('eeee0001')])
    const ok = await call({ places: reader }, 'GET /v1/places', null)
    expect(ok.status).toBe(200)
    expect((await call({ places: reader }, 'GET /v1/places', null, 'device')).status).toBe(200)
    expect(await call({ places: reader }, 'GET /v1/places', null, 'link')).toEqual({ status: 403, body: { error: 'forbidden' } })
    const v = (ok.body as { version: string }).version
    expect((await call({ places: reader }, 'GET /v1/places', null, 'operator', new Headers({ 'If-None-Match': v }))).status).toBe(304)
  })

  it('没接上 / 读出错 ⇒ 503,不漏错误内容', async () => {
    expect(await call({}, 'GET /v1/places', null)).toEqual({ status: 503, body: { error: 'unavailable' } })
    expect(await call({ places: { read: () => { throw Error('secret') }, move: () => true, hide: () => true, seen: () => true } }, 'GET /v1/places', null)).toEqual({ status: 503, body: { error: 'unavailable' } })
  })

  it('挪 / 收起:只给 operator;body 不对 400;没有这个 key 404', async () => {
    const { reader } = setup([m('ffff0001')])
    reader.read('operator')
    const key = placeKey('/w/rici')
    expect(await call({ places: reader }, 'POST /v1/places/move', { key, to: 0 })).toEqual({ status: 200, body: { ok: true } })
    expect(await call({ places: reader }, 'POST /v1/places/hide', { key, hidden: true })).toEqual({ status: 200, body: { ok: true } })
    expect(reader.read('operator').places).toEqual([])
    expect((await call({ places: reader }, 'POST /v1/places/move', { key, to: 0 }, 'device')).status).toBe(403)
    expect((await call({ places: reader }, 'POST /v1/places/move', { key, to: -1 })).status).toBe(400)
    expect((await call({ places: reader }, 'POST /v1/places/hide', { key, hidden: true, extra: 1 })).status).toBe(400)
    expect((await call({ places: reader }, 'POST /v1/places/hide', { key: 'p:0000000000000000', hidden: true })).status).toBe(404)
  })
})
