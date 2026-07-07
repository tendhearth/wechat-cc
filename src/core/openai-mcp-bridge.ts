import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolSpec } from './openai-chat-model'

export interface McpStdioSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Minimal surface of the MCP client we depend on — lets tests inject a fake. */
export interface McpClientLike {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>
  callTool(args: { name: string; arguments?: unknown }): Promise<{ content: { type: string; text?: string }[] }>
  close(): Promise<void>
}

export interface McpToolBridge {
  tools: ToolSpec[]
  call(name: string, input: unknown): Promise<string>
  close(): Promise<void>
}

const EMPTY_SCHEMA = { type: 'object', properties: {} } as const

async function connectStdio(spec: McpStdioSpec): Promise<McpClientLike> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
  })
  const client = new Client({ name: 'wechat-openai-provider', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client as unknown as McpClientLike
}

export async function createMcpToolBridge(
  specs: Record<string, McpStdioSpec>,
  deps?: { makeClient?: (spec: McpStdioSpec) => Promise<McpClientLike> },
): Promise<McpToolBridge> {
  const make = deps?.makeClient ?? connectStdio
  const owners = new Map<string, McpClientLike>() // toolName → client
  const clients: McpClientLike[] = []
  const tools: ToolSpec[] = []

  for (const spec of Object.values(specs)) {
    const client = await make(spec)
    clients.push(client)
    const { tools: mcpTools } = await client.listTools()
    for (const t of mcpTools) {
      owners.set(t.name, client)
      tools.push({
        name: t.name,
        description: t.description ?? t.name,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { ...EMPTY_SCHEMA },
      })
    }
  }

  return {
    tools,
    async call(name, input) {
      const client = owners.get(name)
      if (!client) throw new Error(`mcp bridge: no server owns tool ${name}`)
      const res = await client.callTool({ name, arguments: input ?? {} })
      return res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    },
    async close() {
      await Promise.all(clients.map(c => c.close().catch(() => {})))
    },
  }
}
