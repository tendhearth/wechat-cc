import { describe, it, expect } from 'vitest'
import { createMcpToolBridge, type McpClientLike } from './openai-mcp-bridge'

function fakeClient(tools: { name: string; description?: string; inputSchema: unknown }[]): McpClientLike {
  return {
    async listTools() { return { tools } },
    async callTool({ name }: { name: string }) { return { content: [{ type: 'text', text: `ran:${name}` }] } },
    async close() {},
  }
}

describe('MCP tool bridge', () => {
  it('lists MCP tools as ToolSpecs and routes calls to the owning client', async () => {
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'x', args: [] } },
      { makeClient: async () => fakeClient([{ name: 'reply', description: 'r', inputSchema: { type: 'object' } }]) },
    )
    expect(bridge.tools.map(t => t.name)).toEqual(['reply'])
    expect(await bridge.call('reply', { text: 'hi' })).toBe('ran:reply')
    await bridge.close()
  })

  it('defaults a missing inputSchema to an empty object schema', async () => {
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'x', args: [] } },
      { makeClient: async () => fakeClient([{ name: 'ping', inputSchema: undefined as unknown }]) },
    )
    expect(bridge.tools[0]?.parameters).toEqual({ type: 'object', properties: {} })
    await bridge.close()
  })
})
