import { describe, it, expect, beforeEach } from 'vitest'
import { clearDrafts, deleteDraft, isReplied, markReplied, requestIdFor } from './drafts'

let n = 0
const mk = () => `id-${++n}`
beforeEach(() => { clearDrafts(); n = 0 })

describe('requestIdFor', () => {
  it('同一份草稿、同样正文 ⇒ 同一个 id(超时后重发由 daemon 去重)', () => {
    expect(requestIdFor('new', '整理周报', mk)).toBe('id-1')
    expect(requestIdFor('new', '整理周报', mk)).toBe('id-1')
  })
  it('正文改了 ⇒ 换新 id(否则 daemon 回 creation_conflict)', () => {
    requestIdFor('new', 'a', mk)
    expect(requestIdFor('new', 'b', mk)).toBe('id-2')
  })
  it('不同草稿互不影响;删草稿后重新发号', () => {
    requestIdFor('new', 'a', mk)
    expect(requestIdFor('m1', 'a', mk)).toBe('id-2')
    deleteDraft('new')
    expect(requestIdFor('new', 'a', mk)).toBe('id-3')
  })
  it('已知有回复的 requestId 永不再用:同样正文再发 ⇒ 换新 id;清草稿时一起忘掉', () => {
    expect(requestIdFor('chat', '在吗', mk)).toBe('id-1')
    markReplied('id-1')
    expect(isReplied('id-1')).toBe(true)
    expect(requestIdFor('chat', '在吗', mk)).toBe('id-2')
    clearDrafts()
    expect(isReplied('id-1')).toBe(false)
  })
})
