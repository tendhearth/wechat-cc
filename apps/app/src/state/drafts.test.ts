import { describe, it, expect, beforeEach } from 'vitest'
import { clearDrafts, deleteDraft, dropReceipt, isReplied, listReceipts, markReplied, putReceipt, RECEIPTS_MAX, requestIdFor, subscribeReceipts } from './drafts'

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

describe('本机回执(终审 I1:离开 /chat 也不丢)', () => {
  const r = (id: string, at = 1) => ({ requestId: id, text: id, at, localAt: at })
  it('放进去就在模块里,屏幕卸载不影响;同 id 再放 ⇒ 替换并挪到最后', () => {
    putReceipt(r('a')); putReceipt(r('b')); putReceipt({ ...r('a'), text: 'a2' })
    expect(listReceipts().map(x => [x.requestId, x.text])).toEqual([['b', 'b'], ['a', 'a2']])
  })
  it('有上限:最旧的先挤掉', () => {
    for (let i = 0; i < RECEIPTS_MAX + 3; i++) putReceipt(r(`r${i}`))
    expect(listReceipts()).toHaveLength(RECEIPTS_MAX)
    expect(listReceipts()[0]!.requestId).toBe('r3')
  })
  it('落地 / 回复 / 不管它 ⇒ dropReceipt 清掉;快照引用只在变时换(给 useSyncExternalStore)', () => {
    putReceipt(r('a'))
    const snap = listReceipts()
    expect(listReceipts()).toBe(snap)
    dropReceipt('zzz')
    expect(listReceipts()).toBe(snap)
    dropReceipt('a')
    expect(listReceipts()).toEqual([])
  })
  it('订阅:变了就通知;退订后不再通知;清草稿(解除配对)一起清', () => {
    let n = 0
    const off = subscribeReceipts(() => { n++ })
    putReceipt(r('a')); dropReceipt('a')
    expect(n).toBe(2)
    putReceipt(r('b'))
    clearDrafts()
    expect(listReceipts()).toEqual([])
    expect(n).toBe(4)
    off(); putReceipt(r('c'))
    expect(n).toBe(4)
  })
})
