import { describe, it, expect, vi } from 'vitest'
import { scopedReply, scopedSend, withReplyScope } from './reply-scope'

describe('reply-scope(App 一轮的回复往哪儿去)', () => {
  it('作用域外 ⇒ 没有作用域,sendMessage 照常外发;作用域内 ⇒ 截住,按先后交回', async () => {
    const wire = vi.fn(async (_c: string, _t: string) => ({ msgId: 'w1' }))
    const send = scopedSend(wire)
    expect(scopedReply()).toBeUndefined()
    await send('c', '外发'); expect(wire).toHaveBeenCalledWith('c', '外发')
    const r = await withReplyScope(async () => { await send('c', '一'); await Promise.resolve(); await send('c', '二'); return 42 })
    expect(r).toEqual({ result: 42, replies: ['一', '二'] })
    expect(wire).toHaveBeenCalledTimes(1)
  })
  it('按异步上下文隔离:两轮交错跑,各收各的;同时外面的一条不受影响', async () => {
    const wire = vi.fn(async (_c: string, _t: string) => ({ msgId: 'w' }))
    const send = scopedSend(wire)
    const tick = () => new Promise(r => setTimeout(r, 1))
    const [a, b] = await Promise.all([
      withReplyScope(async () => { await send('c', 'a1'); await tick(); await send('c', 'a2') }),
      withReplyScope(async () => { await tick(); await send('c', 'b1') }),
      (async () => { await tick(); await send('c', '微信') })(),
    ])
    expect(a.replies).toEqual(['a1', 'a2']); expect(b.replies).toEqual(['b1'])
    expect(wire).toHaveBeenCalledTimes(1); expect(wire).toHaveBeenCalledWith('c', '微信')
  })
  it('作用域里 fn 抛错 ⇒ 原样抛出', async () => {
    await expect(withReplyScope(async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })
})
