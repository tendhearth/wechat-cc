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
  it('设计上容忍多算：迟到的 running 撞见已完成的同一调用，行不回退成转圈，但 version 仍照样 +1（bump 在早退前已求值，代价只是一次空轮询）', () => {
    const { store, id } = mk()
    const activity = (status: 'running' | 'completed') => ({ kind: 'tool_call' as const, tool: 't', activity: { id: 'call1', type: 'tool' as const, status, label: 'l' } })
    store.recordAgentEvent(id, 'run1', activity('running'))
    store.recordAgentEvent(id, 'run1', activity('completed'))
    const v = store.version(id)
    store.recordAgentEvent(id, 'run1', activity('running')) // 过期的 running：应被早退忽略（不回退状态），但 seq 仍然 +1
    expect(store.version(id)).toBe(v + 1)
    const event = store.detail(id).events.find(e => e.activity?.id === 'call1')!
    expect(event.activity!.status).toBe('completed')
  })
  it('detail() 先读 version 后读 events：version 不会跑到已读到的行前面', () => {
    const { db, store, id } = mk()
    store.addEvent(id, 'system', 'a')
    store.recordAgentEvent(id, 'run1', { kind: 'text', text: 'b', itemId: 'i1', textMode: 'append' })
    const d = store.detail(id)
    expect(d.events.length).toBeGreaterThan(0)
    // events 本身不对外报 seq(公开字段里没有它),直接查库核对——这条钉的是「读的先后顺序」这个
    // 不变量:哪怕并发写夹在两次读之间,version 也绝不能抢先报出比已读到的行更新的进度。
    const maxEventSeq = db.query<{ maxSeq: number }, [string]>('SELECT MAX(seq) AS maxSeq FROM workbench_events WHERE task_id=?').get(id)!.maxSeq
    expect(d.version).toBeLessThanOrEqual(maxEventSeq)
  })
  it('recordHandoffNative/recordHandoffEvent 同时唤醒 source 与 target 两边的实时视图（handoffs() 在两边 detail() 里都会出现）', () => {
    const { store } = mk()
    const source = store.get(store.create({ title: 'source', path: '/p', providerId: 'codex', ownerChatId: 'o' }).id)
    const target = store.get(store.create({ title: 'target', path: '/p', providerId: 'claude', ownerChatId: 'o' }).id)
    const handoff = store.createHandoff({
      id: 'h1', sourceTaskId: source.id, targetTaskId: target.id, targetProviderId: 'claude',
      path: '/p', title: 'target', ownerChatId: 'o', purpose: 'review', request: 'req',
      packetSha256: 'a'.repeat(64), artifactRefsJson: '[]', quoteJson: null,
      sourceNativeId: null, packetJson: '{}', tokenHash: 'b'.repeat(64),
    })
    let vs = store.version(source.id), vt = store.version(target.id)
    store.recordHandoffNative(handoff.id, 'native-1')
    expect(store.version(source.id)).toBe(vs + 1); expect(store.version(target.id)).toBe(vt + 1)
    const eventId = store.addEvent(target.id, 'user', '要求')
    vs = store.version(source.id); vt = store.version(target.id)
    store.recordHandoffEvent(handoff.id, eventId)
    expect(store.version(source.id)).toBe(vs + 1); expect(store.version(target.id)).toBe(vt + 1)
  })
})
