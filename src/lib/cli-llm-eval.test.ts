import { describe, it, expect, vi } from 'vitest'
import { delegateMemoryOp } from './cli-llm-eval'

describe('delegateMemoryOp', () => {
  it('POST 到 daemon 路由;成功透传', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, written: { path: '_overview.md' } }) }))
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
  it('daemon 503 memory_not_wired → {ok:false, error:memory_not_wired}(不当假成功)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'memory_not_wired' }) }))
    const r = await delegateMemoryOp('synthesize', {}, {
      readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 't' }),
      fetch: fetchMock as any,
    })
    expect(r).toEqual({ ok: false, error: 'memory_not_wired' })
  })
  it('daemon 401 unauthorized → {ok:false, error:unauthorized}', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }))
    const r = await delegateMemoryOp('profile-generate', {}, {
      readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 't' }),
      fetch: fetchMock as any,
    })
    expect(r).toEqual({ ok: false, error: 'unauthorized' })
  })
  it('fetch 抛错(daemon 已死/端口过期) → {ok:false, error: could not reach daemon...}', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const r = await delegateMemoryOp('synthesize', {}, {
      readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 't' }),
      fetch: fetchMock as any,
    })
    expect((r as any).ok).toBe(false)
    expect((r as any).error).toMatch(/could not reach daemon/)
  })
})
