import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildFederatedServer, mintAdminToken } from './federated-source'
import type { InternalApiClient } from './client'

// A fake InternalApiClient whose request() returns fake semantic results in the
// shape registerFederatedQueryTool expects ({ results: SemanticSearchResultItem[] }).
function fakeClient(): InternalApiClient {
  return {
    request: vi.fn(async () => ({ results: [
      { text: 'hi from wechat about atlas', conversation: 'chat1', sender: 'A', time: 1_700_000_000 },
    ] })),
  } as unknown as InternalApiClient
}

describe('buildFederatedServer', () => {
  it('exposes ONLY federated_query and returns hearth-shaped hits', async () => {
    const server = buildFederatedServer(fakeClient())
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['federated_query'])
    const res: any = await client.callTool({ name: 'federated_query', arguments: { question: 'atlas' } })
    const parsed = JSON.parse(res.content[0].text)
    expect(Array.isArray(parsed.hits)).toBe(true)
    expect(typeof parsed.hits[0].claim_text).toBe('string')
    await client.close()
  })
})

describe('mintAdminToken', () => {
  it('POSTs to /v1/federation/mint with the operator token and returns the token', async () => {
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(url).toContain('/v1/federation/mint')
      expect(init.headers.Authorization).toBe('Bearer op-token')
      return new Response(JSON.stringify({ token: 'admin-tok' }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await mintAdminToken('http://127.0.0.1:1/', 'op-token', fetchImpl)).toBe('admin-tok')
  })
  it('throws on non-200 (e.g. 403 no grant)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'federation_not_authorized' }), { status: 403 })) as unknown as typeof fetch
    await expect(mintAdminToken('http://x', 'op', fetchImpl)).rejects.toThrow(/mint failed: 403/)
  })
})
