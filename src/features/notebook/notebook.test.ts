import { NotebookChatReadResponse } from "@wechat-cc/protocol"
import { createProviderRegistry } from "../../app/provider-registry"

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeNotebookStore } from '../../adapters/store/notebook-store'
import { DEFAULT_OPENING } from '../../domain/notebook'
import { NOTEBOOK_DEFAULTS, type NotebookConfig } from '../../lib/notebook-config'
import { makeNotebook, notebookRoutes } from './index'
import type { RouteHandler } from '../../daemon/internal-api/types'

const BASE = Date.parse('2026-11-19T20:00:00Z')
const dbs: ReturnType<typeof openTestDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.useRealTimers() })

function fixture(model: (() => ((prompt: string) => Promise<string>) | null) | null = null, notebook: Partial<NotebookConfig> = {}) {
  const db = openTestDb()
  dbs.push(db)
  const store = makeNotebookStore(db)
  let time = BASE
  const logs: string[] = []
  const n = makeNotebook({
    store, settings: () => ({ timezone: 'America/Los_Angeles', notebook }),
    model: () => model?.() ?? null, now: () => time,
    isOwner: caller => caller.chatId === 'owner',
    log: (count, length) => logs.push(`count=${count} length=${length}`),
  })
  const routes = notebookRoutes(n)
  const call = (key: string, body?: unknown, origin: NonNullable<Parameters<RouteHandler>[2]>['origin'] = 'operator', query = '', tier: 'admin' | 'guest' = 'admin', chatId?: string) =>
    routes[key]!(new URLSearchParams(query), body, { tier, origin, chatId })
  return { n, store, db, call, logs, at: (t: number) => { time = t } }
}

describe('notebook pages', () => {
  it('cuts days at owner midnight, orders same-day entries, returns the latest occupied day', () => {
    const { n, at } = fixture()
    at(Date.parse('2026-11-19T07:59:59Z'))
    const first = n.write('before', '1', 'desktop')
    at(Date.parse('2026-11-19T08:00:00Z'))
    const second = n.write('after', '2', 'app')
    const third = n.write('also after', '3', 'desktop')
    at(BASE + 86_400_000)
    expect(n.page()).toMatchObject({ day: '2026-11-19', days: ['2026-11-19', '2026-11-18'], entries: [second, third] })
    expect(n.page('2026-11-18').entries).toEqual([first])
    expect(n.page('2026-11-20').entries).toEqual([])
  })

  it('reports today at owner midnight, independently of the selected page and machine timezone', async () => {
    const { at, call } = fixture()
    at(Date.parse('2026-11-19T07:59:59Z'))
    await call('POST /v1/notebook/write', { body: 'before', clientId: 'before' })
    expect((await call('GET /v1/notebook')).body).toMatchObject({ today: '2026-11-18' })
    at(Date.parse('2026-11-19T08:00:00Z'))
    expect((await call('GET /v1/notebook')).body).toMatchObject({ day: '2026-11-18', today: '2026-11-19' })
  })

  it('returns the original entry day on a write retry after owner midnight', async () => {
    const { at, call } = fixture()
    const write = { body: 'before', clientId: 'retry' }
    at(Date.parse('2026-11-19T07:59:59Z'))
    const result = await call('POST /v1/notebook/write', write)
    expect(result.body).toMatchObject({ entry: { day: '2026-11-18' } })
    at(Date.parse('2026-11-19T08:00:00Z'))
    expect(await call('POST /v1/notebook/write', write)).toEqual(result)
    expect((await call('GET /v1/notebook')).body).toMatchObject({ entries: [{ day: '2026-11-18' }] })
  })

  it('returns cross-day reference dates on pages and chat reads, then recomputes them after a timezone change', async () => {
    const { store } = fixture()
    const before = Date.parse('2026-11-19T07:59:59Z')
    const after = before + 1000
    let timezone = 'America/Los_Angeles'
    const n = makeNotebook({ store, settings: () => ({ timezone }), model: () => null, now: () => after, isOwner: () => true })
    const ref = store.append({ author: 'owner', body: 'before', createdAt: before, refId: null, origin: 'desktop', clientId: null })
    const reply = store.append({ author: 'cc', body: 'after', createdAt: after, refId: ref.id, origin: 'desktop', clientId: null })
    const entry = { id: reply.id, refId: ref.id, day: '2026-11-19', refDay: '2026-11-18' }
    expect(n.page()).toMatchObject({ entries: [entry] })
    const chatRead = notebookRoutes(n)['POST /v1/notebook/chat/read']!
    const result = await chatRead(new URLSearchParams(), { days: 1 }, { tier: 'admin', origin: 'session' })
    expect(NotebookChatReadResponse.parse(result.body)).toMatchObject({ entries: [entry] })
    timezone = 'Pacific/Honolulu'
    expect(n.page()).toMatchObject({
      today: '2026-11-18', day: '2026-11-18', days: ['2026-11-18'],
      entries: [{ id: ref.id, day: '2026-11-18' }, { ...entry, day: '2026-11-18' }],
    })
    timezone = 'UTC'
    expect(n.page()).toMatchObject({
      today: '2026-11-19', entries: [{ id: ref.id, day: '2026-11-19' }, { ...entry, refDay: '2026-11-19' }],
    })
  })

  it('fetches only distinct reference IDs on the selected page in one batch', () => {
    const { n, store } = fixture()
    const target = n.write('target', 'target', 'desktop')
    const other = n.write('other', 'other', 'desktop')
    for (const [refId, createdAt] of [[target.id, BASE + 86_400_000], [target.id, BASE + 86_400_001], [other.id, BASE + 2 * 86_400_000]] as const) {
      store.append({ author: 'cc', body: 'reply', createdAt, refId, origin: 'desktop', clientId: null })
    }
    const lookup = vi.spyOn(store, 'referenceTimestamps')
    expect(n.page('2026-11-20').entries).toHaveLength(2)
    expect(lookup.mock.calls).toEqual([[[target.id]]])
  })

  it('keeps refId and omits refDay for a missing target', () => {
    const { db, n, store } = fixture()
    const refId = '00000000-0000-4000-8000-000000000001'
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      store.append({ author: 'cc', body: 'orphan', createdAt: BASE, refId, origin: 'desktop', clientId: null })
    } finally { db.exec('PRAGMA foreign_keys = ON') }
    for (const result of [n.page(), n.read(1)]) {
      expect(result.entries).toMatchObject([{ refId, day: '2026-11-19' }])
      expect(result.entries[0]).not.toHaveProperty('refDay')
    }
  })

  it('reuses occupied days across reads and writes and rebuilds them when the timezone changes', () => {
    const { store } = fixture()
    const midnight = Date.parse('2026-11-19T00:00:00Z')
    let time = midnight
    let timezone = 'UTC'
    const n = makeNotebook({ store, settings: () => ({ timezone }), model: () => null, now: () => time })
    for (let i = 0; i < 3000; i++) {
      time = midnight + i * 1000
      n.write('history', String(i), 'desktop')
    }
    time = midnight + 3 * 86_400_000
    const first = n.write('selected', 'selected', 'desktop')
    expect(n.page().days).toEqual(['2026-11-22', '2026-11-19'])

    const format = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    try {
      time = midnight + 6 * 86_400_000
      expect(n.write('retry', 'selected', 'app')).toEqual(first)
      time += 12 * 60 * 60 * 1000
      n.jot('new day')
      expect(n.page('2026-11-22')).toMatchObject({
        days: ['2026-11-25', '2026-11-22', '2026-11-19'], entries: [first],
      })
      expect(n.page('2026-11-22').entries).toEqual([first])
      expect(format.mock.calls.length).toBeLessThanOrEqual(8)

      timezone = 'America/Los_Angeles'
      expect(n.page('2026-11-21')).toMatchObject({
        days: ['2026-11-25', '2026-11-21', '2026-11-18'], entries: [{ ...first, day: '2026-11-21' }],
      })
      format.mockClear()
      expect(n.page('2026-11-21').entries).toEqual([{ ...first, day: '2026-11-21' }])
      expect(format.mock.calls.length).toBeLessThanOrEqual(2)
    } finally { format.mockRestore() }
  })

  it('authorizes all four routes, counts Unicode code points, retries writes and strikes only owner lines', async () => {
    const { call, n, logs } = fixture()
    const keys = ['GET /v1/notebook', 'POST /v1/notebook/write', 'POST /v1/notebook/strike', 'POST /v1/notebook/paper']
    for (const key of keys) {
      expect((await call(key, {}, 'link')).status).toBe(403)
      expect((await call(key, {}, 'session')).status).toBe(403)
      expect((await call(key, {}, 'device', '', 'guest')).status).toBe(403)
    }
    const body = 'unique-notebook-log-probe-' + '𠮷'.repeat(3974)
    const written = await call(keys[1]!, { body, clientId: 'retry' }, 'device')
    expect(written.status).toBe(200)
    expect(await call(keys[1]!, { body: 'retry', clientId: 'retry' })).toEqual(written)
    expect((await call(keys[1]!, { body: body + '字', clientId: 'too-long' })).status).toBe(400)
    expect((await call(keys[0]!, null, 'device', 'day=2026-02-30')).status).toBe(400)
    expect((await call(keys[0]!, null, 'device')).status).toBe(200)
    const owner = n.page().entries[0]!
    expect(owner.origin).toBe('app')
    expect((await call(keys[2]!, { id: owner.id, struck: true }, 'device')).status).toBe(200)
    expect(n.page().entries[0]?.struckAt).toBe(BASE)
    expect((await call(keys[2]!, { id: owner.id, struck: false })).status).toBe(200)
    expect(n.page().entries[0]?.struckAt).toBeNull()
    expect((await call(keys[2]!, { id: n.jot('点子').id, struck: true })).status).toBe(403)
    expect((await call(keys[3]!, { paper: 'plain' }, 'device')).status).toBe(200)
    expect(n.page().paper).toBe('plain')
    expect(logs.join('\n')).toContain('length=4000')
    expect(logs.join('\n')).not.toContain('unique-notebook-log-probe')
  })
})

describe('notebook pen', () => {
  const selected = { font: 'fangsong', ink: 'ochre', reason: '仿宋和赭石像我平时写信的字。', lines: ['这是我们写字的地方。', '仿宋和赭石像我平时写信的字。'] }
  it('opens without waiting, initializes once, and lets writes finish before the model', async () => {
    let finish!: (raw: string) => void
    const model = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const { n, at, call } = fixture(() => model)
    expect(n.page().day).toBe('2026-11-19')
    const page = await call('GET /v1/notebook')
    expect(page.body).toMatchObject({ penPending: true, entries: [] })
    const pending = n.open('app')!
    await Promise.resolve()
    at(BASE)
    expect((await call('POST /v1/notebook/write', { body: '先写', clientId: 'first' })).status).toBe(200)
    expect(n.page().entries.map(e => e.body)).toEqual(['先写'])
    finish(JSON.stringify(selected))
    await pending
    expect(n.open('desktop')).toBeUndefined()
    expect(n.page()).toMatchObject({ pen: { font: 'fangsong', ink: 'ochre', reason: selected.reason }, penPending: false })
    expect(n.page().entries.map(e => e.body)).toEqual([...selected.lines, '先写'])
    expect(model).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'bad', 'timeout'])('falls back when model is %s', async kind => {
    vi.useFakeTimers()
    const { n, call } = fixture(kind === 'missing' ? null : () => kind === 'bad'
      ? async () => '{"font":"unknown"}' : () => new Promise<string>(() => {}), { openingTimeoutMs: 5 })
    const opening = n.open('desktop')
    await vi.advanceTimersByTimeAsync(5)
    await opening
    expect(n.page().entries.map(e => e.body)).toEqual(DEFAULT_OPENING.lines)
    expect((await call('POST /v1/notebook/write', { body: '继续写', clientId: 'later' })).status).toBe(200)
  })

  async function openPage(f: ReturnType<typeof fixture>, query: string) {
    expect((await f.call('GET /v1/notebook', undefined, 'operator', query)).status).toBe(200)
    await f.n.open('desktop')
  }

  it('falls back to italic Song when the model returns an unavailable font', async () => {
    const model = vi.fn(async () => JSON.stringify({
      ...selected, font: 'kai', reason: '我挑了楷体和赭石。', lines: ['这是我们的本子。', '我挑了楷体和赭石。'],
    }))
    const f = fixture(() => model)
    await openPage(f, 'fonts=songItalic')
    expect(f.store.get('pen')).toEqual({ font: 'songItalic', ink: 'blueBlack', reason: '我挑了宋体斜和蓝黑墨水，字清楚，墨色也安静。' })
    expect(f.n.page().entries.map(e => e.body)).toEqual([
      '这是我们两个人的本子。', '我挑了宋体斜和蓝黑墨水，字清楚，墨色也安静。', '你想写什么都行，不用等我回。',
    ])
  })

  it('offers the reported fonts and italic Song, and stores a valid choice', async () => {
    const reason = '我挑了行楷和赭石。'
    const model = vi.fn(async (_prompt: string) => JSON.stringify({ ...selected, font: 'xingkai', reason, lines: [selected.lines[0], reason] }))
    const f = fixture(() => model)
    await openPage(f, 'fonts=kai,xingkai')
    expect(model.mock.calls[0]?.[0]).toContain('字体键：{"kai":"楷体","xingkai":"行楷","songItalic":"宋体斜"}')
    expect(f.store.get('pen')).toEqual({ font: 'xingkai', ink: 'ochre', reason })
    expect(f.n.page().entries.map(e => e.body)).toEqual([selected.lines[0], reason])
  })

  it.each([
    ['fonts=unknown,toString', 'songItalic'],
    ['fonts=', 'songItalic'],
    ['fonts=songItalic,' + 'x'.repeat(189), 'songItalic'],
    ['fonts=songItalic,' + 'x'.repeat(190), 'kai'],
    ['', 'kai'],
  ])('chooses the fallback for %s', async (query, font) => {
    const f = fixture()
    await openPage(f, query)
    expect(f.store.get('pen')).toMatchObject({ font, ink: 'blueBlack' })
  })

  it('uses the available fallback even when the notebook already has entries but no pen', async () => {
    const f = fixture()
    f.n.jot('已经有字')
    await openPage(f, 'fonts=songItalic')
    expect(f.store.get('pen')).toMatchObject({ font: 'songItalic', ink: 'blueBlack' })
    expect(f.n.page().entries.map(e => e.body)).toEqual(['你说：已经有字'])
  })

  it('ignores later fonts after a pen has been stored', async () => {
    const model = vi.fn(async () => JSON.stringify(selected))
    const f = fixture(() => model)
    await openPage(f, '')
    const page = f.n.page()
    expect(page.pen).toEqual({ font: 'fangsong', ink: 'ochre', reason: selected.reason })
    await openPage(f, 'fonts=songItalic')
    expect(f.n.page()).toEqual(page)
    expect(model).toHaveBeenCalledTimes(1)
  })

  it.each(['楷体', '行楷', '宋体斜'])('replaces only the opening sentence that names %s instead of 仿宋', async wrongFont => {
    const lines = [selected.lines[0], selected.reason, `我会用${wrongFont}写。`]
    const f = fixture(() => async () => JSON.stringify({ ...selected, lines }))
    await openPage(f, '')
    expect(f.n.page().entries.map(e => e.body)).toEqual([lines[0], lines[1], '你想写什么都行，不用等我回。'])
    expect(f.store.get('pen')).toEqual({ font: 'fangsong', ink: 'ochre', reason: selected.reason })
  })

  it('replaces a reason sentence that names both the selected font and another font', async () => {
    const reason = '我挑了仿宋和赭石，纸上写的是楷体。'
    const f = fixture(() => async () => JSON.stringify({ ...selected, reason, lines: [selected.lines[0], reason] }))
    await openPage(f, '')
    const replacement = '我挑了仿宋和赭石墨水，字清楚，墨色也安静。'
    expect(f.n.page().entries.map(e => e.body)).toEqual([selected.lines[0], replacement])
    expect(f.store.get('pen')).toEqual({ font: 'fangsong', ink: 'ochre', reason: replacement })
  })

  it('sets the default pen without an opening when entries already exist', () => {
    const model = vi.fn(async () => JSON.stringify(selected))
    const { n } = fixture(() => model)
    n.jot('已经有字')
    expect(n.open('app')).toBeUndefined()
    expect(n.page().entries.map(e => e.body)).toEqual(['你说：已经有字'])
    expect(n.page().pen.font).toBe('kai')
    expect(model).not.toHaveBeenCalled()
  })
})

describe('quiet notebook comments', () => {
  const HOUR = 3_600_000
  const fresh = (f: ReturnType<typeof fixture>) => f.n.write('想种一排向日葵。', String(f.n.page().entries.length), 'desktop')

  it('gates recent writing, missing model, cooldown and the local daily question budget', async () => {
    let available = false
    let id = ''
    const model = vi.fn(async () => JSON.stringify({ refId: id, body: '我想到窗台上那块下午的光。' }))
    const f = fixture(() => available ? model : null, { checkIntervalMs: 1 })
    f.at(BASE - 8 * HOUR)
    id = fresh(f).id
    await f.n.tick()
    expect(model).toHaveBeenCalledTimes(0)
    f.at(BASE - 7 * HOUR)
    await f.n.tick()
    expect(f.store.get('initiative')).toBeNull()
    available = true
    f.at(BASE - 6 * HOUR)
    await f.n.tick()
    expect(f.n.page().entries.at(-1)).toMatchObject({ author: 'cc', refId: id })
    f.at(BASE - 5 * HOUR)
    id = fresh(f).id
    f.at(BASE - HOUR)
    await f.n.tick()
    expect(model).toHaveBeenCalledTimes(1)
    f.at(BASE)
    await f.n.tick()
    expect(model).toHaveBeenCalledTimes(2)
    f.at(BASE + 1)
    fresh(f)
    f.at(BASE + 6 * HOUR)
    await f.n.tick()
    expect(model).toHaveBeenCalledTimes(2)
  })

  it.each(['null', 'long', 'bad-id', 'empty', 'praise', 'rush', 'question', 'echo', 'multiple'])('drops %s and backs off on bad output', async kind => {
    const model = vi.fn(async () => kind === 'null' ? 'null' : JSON.stringify({
      refId: kind === 'bad-id' ? 'other' : id,
      body: { long: '光'.repeat(81), empty: ' ', praise: '真棒啊。', rush: '赶紧写下去。', question: '要不要我来写？', echo: '想种一排向日葵。', multiple: '风来了。云也来了。' }[kind] ?? '光。',
    }))
    const f = fixture(() => model, { checkIntervalMs: 1, dailyLimit: 5 })
    f.at(BASE - HOUR)
    const id = fresh(f).id
    f.at(BASE)
    await f.n.tick()
    expect(f.n.page().entries).toHaveLength(1)
    if (kind === 'null') {
      expect(f.store.get('initiative')?.failures).toBe(0)
      return
    }
    expect(f.store.get('initiative')?.retryAt).toBe(BASE + NOTEBOOK_DEFAULTS.failureBaseMs)
    f.at(BASE + HOUR - 1)
    await f.n.tick()
    expect(model).toHaveBeenCalledTimes(1)
    f.at(BASE + HOUR)
    await f.n.tick()
    expect(f.store.get('initiative')?.retryAt).toBe(BASE + 3 * HOUR)
  })

  it('rechecks quiet time and strike state after the model returns', async () => {
    let finish!: (raw: string) => void
    const f = fixture(() => () => new Promise<string>(resolve => { finish = resolve }))
    f.at(BASE - HOUR)
    const id = fresh(f).id
    f.at(BASE)
    const tick = f.n.tick()
    f.n.strike(id, true)
    fresh(f)
    finish(JSON.stringify({ refId: id, body: '下午的光停在窗边。' }))
    await tick
    expect(f.n.page().entries.every(row => row.author === 'owner')).toBe(true)
  })
})

it('restricts chat tools to the owner and caps literal search by local calendar days', async () => {
  const { n, at, call } = fixture()
  const jot = 'POST /v1/notebook/chat/jot'
  const read = 'POST /v1/notebook/chat/read'
  at(BASE - 60 * 86_400_000)
  n.jot('上一页%')
  at(BASE - 59 * 86_400_000)
  n.jot('边界%')
  at(BASE)
  for (const [tier, chatId] of [['guest', 'owner'], ['admin', 'other']] as const) {
    for (const key of [jot, read]) {
      expect((await call(key, {}, 'session', '', tier, chatId)).status).toBe(403)
    }
  }
  expect((await call(jot, { text: '今天的点子' }, 'session', '', 'admin', 'owner')).status).toBe(200)
  expect(n.page().entries).toMatchObject([{ author: 'cc', body: '你说：今天的点子', origin: 'chat' }])
  expect((await call(read, { days: 61 }, 'session', '', 'admin', 'owner')).status).toBe(400)
  expect((await call(read, { days: 60, query: '%' }, 'session', '', 'admin', 'owner')).body)
    .toMatchObject({ entries: [{ body: '你说：边界%' }] })
  expect((await call(read, {}, 'session', '', 'admin', 'owner')).body)
    .toMatchObject({ entries: [{ body: '你说：今天的点子' }] })
})

it('pages an oversized paired-device day without splitting entries', async () => {
  const { n, call } = fixture()
  for (let i = 0; i < 3; i++) n.write('字'.repeat(1000), String(i), 'app')
  expect((await call('GET /v1/notebook')).body).toMatchObject({ entries: n.page().entries })
  const route = notebookRoutes(n)['GET /v1/notebook']!
  const paired = { tier: 'admin', origin: 'device', frameBudget: 5_000 } as const
  const all = n.page().entries
  const first = await route(new URLSearchParams(), null, paired)
  expect(first.body).toMatchObject({ entries: [all[0]], nextAfter: all[0]?.id })
  const page2 = await route(new URLSearchParams({ day: n.page().day, after: all[0]!.id }), null, paired)
  expect(page2.body).toMatchObject({ entries: [all[1]], nextAfter: all[1]?.id })
  const page3 = await route(new URLSearchParams({ day: n.page().day, after: all[1]!.id }), null, paired)
  expect(page3.body).toMatchObject({ entries: [all[2]] })
  expect(page3.body).not.toHaveProperty('nextAfter')
})

it('cancels an overdue opening during preflight without submitting its prompt', async () => {
  vi.useFakeTimers()
  let finishPreflight!: (reachable: boolean) => void
  const preflight = vi.fn((_id: string, _signal?: AbortSignal) =>
    new Promise<boolean>(resolve => { finishPreflight = resolve }))
  const registry = createProviderRegistry({ cheapEvalPreflight: preflight })
  const evaluate = vi.fn(async () => 'unused')
  registry.register('openai', { spawn: async () => { throw Error('unused') }, cheapEval: evaluate }, { canResume: () => false })
  const { n } = fixture(() => registry.getCheapEval({ private: true }), { openingTimeoutMs: 5 })
  const opening = n.open('desktop')
  await vi.advanceTimersByTimeAsync(5)
  await opening
  expect(n.page().entries.map(e => e.body)).toEqual(DEFAULT_OPENING.lines)
  finishPreflight(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(evaluate).not.toHaveBeenCalled()
  expect(preflight.mock.calls[0]?.[1]?.aborted).toBe(true)
})

it('aborts slow inference and waits for its cleanup before the next tick can submit', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const cancelled = vi.fn()
  const evaluate = vi.fn((_prompt: string, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
    signal?.addEventListener('abort', cancelled, { once: true })
    finish = () => signal?.aborted ? reject(signal.reason) : resolve('null')
  }))
  const registry = createProviderRegistry()
  registry.register('openai', { spawn: async () => { throw Error('unused') }, cheapEval: evaluate }, { canResume: () => false })
  const { n, at } = fixture(() => registry.getCheapEval({ private: true }), {
    timeoutMs: 5, checkIntervalMs: 1, quietMs: 0, failureBaseMs: 1, dailyLimit: 5,
  })
  n.write('留言候选', 'candidate', 'desktop')
  const first = n.tick()
  await vi.advanceTimersByTimeAsync(5)
  await first
  at(BASE + 10)
  const overlapping = n.tick()
  await vi.advanceTimersByTimeAsync(5)
  await overlapping
  expect(evaluate).toHaveBeenCalledTimes(1)
  expect(cancelled).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  const next = n.tick()
  await vi.advanceTimersByTimeAsync(5)
  await next
  expect(evaluate).toHaveBeenCalledTimes(2)
  finish()
})

it.each(['', '%'])('bounds and continues chat reads for literal query %j', async query => {
  const { n, call } = fixture()
  const entries = Array.from({ length: 100 }, (_, i) =>
    n.write(i % 2 ? '%' + '\u0001'.repeat(3999) : '字'.repeat(4000), String(i), 'desktop'))
  const expected = entries.filter(entry => entry.body.includes(query)).reverse().map(entry => entry.id)
  const received: string[] = []
  let after: string | undefined
  let pages = 0
  do {
    const result = await call('POST /v1/notebook/chat/read', { query, ...(after ? { after } : {}) }, 'session', '', 'admin', 'owner')
    expect(result.status).toBe(200)
    expect(JSON.stringify(result.body).length).toBeLessThanOrEqual(26_000)
    const page = NotebookChatReadResponse.parse(result.body)
    expect(page.entries.length).toBeGreaterThan(0)
    received.push(...page.entries.map(entry => entry.id))
    after = page.nextAfter
    if (after) expect(after).toBe(page.entries.at(-1)?.id)
    expect(++pages).toBeLessThanOrEqual(expected.length)
  } while (after)
  expect(received).toEqual(expected)
  expect(pages).toBeGreaterThan(1)
})
