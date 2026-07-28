import { afterEach, describe, expect, it, vi } from 'vitest'

const root = globalThis as unknown as { window?: unknown }
const originalWindow = root.window
const originalFetch = globalThis.fetch

afterEach(() => {
  if (originalWindow === undefined) delete root.window
  else root.window = originalWindow
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('invokeApi', () => {
  it('refreshes daemon discovery after a stale localhost port fails to connect', async () => {
    let credentialCalls = 0
    const invoke = vi.fn(async (_command: string, payload: { args: string[] }) => {
      if (payload.args[0] !== 'daemon' || payload.args[1] !== 'api-info') throw new Error('unexpected IPC command')
      credentialCalls += 1
      return {
        ok: true,
        baseUrl: credentialCalls === 1 ? 'http://127.0.0.1:54091' : 'http://127.0.0.1:60591',
        token: `token-${credentialCalls}`,
      }
    })
    root.window = { __TAURI__: { core: { invoke } } }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: [] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    vi.resetModules()
    const { invokeApi } = await import('./api.js')
    await expect(invokeApi('GET', '/v1/customer-review/contacts?query=x')).resolves.toEqual({ contacts: [] })

    expect(credentialCalls).toBe(2)
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://127.0.0.1:54091/v1/customer-review/contacts?query=x',
      'http://127.0.0.1:60591/v1/customer-review/contacts?query=x',
    ])
    expect(invoke).toHaveBeenLastCalledWith('wechat_cli_json', {
      args: ['daemon', 'api-info', '--json', '--operator'],
    })
  })

  it('does NOT replay a POST after a transport failure', async () => {
    // A transport rejection does not prove the daemon never acted, and this is
    // shared code: replaying would send the same pen-pal letter twice, run a
    // 60s memory synthesize twice, create two customer-review records.
    const invoke = vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:54091', token: 't' }))
    root.window = { __TAURI__: { core: { invoke } } }
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    vi.resetModules()
    const { invokeApi } = await import('./api.js')
    await expect(invokeApi('POST', '/v1/penpal/letters', { to: 'peer' })).rejects.toThrow(/Failed to fetch/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT replay a GET that was aborted by the timeout', async () => {
    // A timeout is the worst case to replay — the daemon is most likely still
    // working on the first request.
    const invoke = vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:54091', token: 't' }))
    root.window = { __TAURI__: { core: { invoke } } }
    const abort = new Error('The operation timed out.')
    abort.name = 'TimeoutError'
    const fetchMock = vi.fn().mockRejectedValue(abort)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    vi.resetModules()
    const { invokeApi } = await import('./api.js')
    await expect(invokeApi('GET', '/v1/memory/list')).rejects.toThrow(/timed out/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
