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
})
