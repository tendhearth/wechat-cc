import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../lib/db'
import { makeHuntStore, type HuntStore } from './hunt-store'

let db: Db
let store: HuntStore
beforeEach(() => { db = openDb({ path: ':memory:' }); store = makeHuntStore(db) })

const HUNT = `今天两条：

Continue.dev 开了 agent 模式，你上次说想要能改多文件的。https://github.com/continuedev/continue

SQLite WAL 高并发实测，跟你队列那个卡顿有关。https://example.com/wal`

describe('recordHunt', () => {
  it('把一次打猎拆成多条入库,原文一字不改', () => {
    expect(store.recordHunt({ chatId: 'owner@chat', text: HUNT })).toBe(2) // 开场白不算猎物
    const rows = store.list()
    expect(rows.map(r => r.url)).toContain('https://github.com/continuedev/continue')
    expect(rows.find(r => r.url?.includes('continue'))!.note).toContain('你上次说想要')
    expect(rows.every(r => r.status === 'new')).toBe(true)
  })

  it('**同一天同一条链接不重复入库** —— 重启补跑会让列表出现两条一样的,看起来像 bug', () => {
    store.recordHunt({ chatId: 'c', text: HUNT, nowIso: '2026-09-03T08:00:00.000Z' })
    const again = store.recordHunt({ chatId: 'c', text: HUNT, nowIso: '2026-09-03T20:00:00.000Z' })
    expect(again).toBe(0)
    expect(store.list().filter(r => r.url?.includes('continue'))).toHaveLength(1)
  })

  it('**跨天的重复要保留** —— 隔一周又被推同一个东西,这件事本身值得看见', () => {
    store.recordHunt({ chatId: 'c', text: HUNT, nowIso: '2026-09-03T08:00:00.000Z' })
    store.recordHunt({ chatId: 'c', text: HUNT, nowIso: '2026-09-10T08:00:00.000Z' })
    expect(store.list().filter(r => r.url?.includes('continue'))).toHaveLength(2)
  })

  it('空回复不入库(打猎允许「今天没猎到」)', () => {
    expect(store.recordHunt({ chatId: 'c', text: '   ' })).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('倒序:最近的在最前', () => {
    store.recordHunt({ chatId: 'c', text: '早的 https://a.com', nowIso: '2026-09-01T08:00:00.000Z' })
    store.recordHunt({ chatId: 'c', text: '晚的 https://b.com', nowIso: '2026-09-02T08:00:00.000Z' })
    expect(store.list()[0]!.url).toBe('https://b.com')
  })
})

describe('setStatus / remove', () => {
  it('改状态(没试 → 跑过 → 在用)', () => {
    store.recordHunt({ chatId: 'c', text: '看这个 https://a.com' })
    const id = store.list()[0]!.id
    expect(store.setStatus(id, 'using')).toBe(true)
    expect(store.list()[0]!.status).toBe('using')
  })

  it('删掉一条', () => {
    store.recordHunt({ chatId: 'c', text: '看这个 https://a.com' })
    expect(store.remove(store.list()[0]!.id)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('**不存在的 id 返回 false,而不是静默成功** —— 界面上要能说「这条已经没了」', () => {
    expect(store.setStatus('nope', 'using')).toBe(false)
    expect(store.remove('nope')).toBe(false)
  })
})

describe('recordVisit —— 串门见闻和打猎东西在同一个背包里', () => {
  it('一段一条,kind=visit,没有链接', () => {
    const id = store.recordVisit({ chatId: 'c', text: '今天去杭州那家转了转,他们家猫叫豆包。', peerLabel: '去第 1 度的朋友家串门' })
    const r = store.list()[0]!
    expect(r.kind).toBe('visit')
    expect(r.title).toBe('去第 1 度的朋友家串门')
    expect(r.image_svg).toBeNull()
    store.attachImage(id!, '<svg/>')
    expect(store.list()[0]!.image_svg).toBe('<svg/>')
    expect(r.url).toBeNull()
    expect(r.note).toContain('豆包')
  })
  it('打猎的行 kind=hunt(v37 默认值,老行也一样)', () => {
    store.recordHunt({ chatId: 'c', text: '看这个 https://a.com' })
    expect(store.list()[0]!.kind).toBe('hunt')
  })
  it('空叙述不入库', () => {
    expect(store.recordVisit({ chatId: 'c', text: '  ', peerLabel: 'x' })).toBeNull()
    expect(store.list()).toEqual([])
  })
})
