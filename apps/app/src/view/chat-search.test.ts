import { describe, expect, it } from 'vitest'
import { searchCopy, searchSegments } from './chat-search'

describe('searchSegments', () => {
  it('marks every occurrence and keeps the rest verbatim', () => {
    expect(searchSegments('报告，季度报告。', '报告')).toEqual([{ text: '报告', hit: true }, { text: '，季度', hit: false }, { text: '报告', hit: true }, { text: '。', hit: false }])
    expect(searchSegments('无关', '报告')).toEqual([{ text: '无关', hit: false }])
    expect(searchSegments('文字', ' ')).toEqual([{ text: '文字', hit: false }])
  })
})

it.each([
  ['zh-Hans', { title: '搜对话', placeholder: '搜和 CC 说过的话' }, { title: '搜事项', placeholder: '搜交办过的事' }],
  ['en', { title: 'Search chat', placeholder: 'Search what you and CC said' }, { title: 'Search work', placeholder: 'Search previously delegated work' }],
] as const)('uses the title and placeholder for the selected search in %s', (lang, messages, work) => {
  expect(searchCopy('messages', lang)).toEqual(messages)
  expect(searchCopy('work', lang)).toEqual(work)
})
