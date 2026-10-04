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

  it('serverOf returns the owning server for a listed tool and undefined for an unknown name', async () => {
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'x', args: [] } },
      { makeClient: async () => fakeClient([{ name: 'reply', description: 'r', inputSchema: { type: 'object' } }]) },
    )
    expect(bridge.serverOf('reply')).toBe('wechat')
    expect(bridge.serverOf('nope')).toBeUndefined()
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

// 2026-10-03 真机:openai 会话 spawn 时 8 个 MCP server 串行连,其中一个(wxvault 插件
// 在 daemon 里启动卡了 >60s)超时,就让 spawn 整个抛 `MCP error -32001: Request timed out`
// —— 主人的 openai 对话和 selftest 一起挂;claude 那边只是少了这个插件的工具。可选(插件)
// server 必须降级跳过;核心 server(wechat/delegate)起不来仍然整个失败。
describe('MCP tool bridge — optional servers degrade instead of failing the spawn', () => {
  const never = (): Promise<McpClientLike> => new Promise(() => {})

  it('skips an optional server that never finishes starting, within the startup budget', async () => {
    const skipped: string[] = []
    const started = Date.now()
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'wechat', args: [] }, wxvault: { command: 'wxvault', args: [] } },
      {
        makeClient: async (spec) => spec.command === 'wxvault' ? never() : fakeClient([{ name: 'reply', inputSchema: { type: 'object' } }]),
        isOptional: (name) => name !== 'wechat',
        startupTimeoutMs: 50,
        onSkip: (name, reason) => skipped.push(`${name}:${reason}`),
      },
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(bridge.tools.map(t => t.name)).toEqual(['reply'])
    expect(bridge.serverOf('reply')).toBe('wechat')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/^wxvault:.*50ms/)
    await bridge.close()
  })

  it('skips an optional server whose start throws, keeping the others', async () => {
    const skipped: string[] = []
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'wechat', args: [] }, wxsearch: { command: 'wxsearch', args: [] } },
      {
        makeClient: async (spec) => {
          if (spec.command === 'wxsearch') throw new Error('MCP error -32001: Request timed out')
          return fakeClient([{ name: 'reply', inputSchema: { type: 'object' } }])
        },
        isOptional: (name) => name !== 'wechat',
        onSkip: (name, reason) => skipped.push(`${name}:${reason}`),
      },
    )
    expect(bridge.tools.map(t => t.name)).toEqual(['reply'])
    expect(skipped).toEqual(['wxsearch:MCP error -32001: Request timed out'])
    await bridge.close()
  })

  it('closes an optional client that finishes starting only after it was given up on', async () => {
    let resolveLate!: (c: McpClientLike) => void
    let lateClosed = false
    const late: McpClientLike = { ...fakeClient([{ name: 'get_messages', inputSchema: {} }]), async close() { lateClosed = true } }
    const bridge = await createMcpToolBridge(
      { wechat: { command: 'wechat', args: [] }, wxvault: { command: 'wxvault', args: [] } },
      {
        makeClient: (spec) => spec.command === 'wxvault'
          ? new Promise<McpClientLike>(r => { resolveLate = r })
          : Promise.resolve(fakeClient([{ name: 'reply', inputSchema: {} }])),
        isOptional: (name) => name !== 'wechat',
        startupTimeoutMs: 20,
      },
    )
    resolveLate(late)
    await new Promise(r => setTimeout(r, 10))
    expect(lateClosed).toBe(true)
    expect(bridge.serverOf('get_messages')).toBeUndefined()
    await bridge.close()
  })

  it('a core (non-optional) server that cannot start still fails the whole bridge and closes the rest', async () => {
    let pluginClosed = false
    const plugin: McpClientLike = { ...fakeClient([{ name: 'search', inputSchema: {} }]), async close() { pluginClosed = true } }
    await expect(createMcpToolBridge(
      { wechat: { command: 'wechat', args: [] }, wxsearch: { command: 'wxsearch', args: [] } },
      {
        makeClient: async (spec) => spec.command === 'wechat' ? never() : plugin,
        isOptional: (name) => name !== 'wechat',
        startupTimeoutMs: 30,
      },
    )).rejects.toThrow(/wechat.*30ms/)
    expect(pluginClosed).toBe(true)
  })

  it('starts all servers concurrently (spawn latency = slowest server, not the sum)', async () => {
    const begun: string[] = []
    const gate: Array<() => void> = []
    const pending = createMcpToolBridge(
      { wechat: { command: 'wechat', args: [] }, a: { command: 'a', args: [] }, b: { command: 'b', args: [] } },
      {
        makeClient: (spec) => {
          begun.push(spec.command)
          return new Promise<McpClientLike>(r => gate.push(() => r(fakeClient([{ name: `t_${spec.command}`, inputSchema: {} }]))))
        },
        isOptional: (name) => name !== 'wechat',
      },
    )
    await new Promise(r => setTimeout(r, 5))
    expect(begun).toEqual(['wechat', 'a', 'b'])   // nobody waited for the previous one
    for (const g of gate) g()
    const bridge = await pending
    expect(bridge.tools.map(t => t.name)).toEqual(['t_wechat', 't_a', 't_b'])   // spec order kept
    await bridge.close()
  })
})
