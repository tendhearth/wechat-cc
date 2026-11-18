import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makePlacesStore } from './places-store'

const rec = (key: string, position: number) => ({ key, root: `/w/${key}`, name: key, position, hidden: false })

describe('places-store(v117)', () => {
  it('加进来的按位置列;同 key / 同 root 的不重复加', () => {
    const db = openTestDb()
    const s = makePlacesStore(db)
    s.add([rec('p:b', 1), rec('p:a', 0)], 1)
    s.add([rec('p:a', 9), { ...rec('p:c', 5), root: '/w/p:b' }], 2)
    expect(s.list().map(r => [r.key, r.position])).toEqual([['p:a', 0], ['p:b', 1]])
  })

  it('挪位置:其余顺下去;超出放最后;没有的 key ⇒ false', () => {
    const db = openTestDb()
    const s = makePlacesStore(db)
    s.add([rec('p:a', 0), rec('p:b', 1), rec('p:c', 2)], 1)
    expect(s.move('p:c', 0)).toBe(true)
    expect(s.list().map(r => r.key)).toEqual(['p:c', 'p:a', 'p:b'])
    s.move('p:c', 99)
    expect(s.list().map(r => [r.key, r.position])).toEqual([['p:a', 0], ['p:b', 1], ['p:c', 2]])
    expect(s.move('p:zz', 0)).toBe(false)
  })

  it('收起 / 放回', () => {
    const db = openTestDb()
    const s = makePlacesStore(db)
    s.add([rec('p:a', 0)], 1)
    expect(s.setHidden('p:a', true)).toBe(true)
    expect(s.list()[0]!.hidden).toBe(true)
    s.setHidden('p:a', false)
    expect(s.list()[0]!.hidden).toBe(false)
    expect(s.setHidden('p:zz', true)).toBe(false)
  })
})
