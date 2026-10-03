import { describe, it, expect } from 'vitest'
import { isReplyTail } from './reply-tail'

// 样本取自 2026-10-02 真机与 reply-once harness(docs/reference/reply-once-experiment.md)。
describe('isReplyTail', () => {
  const prior = ['收到,e2e 正常。']

  it('本轮还没发过话 ⇒ 永远不是尾巴', () => {
    expect(isReplyTail('（真的停了）', [])).toBe(false)
    expect(isReplyTail('收到', [])).toBe(false)
  })

  it.each([
    '（停，不再发了 😅）', '（真的停了）', '(停)', '（就这一句,不追加了）', '(🤫)',
    '真的停了', '抱歉刚才多发了一条', '嗯……又多了', '……', '👌',
  ])('尾巴:%s', t => {
    expect(isReplyTail(t, prior)).toBe(true)
  })

  it('与本轮已发的某条(忽略标点空白)完全相同 ⇒ 尾巴', () => {
    expect(isReplyTail('收到 e2e 正常', prior)).toBe(true)
  })

  it.each([
    '2) 做一顿平时懒得做的菜,或者约人吃顿好的。',
    '停车场在 B2',
    '收到,我去查一下项目列表',
    '(补充:完整的文档链接在 https://example.com/docs/reply-once ,里面有每个场景的原始记录)',
    '雨天的话可以在家看部电影,别想工作上的事。',
  ])('正经的下一条:%s', t => {
    expect(isReplyTail(t, prior)).toBe(false)
  })
})
