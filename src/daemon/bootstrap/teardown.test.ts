import { describe, expect, it } from 'vitest'
import { makeTeardown } from './teardown'

describe('bootstrap 收尾清单', () => {
  it('倒序给出:后起的先停', () => {
    const t = makeTeardown()
    t.add('A', 'first', () => {}); t.add('B', 'second', () => {})
    expect(t.steps().map(s => s.tag)).toEqual(['B', 'A'])
  })
})
