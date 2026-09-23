import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../lib/db'
import { makeJournal, type Journal } from './journal-store'
import { readJournalSeen, writeJournalSeen } from './journal-seen'

let db: Db
let store: Journal
beforeEach(() => { db = openDb({ path: ':memory:' }); store = makeJournal(db) })

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

describe('Journal.summary —— 桌宠的包袱:水位之后有几条、最新一条是什么', () => {
  it('空表 → 0 / null', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.summary(null)).toEqual({ unread: 0, latest: null })
  })
  it('没看过 → 全算;水位之后只算新的;latest 永远是最新那条', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    j.recordHunt({ chatId: 'o', text: '看这个 https://a.com/1', nowIso: '2026-09-01T00:00:00.000Z' })
    j.recordVisit({ chatId: 'o', text: '去阿柚家坐了会儿', peerLabel: '去邻居「阿柚」家串门', nowIso: '2026-09-02T00:00:00.000Z' })
    expect(j.summary(null)).toEqual({ unread: 2, latest: { kind: 'visit', title: '去邻居「阿柚」家串门', ts: '2026-09-02T00:00:00.000Z' } })
    expect(j.summary('2026-09-01T12:00:00.000Z').unread).toBe(1)
    expect(j.summary('2026-09-02T00:00:00.000Z').unread).toBe(0)   // ts > 水位才算,等于不算
    expect(j.summary('2026-09-02T00:00:00.000Z').latest?.kind).toBe('visit')
  })
})

describe('journal-seen 水位文件', () => {
  it('没文件 → null;写了再读回来;文件坏了 → null 不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jseen-'))
    expect(readJournalSeen(dir)).toBe(null)
    writeJournalSeen(dir, '2026-09-03T10:00:00.000Z')
    expect(readJournalSeen(dir)).toBe('2026-09-03T10:00:00.000Z')
    writeFileSync(join(dir, 'companion', 'journal-seen.json'), '{not json')
    expect(readJournalSeen(dir)).toBe(null)
  })
})

describe('recordPostcard —— 别人回心愿的明信片', () => {
  it('一张一条,kind=postcard,标题带对方;空文本不记;summary 的 latest 认得它', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.recordPostcard({ chatId: 'o', text: '   ', peerLabel: '阿一' })).toBe(null)
    const id = j.recordPostcard({ chatId: 'o', text: '我朋友周末常去', peerLabel: '阿一', nowIso: '2026-09-04T10:00:00.000Z' })
    expect(id).toMatch(/:postcard:/)
    const row = j.list()[0]!
    expect(row).toMatchObject({ kind: 'postcard', title: '阿一 回了你的心愿', note: '我朋友周末常去', status: 'new', url: null })
    expect(j.summary(null).latest?.kind).toBe('postcard')
  })
})

describe('recordRecollection —— CC 自己判断值得记、自己写的一段记述', () => {
  it('一段一条,kind=recollection,标题固定,带 matter_id;空文本不记;summary 的 latest 认得它', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.recordRecollection({ chatId: 'o', text: '   ', matterId: 'deadbeef' })).toBe(null)
    const id = j.recordRecollection({ chatId: 'o', text: '那天你让我改首页,我改错了两次。', matterId: 'deadbeef', nowIso: '2026-09-23T10:00:00.000Z' })
    expect(id).toMatch(/:recollection:/)
    const row = j.list()[0]!
    expect(row).toMatchObject({ kind: 'recollection', title: '一段回忆', note: '那天你让我改首页,我改错了两次。', status: 'new', url: null, matter_id: 'deadbeef' })
    expect(j.summary(null).latest?.kind).toBe('recollection')
  })

  it('不问主人就写,但主人能删 —— 跟其它条目一样走 remove(),没有另开一条删除路径', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    const id = j.recordRecollection({ chatId: 'o', text: '第二天早上才通。', matterId: 'a0000001' })!
    expect(j.list().some(r => r.id === id)).toBe(true)
    expect(j.remove(id)).toBe(true)
    expect(j.list().some(r => r.id === id)).toBe(false)
    // 删过一次之后再删,跟其它 kind 一样如实说「已经没了」,不是静默成功。
    expect(j.remove(id)).toBe(false)
  })

  it('hasRecollection(v67 持久去重键):写过就是 true,没写过 / 没写成功都是 false', () => {
    const j = makeJournal(openDb({ path: ':memory:' }))
    expect(j.hasRecollection('a0000001')).toBe(false)
    j.recordRecollection({ chatId: 'o', text: '   ', matterId: 'a0000001' }) // 空文本没写成
    expect(j.hasRecollection('a0000001')).toBe(false)
    j.recordRecollection({ chatId: 'o', text: '写成了一条。', matterId: 'a0000001' })
    expect(j.hasRecollection('a0000001')).toBe(true)
    // 别的 matter 不受影响,也不因为存在其它 kind 的行而误判。
    expect(j.hasRecollection('b0000002')).toBe(false)
    j.recordVisit({ chatId: 'o', text: '串门见闻', peerLabel: '朋友' })
    expect(j.hasRecollection('b0000002')).toBe(false)
  })
})

describe('postcard album', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
  it('finds old illustrated visits independently of recent hunt entries and paginates', () => {
    const a = store.recordVisit({ chatId: 'c', text: 'first', peerLabel: '去朋友家', nowIso: '2020-01-01', imageSvg: svg })!
    store.recordVisit({ chatId: 'c', text: 'second', peerLabel: '另一家', nowIso: '2020-01-02', imageSvg: svg })
    store.recordVisit({ chatId: 'c', text: 'text only', peerLabel: '来客' })
    for (let i=0;i<205;i++) store.recordHunt({ chatId:'c', text:`link https://example.com/${i}` })
    expect(store.list().some(x=>x.id===a)).toBe(false)
    expect(store.listPostcards({ limit:1, offset:0 }).items[0]?.note).toBe('second')
    expect(store.listPostcards({ limit:1, offset:1 }).items[0]?.id).toBe(a)
    expect(store.listPostcards({}).total).toBe(2)
  })
  it('favorites survive pruning and reopening the store; uncollected entries still expire', () => {
    const id=store.recordVisit({chatId:'c',text:'keep me',peerLabel:'friend',nowIso:'2020-01-01',imageSvg:svg})!
    const dropped=store.recordVisit({chatId:'c',text:'old',peerLabel:'friend',nowIso:'2020-01-02',imageSvg:svg})!
    expect(store.setFavorite(id,true)).toBe(true)
    for(let i=0;i<501;i++)store.recordHunt({chatId:'c',text:`link https://example.com/${i}`})
    const reopened=makeJournal(db)
    expect(reopened.listPostcards({favoritesOnly:true}).items.map(x=>x.id)).toEqual([id])
    expect(reopened.list(1000).some(x=>x.id===dropped)).toBe(false)
    expect(reopened.setFavorite(id,false)).toBe(true)
    expect(reopened.listPostcards({favoritesOnly:true}).total).toBe(0)
    expect(reopened.setFavorite('missing',true)).toBe(false)
    expect(reopened.setFavorite(reopened.list()[0]!.id,true)).toBe(false)
  })
})

it('upgrades an existing v44 journal without losing its picture and narration', async () => {
  const { openSqlite } = await import('../lib/runtime/sqlite')
  const { runMigrations } = await import('../lib/db')
  const old = openSqlite(':memory:')
  old.exec("CREATE TABLE journal(id TEXT PRIMARY KEY, image_svg TEXT, note TEXT); INSERT INTO journal VALUES ('old','<svg></svg>','the story'); PRAGMA user_version=44;")
  runMigrations(old)
  expect(old.query('SELECT * FROM journal').get()).toEqual({id:'old',image_svg:'<svg></svg>',note:'the story',favorite:0,matter_id:null})
  runMigrations(old)
  expect(old.query('SELECT COUNT(*) AS n FROM journal').get()).toEqual({n:1})
  old.close()
})
