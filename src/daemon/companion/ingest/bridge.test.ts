import { describe, it, expect, vi } from 'vitest'
import { createResilientBridge } from './bridge'
import type { McpClientLike, McpStdioSpec } from '../../../core/openai-mcp-bridge'

// A fake client whose single tool name is carried in the spec's `command`.
function fakeClient(tool: string): McpClientLike {
  return {
    listTools: async () => ({ tools: [{ name: tool }] }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: `called:${name}` }] }),
    close: async () => {},
  }
}

describe('createResilientBridge', () => {
  it('skips a plugin that fails to connect, keeps the others', async () => {
    const specs: Record<string, McpStdioSpec> = {
      wxfacts: { command: 'extraction_batch', args: [] },
      wxsearch: { command: 'BAD', args: [] },       // this one throws on connect
      wxgraph: { command: 'rebuild', args: [] },
    }
    const logs: string[] = []
    const bridge = await createResilientBridge(specs, {
      log: (_t, m) => logs.push(m),
      makeClient: async (spec: McpStdioSpec) => {
        if (spec.command === 'BAD') throw new Error('Connection closed')
        return fakeClient(spec.command)
      },
    })
    const names = bridge.tools.map(t => t.name).sort()
    expect(names).toEqual(['extraction_batch', 'rebuild'])   // wxsearch's tool absent
    expect(logs.some(m => m.includes('wxsearch') && m.includes('skipped'))).toBe(true)
    // surviving tools are callable
    expect(await bridge.call('extraction_batch')).toBe('called:extraction_batch')
    // a tool from the failed plugin has no owner → rejects (never a silent hang)
    await expect(bridge.call('index_update')).rejects.toThrow(/no connected plugin/)
    await bridge.close()
  })

  it('returns an empty bridge (no throw) when every plugin fails', async () => {
    const bridge = await createResilientBridge(
      { a: { command: 'x', args: [] }, b: { command: 'y', args: [] } },
      { makeClient: async () => { throw new Error('down') } },
    )
    expect(bridge.tools).toEqual([])
    await expect(bridge.close()).resolves.toBeUndefined()
  })
})
