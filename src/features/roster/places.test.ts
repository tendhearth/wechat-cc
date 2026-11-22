import { describe, expect, it, vi } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeFirstTerminalMessageReader } from '../../adapters/store/terminal-steps'
import { makePlacesStore } from '../../adapters/store/places-store'
import type { CliSessionView } from '../../ports/cli-session'
import type { Matter } from '../../ports/matters'
import type { InternalApiDeps } from '../../daemon/internal-api/types'
import { makePlacesReader, placeKey, PLACES_WINDOW_MS } from './places-reader'
import { placesRoutes } from './places-routes'
import { makeRosterReader } from './reader'
import { rosterRoutes } from './routes'
import { ASK_OPINION_DELAY_MS, makeAskOpinion } from '../workbench/ask-opinion'
import { PlacesResponse } from '@wechat-cc/protocol'

const DAY = 24 * 3_600_000
const NOW = 100 * DAY
const m = (id: string, extra: Partial<Matter> = {}): Matter => ({ id, kind: 'task', title: `事 ${id}`, state: 'working', archivedAt: null, projectPath: '/w/rici', ownerChatId: null, originMatterId: null, originMessageId: `msg-${id}`, createdAt: 1, updatedAt: NOW - 60_000, ...extra })

function setup(rows: Matter[], terminals: any[] = [], now: () => number = () => NOW, extra: Partial<Parameters<typeof makePlacesReader>[0]> = {}) {
  const db = openTestDb()
  const store = makePlacesStore(db)
  const list = (f: { kind?: string; state?: string; since?: number } = {}) =>
    rows.filter(r => (!f.kind || r.kind === f.kind) && (!f.state || r.state === f.state) && (f.since === undefined || r.updatedAt >= f.since))
  const reader = makePlacesReader({
    roster: { matters: { list, get: id => rows.find(r => r.id === id) ?? null }, terminals: () => terminals, seen: () => null, now },
    store,
    ...extra,
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
    expect(await call({ places: { ...setup([]).reader, read: () => { throw Error('secret') } } }, 'GET /v1/places', null)).toEqual({ status: 503, body: { error: 'unavailable' } })
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

it.each(['slow', 'error'] as const)('GET places 不等待意见模型 (%s)', async mode => {
  vi.useFakeTimers()
  try {
    const id = 'aaaa0001'
    const rows = [m(id)]
    let permissions = [{ id: 'req-1', tool: 'Bash', description: '查看变更', createdAt: NOW }]
    let complete!: (raw: string) => void
    let fail!: (error: Error) => void
    const model = vi.fn(() => new Promise<string>((resolve, reject) => { complete = resolve; fail = reject }))
    const opinion = makeAskOpinion({ evaluator: () => model })
    const { reader } = setup(rows, [], () => NOW, {
      opinion: opinion.get,
      roster: {
        matters: { list: () => rows }, terminals: () => [], seen: () => null, now: () => NOW,
        workbench: {
          list: () => ({ tasks: [{ id, status: 'running' }] }),
          attention: () => ({ tasks: permissions.length ? [{ id }] : [] }),
          detail: () => ({ permissions, questions: [] }),
        },
      },
    })
    opinion.schedule('req-1', () => ({ kind: 'permission', project: '/w/rici', title: '整理菜谱', preview: { command: 'git status' } }))
    await vi.advanceTimersByTimeAsync(ASK_OPINION_DELAY_MS)
    expect(model).toHaveBeenCalledTimes(1)
    const read = () => call({ places: reader }, 'GET /v1/places', null)
    const first = await read()
    const { places, version } = PlacesResponse.parse(first.body)
    expect(first.status).toBe(200)
    expect(places[0]?.waiting).toMatchObject({ requestId: 'req-1', summary: 'Bash: 查看变更' })
    expect(places[0]?.waiting).not.toHaveProperty('ccOpinion')
    expect(places[0]?.waiting).not.toHaveProperty('questionReason')
    if (mode === 'error') {
      fail(new Error('synthetic failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect((await read()).body).toEqual(first.body)
      return
    }
    complete(JSON.stringify({ say: true, opinion: '允许。只查看本地改动。', reason: '执行者需要读取权限' }))
    await vi.advanceTimersByTimeAsync(0)
    const after = PlacesResponse.parse((await call({ places: reader }, 'GET /v1/places', null, 'operator', new Headers({ 'If-None-Match': version }))).body)
    expect(after.version).not.toBe(version)
    expect(after.places[0]?.waiting).toMatchObject({ ccOpinion: '允许。只查看本地改动。', questionReason: '执行者需要读取权限' })
    permissions = []
    opinion.clear('req-1')
    expect(PlacesResponse.parse((await read()).body).places[0]?.waiting).toBeNull()
    expect(opinion.get('req-1')).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

it('交办使用「现在」的可见性，收起的地方有事等主人时仍能选', () => {
  const terminal = { session_id: 'waiting-session', code: 'waiting', source: 'claude', status: 'waiting', project: '/w/rici', last_event_at: NOW, pending: { since: NOW } }
  const { reader, store } = setup([m('bbbbbbbb', { projectPath: '/w/melu' })], [terminal])
  reader.read('operator')
  expect(reader.hide(placeKey('/w/rici'), true)).toBe(true)
  expect(reader.hide(placeKey('/w/melu'), true)).toBe(true)
  const visible = reader.read('operator').places
  expect(visible.map(place => place.name)).toEqual(['rici'])
  expect(reader.planPlaces()).toMatchObject([{ key: visible[0]!.key, root: '/w/rici', name: 'rici' }])
  terminal.status = 'running'
  expect(reader.read('operator').places).toEqual([])
  expect(reader.planPlaces()).toEqual([])
  expect(store.list()).toHaveLength(2)
})

it('只有收起的清单变化时也更新版本和 ETag', async () => {
  const { reader, store } = setup([m('aaaa0001')])
  const first = reader.read('operator')
  const key = placeKey('/w/hidden')
  store.add([{ key, root: '/w/hidden', name: '收起的地方', hidden: true, position: 1 }], NOW)
  const second = reader.read('operator')
  expect(second.places).toEqual(first.places)
  expect(second.hidden).toEqual([{ key, name: '收起的地方' }])
  expect(second.version).not.toBe(first.version)
  const response = await call({ places: reader }, 'GET /v1/places', null, 'operator', new Headers({ 'if-none-match': first.version }))
  expect(response).toMatchObject({ status: 200, body: second, headers: { etag: second.version } })
})

it('地方只返回 operator 行标题所对应会话的小结；关掉后字节与旧接口一致', async () => {
  const term = (id: string, matter: string, at: number) => ({
    session_id: id, code: id, source: 'codex', status: 'idle', project: '/w/rici',
    matter_id: matter, last_summary: '样例', last_event_at: at, pending: null,
  })
  const terminals = [term('head', 'm-head', NOW - 1), term('older', 'm-older', NOW - 2)]
  const matters = [m('m-head', { kind: 'terminal', updatedAt: NOW - 1 }), m('m-older', { kind: 'terminal', updatedAt: NOW - 2 })]
  let enabled = true
  const recap = { source: 'cc' as const, text: '画册已排完，下一步选封面。', at: NOW, awayFrom: NOW - 30 * 60_000 }
  const read = vi.fn(() => recap)
  const { reader } = setup(matters, terminals, () => NOW, {
    recaps: { enabled: () => enabled, setEnabled: value => { enabled = value }, read, check: async () => {}, stop() {} },
  })
  const baseline = setup(matters, terminals).reader
  const get = (reader: ReturnType<typeof makePlacesReader>, origin: 'operator' | 'device') => call({ places: reader }, 'GET /v1/places', null, origin)
  const before = await get(baseline, 'operator')
  const view = await get(reader, 'operator')
  expect(view.body).toMatchObject({ places: [{ recap }] })
  expect(view.headers).not.toEqual(before.headers)
  expect(read.mock.calls).toEqual([['head']])
  read.mockClear().mockImplementation(() => { throw Error('disabled_read') })
  expect(JSON.stringify(await get(reader, 'device'))).toBe(JSON.stringify(await get(baseline, 'device')))
  enabled = false
  expect(JSON.stringify(await get(reader, 'operator'))).toBe(JSON.stringify(before))
  expect(read).not.toHaveBeenCalled()
})

it('只有 operator 地方展示七天内的已结束会话，手机地方与默认名单保持原样', async () => {
  const term = (id: string, status: CliSessionView['status'], age: number, project = '/w/rici'): CliSessionView => ({
    session_id: id, code: id, source: 'codex', status, project, last_summary: '沙盒回话',
    last_event_at: NOW - age, pending: null, stale: id === 'paused', cwd: project, machine: null,
    origin_agent: null, created_at: NOW - age, last_prompt_at: null,
  })
  const live = [term('paused', 'idle', 3 * DAY), term('working', 'running', DAY), term('waiting', 'waiting', DAY),
    term('other-live', 'idle', DAY / 2, '/w/live')]
  const ended = [term('ended', 'ended', DAY), term('newest-history', 'ended', 0), term('expired', 'ended', 8 * DAY), term('other', 'ended', DAY, '/w/other')]
  const rosterDeps = { matters: { list: () => [] }, terminals: (opts?: { includeEnded?: boolean }) => opts?.includeEnded ? [...live, ...ended] : live, seen: () => null, now: () => NOW }
  const { reader } = setup([], [], () => NOW, { roster: rosterDeps })
  const legacy = setup([], live)
  const device = await call({ places: legacy.reader }, 'GET /v1/places', null, 'device')
  expect((await call({ places: reader }, 'POST /v1/places/seen', { key: placeKey('/w/live') })).status).toBe(404)
  const operator = await call({ places: reader }, 'GET /v1/places', null)
  const places = PlacesResponse.parse(operator.body)
  expect(places.places.find(p => p.name === 'rici')?.sessions?.map(s => s.sessionId)).toEqual(['waiting', 'working', 'paused', 'newest-history', 'ended'])
  const historical = places.places.find(p => p.name === 'other')
  expect(historical?.status).toBe('done')
  expect(historical?.line === '沙盒回话').toBe(true)
  expect(historical?.sessions).toEqual([{ sessionId: 'other', agent: 'codex', status: 'done', updatedAt: NOW - DAY, endedAt: NOW - DAY }])
  expect(JSON.stringify((await call({ places: reader }, 'GET /v1/places', null, 'device')).body)).toBe(JSON.stringify(device.body))
  const api = rosterRoutes({ roster: makeRosterReader(rosterDeps) })['GET /v1/roster']!
  const baseline = rosterRoutes({ roster: makeRosterReader({ ...rosterDeps, terminals: () => live }) })['GET /v1/roster']!
  for (const origin of ['device', 'operator'] as const) {
    const request = [new URLSearchParams(), null, { tier: 'admin', origin }] as const
    const result = await api(...request)
    expect(JSON.stringify(result)).toBe(JSON.stringify(await baseline(...request)))
    expect((result.body as {items: {id:string}[]}).items.map(item => item.id)).toEqual(['waiting', 'working', 'other-live'])
  }
})

it('历史地方可以往下挪过另一条历史记录，手机只看到明确保存过的地方', async () => {
  const ended = ['/w/first', '/w/second'].map((project, i): CliSessionView => ({
    session_id: 'ended-' + i, code: 'ended-' + i, source: 'codex', status: 'ended', project, cwd: project,
    pending: null, last_event_at: NOW - i, stale: false, machine: null, origin_agent: null, last_summary: null,
    created_at: NOW - i, last_prompt_at: null,
  }))
  const roster = { matters: { list: () => [] }, terminals: (opts?: { includeEnded?: boolean }) => opts?.includeEnded ? ended : [],
    seen: () => null, now: () => NOW }
  const { reader, store } = setup([], [], () => NOW, { roster })
  const first = placeKey('/w/first'), second = placeKey('/w/second')
  const desktop = () => reader.read('operator').places.map(place => place.key)
  const phone = async () => JSON.stringify((await call({ places: reader }, 'GET /v1/places', null, 'device')).body)
  const before = await phone()
  expect(desktop()).toEqual([first, second])
  expect(store.list()).toEqual([])
  expect(await call({ places: reader }, 'POST /v1/places/seen', { key: first })).toEqual({ status: 200, body: { ok: true } })
  expect((await call({ places: reader }, 'POST /v1/places/seen', { key: first }, 'device')).status).toBe(404)
  expect(store.list()).toEqual([])
  expect(await phone()).toBe(before)

  expect(reader.move(first, 1)).toBe(true)
  expect(desktop()).toEqual([second, first])
  expect(store.list().map(place => place.key)).toEqual([first])
  const phoneWithSavedPlace = await phone()
  expect(phoneWithSavedPlace.includes(first)).toBe(true)
  expect(phoneWithSavedPlace.includes(second)).toBe(false)

  expect(reader.move(first, 0)).toBe(true)
  expect(desktop()).toEqual([first, second])
  expect(await phone()).toBe(phoneWithSavedPlace)
})

it('页签只取三十天内的活会话，封顶三十次；等你定的在最前，其余按开始的先后、新的在前', () => {
  const session = (id: string, status: CliSessionView['status'], days: number): CliSessionView => ({
    session_id: id, code: id, source: 'codex', status, project: '/w/rici', cwd: '/w/rici', stale: false,
    machine: null, origin_agent: null, last_summary: null, last_prompt_at: null, pending: null,
    last_event_at: NOW - days * DAY, created_at: NOW - days * DAY,
  })
  const paused = Array.from({ length: 29 }, (_, i) => session('paused-' + i, 'idle', i))
  const { reader } = setup([], [session('too-old', 'running', 31), session('working', 'running', 25),
    session('ended', 'ended', 0), ...paused.reverse(), session('waiting', 'waiting', 29)])
  const { sessions } = reader.read('operator').places[0]!
  expect(sessions).toHaveLength(30)
  // Kept: the waiting one, the working one, and the 28 most recently active of the rest (the ended one gives way).
  // Shown: waiting first; then by when each session began, newest first. The working one keeps its place (day 25).
  const name = (i: number) => 'paused-' + i
  expect(sessions?.map(row => row.sessionId)).toEqual(['waiting', ...Array.from({ length: 26 }, (_, i) => name(i)), 'working', name(26), name(27)])
})

it('页签标题取第一句，压成一行并按字符截断，只为桌面查且命中后不重查', async () => {
  const db = openTestDb()
  try {
    const matters = makeMatterStore(db, () => NOW)
    const log = makeMatterLog(db)
    const create = () => matters.create({ kind: 'terminal', title: '终端', projectPath: '/w/rici' })
    const first = create(), empty = create()
    const add = (matterId: string, kind: 'agent_message' | 'user_message', payload: Record<string, unknown>) =>
      log.writeItem({ matterId, kind, status: 'completed', payload })
    add(first.id, 'agent_message', { text: '先说的 agent' })
    add(first.id, 'user_message', {})
    add(first.id, 'user_message', { text: '短摘要', full: '  第一行\n\t第二行   ' + '🐈'.repeat(55) + '末尾' })
    add(first.id, 'user_message', { text: '主人的第二句' })
    const query = vi.fn(makeFirstTerminalMessageReader(db))
    const terminals = [first, empty].map(({ id }): CliSessionView => ({
      session_id: id, code: id, matter_id: id, source: 'codex', status: 'idle', project: '/w/rici',
      cwd: '/w/rici', stale: false, machine: null, origin_agent: null, pending: null,
      last_summary: null, last_event_at: NOW, created_at: NOW, last_prompt_at: NOW,
    }))
    const { reader } = setup([], [], () => NOW, {
      roster: { matters, terminals: () => terminals, seen: () => null, now: () => NOW },
      firstTerminalMessage: query,
    })
    const read = async (origin: 'operator' | 'device') =>
      PlacesResponse.parse((await call({ places: reader }, 'GET /v1/places', null, origin)).body)
    expect((await read('device')).places[0]).not.toHaveProperty('sessions')
    expect(query).not.toHaveBeenCalled()
    const initial = await read('operator')
    const initialSessions = initial.places[0]?.sessions
    expect(initialSessions?.find(s => s.matterId === first.id)?.title === '第一行 第二行 ' + '🐈'.repeat(52)).toBe(true)
    expect(initialSessions?.find(s => s.matterId === empty.id)).not.toHaveProperty('title')
    expect(query).toHaveBeenCalledTimes(2)
    add(empty.id, 'user_message', { text: '现在有了' })
    const updated = await read('operator')
    expect(updated.places[0]?.sessions?.find(s => s.matterId === empty.id)?.title === '现在有了').toBe(true)
    expect(updated.version).not.toBe(initial.version)
    expect((await read('operator')).version).toBe(updated.version)
    expect((await read('device')).places[0]).not.toHaveProperty('sessions')
    expect(query.mock.calls.map(([id]) => id).filter(id => id === first.id)).toHaveLength(1)
    expect(query).toHaveBeenCalledTimes(3)
  } finally { db.close() }
})
