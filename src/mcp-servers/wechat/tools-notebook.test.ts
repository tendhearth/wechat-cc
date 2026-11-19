import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWechatMcpServer } from './server'

it.each([
  { tier: 'admin', owner: true, evaluation: false, visible: true },
  { tier: 'admin', owner: false, evaluation: false, visible: false },
  { tier: 'trusted', owner: true, evaluation: false, visible: false },
  { tier: 'guest', owner: true, evaluation: false, visible: false },
  { tier: 'admin', owner: true, evaluation: true, visible: false },
])('exposes the notebook only in authorized owner chats ($tier, owner=$owner, eval=$evaluation)', async options => {
  const request = vi.fn(async (_method: string, _path: string, _body?: unknown) => {
    return { ok: true } as never
  })
  const server = await createWechatMcpServer({ request }, { tier: options.tier, notebookOwner: options.owner, ...(options.evaluation ? { outputEvalTools: 'topic_search' } : {}) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'notebook-test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const tools = (await client.listTools()).tools.map(t => t.name).filter(name => name.startsWith('notebook_')).sort()
    expect(tools).toEqual(options.visible ? ['notebook_jot', 'notebook_read'] : [])
    if (options.visible) {
      expect((await client.callTool({ name: 'notebook_jot', arguments: { text: '种一排向日葵' } })).isError).not.toBe(true)
      expect(request).toHaveBeenCalledWith('POST', '/v1/notebook/chat/jot', { text: '种一排向日葵' })
      expect((await client.callTool({ name: 'notebook_read', arguments: { days: 61 } })).isError).toBe(true)
      expect((await client.callTool({ name: 'notebook_read', arguments: { days: 60, query: '%' } })).isError).not.toBe(true)
      expect(request).toHaveBeenCalledWith('POST', '/v1/notebook/chat/read', { days: 60, query: '%' })
    }
  } finally { await client.close(); await server.close() }
})
