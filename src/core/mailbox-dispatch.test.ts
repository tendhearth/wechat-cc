import { describe, it, expect, vi } from 'vitest'
import { makeEnvelopeDispatch } from './mailbox-dispatch'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

const rec = (id: string): A2AAgentRecord => ({ id, name: id, url: 'http://x/a2a', inbound_api_key: 'k', outbound_api_key: 'k', capabilities: [], paused: false, may_exec: false, transport: 'push' })
const registry = (verify: (id: string, b: string) => A2AAgentRecord | null): A2ARegistry =>
  ({ verifyBearer: verify, list: () => [], get: () => null, add() {}, remove() {}, setPaused() {}, update: (() => { throw new Error('x') }) as any })
const log = () => {}

describe('makeEnvelopeDispatch', () => {
  it('letter: calls onLetter WITHOUT a registry bearer check (channel-key auth)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'c', ct: 'x' }))
  })
  it('letter: 缺字段的信封在调 onLetter 之前就丢掉', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { agent_id: 's', channel_id: 'c', nonce: 'n', ct: 'x' } })   // tag 缺
    expect(onLetter).not.toHaveBeenCalled()
  })
  it('letter: agent_id 缺失时退成 "mailbox"(它只是路由元数据,不是身份)', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onLetter, log })
    await d.dispatch({ path: '/a2a/letter', bearer: 'ignored', body: { channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })
    expect(onLetter).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'mailbox' }))
  })
  it('退役的路由(intent/echo/reveal)和任何未知 path 一样:no-op,不炸', async () => {
    const onLetter = vi.fn(async () => ({ ok: true }))
    const d = makeEnvelopeDispatch({ registry: registry(() => rec('w')), onLetter, log })
    for (const path of ['/a2a/intent', '/a2a/echo', '/a2a/reveal', '/a2a/whatever']) {
      await expect(d.dispatch({ path, bearer: 'b', body: { agent_id: 'w', intent_id: 'i1' } })).resolves.toBeUndefined()
    }
    expect(onLetter).not.toHaveBeenCalled()
  })
  it('malformed body never throws', async () => {
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onLetter: async () => ({ ok: true }), log })
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: null })).resolves.toBeUndefined()
  })
  it('onLetter 抛了也只记日志,不把异常冒到取件循环里', async () => {
    const lines: string[] = []
    const d = makeEnvelopeDispatch({ registry: registry(() => null), onLetter: async () => { throw new Error('boom') }, log: (_t, l) => lines.push(l) })
    await expect(d.dispatch({ path: '/a2a/letter', bearer: 'b', body: { channel_id: 'c', nonce: 'n', ct: 'x', tag: 't' } })).resolves.toBeUndefined()
    expect(lines.join('\n')).toContain('boom')
  })
})
