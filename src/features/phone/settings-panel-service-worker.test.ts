import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { SW_JS } from './settings-panel-html'

describe('phone brand cache upgrades', () => {
  it.each(['/m/icon.png', '/m/manifest.json'])('replaces the old %s cache while retaining the paired interface offline without caching its credential', async (path) => {
    const url = `http://localhost${path}`
    const stores = new Map<string, Map<string, Response>>([
      ['cc-shell-v1', new Map([
        [url, new Response('old-bear-brand')],
        ['shell', new Response('<html><script>\nvar T = "dPRIVATE"\n</script><body>paired-offline-shell</body></html>')],
      ])],
    ])
    const handlers = new Map<string, (event: unknown) => void>()
    let online = true, currentBody = 'current-cc-brand'
    runInNewContext(SW_JS, {
      URL, Response,
      self: {clients:{claim:async()=>{}}, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
      fetch: async () => {
        if (!online) throw new Error('offline')
        return new Response(currentBody)
      },
      caches: {
        keys:async()=>[...stores.keys()],
        delete:async(name:string)=>stores.delete(name),
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

    let activation:Promise<unknown>|undefined
    handlers.get('activate')!({waitUntil:(p:Promise<unknown>)=>{activation=p}});await activation
    expect(stores.has('cc-shell-v1')).toBe(false)
    expect(await request(url, 'cors')).toBe('current-cc-brand')
    currentBody='<html><script>\nvar T = "dLIVE"\n</script><body>paired-offline-shell</body></html>'
    expect(await request('http://localhost/m', 'navigate')).toContain('dLIVE')
    let privateCached=false
    handlers.get('fetch')!({request:{url:'http://localhost/v1/matter/owner-chat/page',mode:'cors'},respondWith:()=>{privateCached=true}})
    expect(privateCached).toBe(false)
    online = false
    expect(await request(url, 'cors')).toBe('current-cc-brand')
    const offline=await request('http://localhost/m', 'navigate')
    expect(offline).toContain('paired-offline-shell')
    expect(offline).not.toContain('dPRIVATE')
    expect(offline).not.toContain('dLIVE')
    expect(offline).toContain('localStorage.getItem("deviceToken")')
    expect(stores.has('cc-shell-v1')).toBe(false)
  })
})
