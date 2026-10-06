import { describe, expect, it } from 'vitest'
import { searchSegments } from './chat-search'

describe('searchSegments', () => {
  it('marks every occurrence and keeps the rest verbatim', () => {
    expect(searchSegments('报告，季度报告。', '报告')).toEqual([{ text: '报告', hit: true }, { text: '，季度', hit: false }, { text: '报告', hit: true }, { text: '。', hit: false }])
    expect(searchSegments('无关', '报告')).toEqual([{ text: '无关', hit: false }])
    expect(searchSegments('文字', ' ')).toEqual([{ text: '文字', hit: false }])
  })
})
