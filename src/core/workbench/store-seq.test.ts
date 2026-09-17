import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'

const mk = () => { const db = openTestDb(); const store = makeWorkbenchStore(db); const t = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' }); return { db, store, id: t.id } }

describe('store seq(每个写点都让 version 递增)', () => {
  it('新任务 version=0;每种写点各 +1', () => {
    const { store, id } = mk()
    expect(store.version(id)).toBe(0)
    const before = () => store.version(id)
    let v = before(); store.addEvent(id, 'system', 'x'); expect(before()).toBe(v + 1)
    v = before(); store.recordAgentEvent(id, 'run1', { kind: 'text', text: 'a', itemId: 'i1', textMode: 'append' }); expect(before()).toBe(v + 1)
    v = before(); store.recordAgentEvent(id, 'run1', { kind: 'text', text: 'b', itemId: 'i1', textMode: 'append' }); expect(before()).toBe(v + 1)
    v = before(); store.update(id, 'running'); expect(before()).toBe(v + 1)
    v = before(); store.finishRunActivities(id, 'run1', 'cancelled'); expect(before()).toBe(v + 1)
    v = before(); store.session(id, 's1'); expect(before()).toBe(v + 1)
    v = before(); expect(store.bump(id)).toBe(v + 1)
  })
  it('detail({since}) 只回 seq > since 的行;追加过的旧行也算"变过";version 随行', () => {
    const { store, id } = mk()
    store.addEvent(id, 'user', '要求')                                              // seq 1
    store.recordAgentEvent(id, 'run1', { kind: 'text', text: '你', itemId: 'i1', textMode: 'append' })   // seq 2 (insert)
    const d1 = store.detail(id, { since: 0 })
    expect(d1.version).toBe(2); expect(d1.events.map(e => e.text)).toEqual(['要求', '你'])
    store.recordAgentEvent(id, 'run1', { kind: 'text', text: '好', itemId: 'i1', textMode: 'append' })   // seq 3 (update 同一行)
    const d2 = store.detail(id, { since: 2 })
    expect(d2.version).toBe(3); expect(d2.events).toHaveLength(1); expect(d2.events[0]!.text).toBe('你好')
    expect(store.detail(id, { since: 3 }).events).toEqual([])
    expect(store.detail(id).events).toHaveLength(2)    // 不带 since 行为不变
  })
  it('bump 不存在的任务 ⇒ not_found', () => {
    const { store } = mk(); expect(() => store.bump('nope0000')).toThrow('not_found')
  })
})
