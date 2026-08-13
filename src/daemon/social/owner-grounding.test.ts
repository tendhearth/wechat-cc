import { test, expect } from 'vitest'
import { makeOwnerGrounding } from './owner-grounding'

const factsFixture = { results: [
  { predicate: '爱好', value: '摄影', kind: 'entity', confidence: 'high' },
  { predicate: '所在城市', value: '南京', kind: 'attribute', confidence: 'med' },
] }

test('formats structured facts into labelled grounding text', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => factsFixture } as any })
  const text = await ground({ topic: '摄影' })
  expect(text).toContain('摄影')
  expect(text).toContain('南京')
  expect(text.length).toBeGreaterThan(0)
})

test('adds semantic message recall when embedder + search present', async () => {
  const ground = makeOwnerGrounding({
    facts: { findFacts: () => ({ results: [] }) } as any,
    store: {} as any,
    embedder: { model_id: 'm' },
    embedQuery: async () => [0.1, 0.2],
    search: (() => ({ results: [{ text: '上周去紫金山拍了银河', conversation: 'c', time: 1 }] })) as any,
  })
  const text = await ground({ topic: '摄影' })
  expect(text).toContain('紫金山')
})

test('empty stores → empty string', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => ({ results: [] }) } as any })
  expect(await ground({ topic: 'x' })).toBe('')
})

test('undefined knowledge → empty string (honest blind)', async () => {
  expect(await makeOwnerGrounding(undefined)({ topic: 'x' })).toBe('')
})

test('a throwing sub-fetch degrades to empty, never throws', async () => {
  const ground = makeOwnerGrounding({ facts: { findFacts: () => { throw new Error('boom') } } as any })
  expect(await ground({ topic: 'x' })).toBe('')
})

test('caps very large fact sets (char cap)', async () => {
  const many = { results: Array.from({ length: 500 }, (_, i) => ({ predicate: 'p' + i, value: 'v'.repeat(50), kind: 'e', confidence: 'low' })) }
  const ground = makeOwnerGrounding({ facts: { findFacts: () => many } as any })
  const text = await ground({ topic: 'x' })
  expect(text.length).toBeLessThanOrEqual(2200)   // cap ~2000 + label slack
})
