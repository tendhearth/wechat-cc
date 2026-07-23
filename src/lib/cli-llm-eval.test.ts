import { describe, it, expect, vi } from 'vitest'
import { makeCliSdkEval, delegateMemoryOp, CompiledLlmError } from './cli-llm-eval'

describe('makeCliSdkEval', () => {
  it('非编译 → inline eval 被调', async () => {
    const inline = vi.fn(async () => 'OUT')
    const ev = makeCliSdkEval({ isCompiled: () => false, inline })
    expect(await ev('p')).toBe('OUT')
  })
  it('编译 → 抛 CompiledLlmError(不 inline spawn)', async () => {
    const inline = vi.fn()
    const ev = makeCliSdkEval({ isCompiled: () => true, inline })
    await expect(ev('p')).rejects.toBeInstanceOf(CompiledLlmError)
    expect(inline).not.toHaveBeenCalled()
  })
})

describe('delegateMemoryOp', () => {
  it('POST 到 daemon 路由;成功透传', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, written: { path: '_overview.md' } }) }))
    const r = await delegateMemoryOp('synthesize', { chatId: 'a' }, {
      readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 't' }),
      fetch: fetchMock as any,
    })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9/v1/memory/synthesize', expect.objectContaining({ method: 'POST' }))
    expect((r as any).written.path).toBe('_overview.md')
  })
  it('daemon 未起 → {ok:false, error:daemon_required}', async () => {
    const r = await delegateMemoryOp('synthesize', {}, { readApiInfo: () => null, fetch: (async () => {}) as any })
    expect(r).toEqual({ ok: false, error: 'daemon_required' })
  })
})
