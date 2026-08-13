import { test, expect } from 'vitest'
import { distillOwnerKnowledge } from './knowledge-distill'

const facts = { findFacts: () => ({ results: [
  { predicate: '欠', value: '老王 200 元', kind: 'obligation' },
  { predicate: '答应', value: '给小李看简历', kind: 'obligation' },
] }) } as any
const graph = { topContacts: (by: string) => by === 'closeness'
  ? [{ display: '小A', username: 'wxid_a' }, { display: '小B', username: 'wxid_b' }]
  : [{ display: '老陈', username: 'wxid_c' }] } as any

test('formats obligations + close + neglected from the in-proc kernel', async () => {
  const md = await distillOwnerKnowledge({ facts, graph })
  expect(md).toContain('未了义务'); expect(md).toContain('老王 200 元')
  expect(md).toContain('亲近的人'); expect(md).toContain('小A')
  expect(md).toContain('好久没联系'); expect(md).toContain('老陈')
})

test('undefined knowledge → empty string', async () => {
  expect(await distillOwnerKnowledge(undefined)).toBe('')
})

test('only facts present → obligations only, no relationship sections', async () => {
  const md = await distillOwnerKnowledge({ facts })
  expect(md).toContain('未了义务'); expect(md).not.toContain('亲近的人')
})

test('a throwing source drops its subsection, never throws', async () => {
  const md = await distillOwnerKnowledge({ graph: { topContacts: () => { throw new Error('x') } } as any })
  expect(md).toBe('')   // graph threw → no relationship section; no obligations → all-empty
})

test('caps at KNOWLEDGE_DISTILL_CAP', async () => {
  const big = { findFacts: () => ({ results: Array.from({ length: 100 }, (_, i) => ({ predicate: 'p', value: 'v'.repeat(40) + i, kind: 'obligation' })) }) } as any
  const md = await distillOwnerKnowledge({ facts: big })
  expect(md.length).toBeLessThanOrEqual(1500)
})
