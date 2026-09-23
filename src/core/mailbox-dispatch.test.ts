import { describe, it, expect, vi } from 'vitest'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
// 注册表不再是这个分发器的依赖:信箱里只剩 /a2a/letter 一种信封,而 letter
// 的认证是 sealed-box + 信道密钥,从来不查 bearer。
const log = () => {}

describe('makeEnvelopeDispatch', () => {
  it('letter: calls onLetter WITHOUT a registry bearer check (channel-key auth)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'c', ct: 'x' }))
  })
  it('letter: 缺字段的信封在调 onLetter 之前就丢掉', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x' } })   // tag 缺
    expect(onLetter).not.toHaveBeenCalled()
  })
  it('letter: agent_id 缺失时退成 "mailbox"(它只是路由元数据,不是身份)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'mailbox' }))
  })
  it('退役的路由(intent/echo/reveal)和任何未知 path 一样:no-op,不炸', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ onLetter, log })
    for (const path of ['/a2a/intent', '/a2a/echo', '/a2a/reveal', '/a2a/whatever']) {
      await expect(d.dispatch({ path, bearer: 'b', body: { agent_id: 'w', intent_id: 'i1' } })).resolves.toBeUndefined()
    }
    expect(onLetter).not.toHaveBeenCalled()
  })
  it('malformed body never throws', async () => {
    const d = makeEnvelopeDispatch({ onLetter: async () => ({ ok: true }), log })
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: null })).resolves.toBeUndefined()
  })
  it('onLetter 抛了也只记日志,不把异常冒到取件循环里', async () => {
    const lines: string[] = []
    const d = makeEnvelopeDispatch({ onLetter: async () => { throw new Error('boom') }, log: (_t, l) => lines.push(l) })
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })).resolves.toBeUndefined()
    expect(lines.join('\n')).toContain('boom')
  })
})
