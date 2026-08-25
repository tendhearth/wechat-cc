import { describe, expect, it, vi } from 'vitest'

vi.mock('../view.js', () => ({ escapeHtml: (s: string) => s, formatRelativeTime: () => '' }))
vi.mock('./observations.js', () => ({ observationRow: () => '', milestoneCard: () => '' }))
vi.mock('./decisions.js', () => ({ decisionRow: () => '' }))
vi.mock('./icons.js', () => ({ icon: () => '' }))

// @ts-expect-error minimal DOM stub before import (module shape parity with todos.test.ts)
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }
// @ts-expect-error localStorage stub
globalThis.localStorage = { getItem: () => null, setItem: () => {} }

const { summaryParagraphs } = await import('./memory.js')

describe('summaryParagraphs', () => {
  it('splits on blank lines and drops markdown hr lines', () => {
    expect(summaryParagraphs('第一段。\n\n---\n\n第二段。\n继续第二段。\n\n第三段。'))
      .toEqual(['第一段。', '第二段。\n继续第二段。', '第三段。'])
  })
  it('single paragraph stays whole; empty input → []', () => {
    expect(summaryParagraphs('只有一段')).toEqual(['只有一段'])
    expect(summaryParagraphs('')).toEqual([])
  })
})
