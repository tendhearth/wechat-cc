import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { SW_JS } from './settings-panel-html'

describe('phone brand cache upgrades', () => {
  it.each(['/m/icon.png', '/m/manifest.json'])('replaces the old %s cache while retaining the paired shell offline', async (path) => {
    const url = `http://localhost${path}`
    const stores = new Map<string, Map<string, Response>>([
      ['cc-shell-v1', new Map([
        [url, new Response('old-bear-brand')],
        ['shell', new Response('paired-offline-shell')],
      ])],
    ])
    const handlers = new Map<string, (event: unknown) => void>()
    let online = true
    runInNewContext(SW_JS, {
      URL, Response,
      self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
      fetch: async () => {
        if (!online) throw new Error('offline')
        return new Response('current-cc-brand')
      },
      caches: {
        open: async (name: string) => {
          let entries = stores.get(name)
          if (!entries) { entries = new Map(); stores.set(name, entries) }
          const key = (request: string | { url: string }) => typeof request === 'string' ? request : request.url
          return {
            match: async (request: string | { url: string }) => entries.get(key(request))?.clone(),
            put: async (request: string | { url: string }, response: Response) => { entries.set(key(request), response) },
          }
        },
      },
    })
    async function request(url: string, mode: string): Promise<string> {
      let response: Promise<Response> | undefined
      handlers.get('fetch')!({ request: { url, mode }, respondWith: (result: Promise<Response>) => { response = result } })
      expect(response).toBeDefined()
      return (await response!).text()
    }

    expect(await request(url, 'cors')).toBe('current-cc-brand')
    online = false
    expect(await request(url, 'cors')).toBe('current-cc-brand')
    expect(await request('http://localhost/m', 'navigate')).toBe('paired-offline-shell')
  })
})
