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
  const routes = notebookRoutes(() => n)
  const call = (key: string, body?: unknown, origin: NonNullable<Parameters<RouteHandler>[2]>['origin'] = 'operator', query = '', tier: 'admin' | 'guest' = 'admin', chatId?: string) =>
    routes[key]!(new URLSearchParams(query), body, { tier, origin, chatId })
  return { n, store, call, logs, at: (t: number) => { time = t } }
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
  const route = notebookRoutes(() => n)['GET /v1/notebook']!
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
