import { describe, expect, it } from 'vitest'
import type { RosterItemT } from '@wechat-cc/protocol'
import { buildPlaces, type PlaceRecord, type PlacesInput } from './places'

const NOW = 1_800_000_000_000
const MIN = 60_000
const item = (id: string, over: Partial<RosterItemT> = {}): RosterItemT => ({
  key: `matter:${id}`, kind: 'matter', id, title: `事 ${id}`, group: 'working', status: 'working',
  agents: [{ id: 'codex', current: true }], quiet: false, updatedAt: NOW - MIN, unseen: false, ...over,
})
const roots: Record<string, string> = {}
function input(items: RosterItemT[], over: Partial<PlacesInput> = {}): PlacesInput {
  return {
    items,
    rootOf: i => roots[i.id] ?? null,
    originOf: id => `msg-${id}`,
    saved: [],
    keyOf: root => `p:${Buffer.from(root).toString('hex').padEnd(16, '0').slice(0, 16)}`,
    nameOf: root => root.split('/').pop()!,
    ...over,
  }
}
const rec = (root: string, position: number, over: Partial<PlaceRecord> = {}): PlaceRecord => ({
  key: `p:${Buffer.from(root).toString('hex').padEnd(16, '0').slice(0, 16)}`, root, name: root.split('/').pop()!, position, hidden: false, ...over,
})

describe('buildPlaces', () => {
  it('同一个项目根目录的几件事并成一行;说不出项目的不成行', () => {
    Object.assign(roots, { a1: '/w/rici', a2: '/w/rici', a3: '/w/melu' })
    const { places } = buildPlaces(input([item('a1'), item('a2', { updatedAt: NOW }), item('a3'), item('nope')]))
    expect(places.map(p => [p.name, p.matterIds])).toEqual([['rici', ['a2', 'a1']], ['melu', ['a3']]])
  })

  it('顺序只看存下的位置,不按状态重排;新见到的追加在末尾、最近动过的在前', () => {
    Object.assign(roots, { b1: '/w/leni', b2: '/w/1in8b', b3: '/w/ranu', b4: '/w/melu2' })
    const saved = [rec('/w/leni', 0), rec('/w/1in8b', 1)]
    const items = [
      item('b2', { group: 'waiting', status: 'waiting', waiting: { kind: 'permission', requestId: 'r1', summary: '删旧表?', count: 1 } }),
      item('b3', { updatedAt: NOW - 9 * MIN }), item('b4', { updatedAt: NOW }), item('b1', { group: 'back', status: 'done', updatedAt: NOW - 99 * MIN }),
    ]
    const { places, added } = buildPlaces(input(items, { saved }))
    expect(places.map(p => p.name)).toEqual(['leni', '1in8b', 'melu2', 'ranu'])
    expect(added.map(r => [r.name, r.position])).toEqual([['melu2', 2], ['ranu', 3]])
  })

  it('有在等你的:行上带等得最久那条 + 一共几条,现状就是那条请求', () => {
    Object.assign(roots, { c1: '/w/x', s9: '/w/x' })
    const items = [
      item('c1', { group: 'waiting', status: 'waiting', waiting: { kind: 'question', requestId: 'q1', summary: '用哪种格式?', count: 2 } }),
      item('c2', { key: 'terminal:s9', kind: 'terminal', id: 's9', group: 'waiting', status: 'waiting', terminal: { sessionId: 's9', code: 's9', summary: '要不要继续' } }),
    ]
    const [p] = buildPlaces(input(items)).places
    expect(p!.waiting).toEqual({ itemKey: 'matter:c1', kind: 'question', matterId: 'c1', requestId: 'q1', summary: '用哪种格式?', count: 3 })
    expect(p!.line).toBe('用哪种格式?')
    expect(p!.status).toBe('waiting')
    expect(p!.sessionIds).toEqual(['s9'])
  })

  it('终端自己停着问:kind terminal,带会话 id,没有 requestId', () => {
    roots['s1'] = '/w/bx'
    const t = item('s1', { key: 'terminal:s1', kind: 'terminal', group: 'waiting', status: 'waiting', terminal: { sessionId: 's1', code: 's1', summary: 'Allow bun test?' } })
    const [p] = buildPlaces(input([t])).places
    expect(p!.waiting).toEqual({ itemKey: 'terminal:s1', kind: 'terminal', sessionId: 's1', summary: 'Allow bun test?', count: 1 })
  })

  it('没在等:有在干的就说在干的那件,不管带回来的更新', () => {
    Object.assign(roots, { d1: '/w/m', d2: '/w/m' })
    const items = [item('d1', { title: '画第二张图', updatedAt: NOW - 5 * MIN }), item('d2', { group: 'back', status: 'done', title: '修好了', updatedAt: NOW })]
    const [p] = buildPlaces(input(items)).places
    expect([p!.line, p!.status, p!.moving, p!.updatedAt]).toEqual(['画第二张图', 'working', true, NOW])
  })

  it('终端行的现状用它最近那一句,没有才用标题', () => {
    roots['s2'] = '/w/t'
    const t = item('s2', { key: 'terminal:s2', kind: 'terminal', title: 't', terminal: { sessionId: 's2', code: 's2', summary: '跑完测试了' } })
    expect(buildPlaces(input([t])).places[0]!.line).toBe('跑完测试了')
  })

  it('带回来了没看过 ⇒ unseen;messageIds 去重', () => {
    Object.assign(roots, { e1: '/w/u', e2: '/w/u' })
    const items = [item('e1', { group: 'back', status: 'done', unseen: true }), item('e2', { group: 'back', status: 'done' })]
    const [p] = buildPlaces(input(items, { originOf: () => 'same' })).places
    expect([p!.unseen, p!.moving, p!.messageIds]).toEqual([true, false, ['same']])
  })

  it('存下的地方这阵子没动静:照样一行,现状为空', () => {
    const [p] = buildPlaces(input([], { saved: [rec('/w/quiet', 0)] })).places
    expect(p).toMatchObject({ name: 'quiet', line: null, status: null, waiting: null, moving: false, unseen: false, updatedAt: null, matterIds: [] })
  })

  it('收起的地方不列;但那里有事等你时照样列', () => {
    Object.assign(roots, { f1: '/w/h1', f2: '/w/h2' })
    const saved = [rec('/w/h1', 0, { hidden: true }), rec('/w/h2', 1, { hidden: true })]
    const items = [item('f1'), item('f2', { group: 'waiting', status: 'waiting', waiting: { kind: 'permission', requestId: 'p', summary: 's', count: 1 } })]
    expect(buildPlaces(input(items, { saved })).places.map(p => p.name)).toEqual(['h2'])
  })

  it('存下的名字优先(主人改过名)', () => {
    roots['g1'] = '/w/long-repo-name'
    const [p] = buildPlaces(input([item('g1')], { saved: [rec('/w/long-repo-name', 0, { name: '长名字' })] })).places
    expect(p!.name).toBe('长名字')
  })

  it('每个地方带去筛说话的 id 有上限', () => {
    const many = Array.from({ length: 5 }, (_, i) => { roots[`h${i}`] = '/w/cap'; return item(`h${i}`, { updatedAt: NOW - i }) })
    expect(buildPlaces(input(many, { maxIds: 2 })).places[0]!.matterIds).toEqual(['h0', 'h1'])
  })
})
