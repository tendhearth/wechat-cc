import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolSpec } from './openai-chat-model'
import { childEnvFor } from './mcp-stdio-spec'

export type { McpStdioSpec } from './mcp-stdio-spec'
import type { McpStdioSpec } from './mcp-stdio-spec'

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
  /**
   * The MCP server that owns `name` (the spec key passed to
   * `createMcpToolBridge`: `wechat`, `delegate`, or a plugin name), or
   * `undefined` when `name` isn't an MCP tool at all. Callers use this to
   * synthesize the real `mcp__<server>__<tool>` SDK name for tier
   * classification instead of assuming every MCP tool belongs to `wechat`.
   */
  serverOf(name: string): string | undefined
}

const EMPTY_SCHEMA = { type: 'object', properties: {} } as const

/**
 * Default per-server startup budget (spawn + `initialize` + `tools/list`).
 * Equal to the MCP SDK's own per-request default, so callers that don't opt
 * into anything keep the old ceiling; callers with optional servers pass a
 * tighter one (see `McpToolBridgeDeps`).
 */
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 60_000

async function connectStdio(spec: McpStdioSpec, opts: { timeoutMs: number }): Promise<McpClientLike> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: childEnvFor(spec),
  })
  const client = new Client({ name: 'wechat-openai-provider', version: '1.0.0' }, { capabilities: {} })
  // The SDK closes the transport (kills the child) itself when `initialize`
  // fails or times out; passing our budget makes that happen at OUR deadline
  // instead of the SDK's fixed 60s.
  await client.connect(transport, { timeout: opts.timeoutMs })
  return {
    listTools: () => client.listTools(undefined, { timeout: opts.timeoutMs }) as ReturnType<McpClientLike['listTools']>,
    callTool: (args) => client.callTool(args as Parameters<Client['callTool']>[0]) as ReturnType<McpClientLike['callTool']>,
    close: () => client.close(),
  }
}

export interface McpToolBridgeDeps {
  makeClient?: (spec: McpStdioSpec, opts: { timeoutMs: number }) => Promise<McpClientLike>
  /**
   * Servers for which a failed / too-slow start is NOT fatal: the bridge comes
   * up without their tools and reports them via `onSkip`. Default: none (every
   * server required — the old atomic behaviour, which callers like customer
   * review rely on). The openai provider marks third-party plugins optional:
   * 2026-10-03 the wxvault plugin took >60s to answer `initialize` inside the
   * daemon and every openai spawn (the owner's chat AND selftest) threw
   * `MCP error -32001: Request timed out`, while claude just ran without it.
   */
  isOptional?: (serverName: string) => boolean
  /** Per-server budget for spawn + initialize + tools/list. */
  startupTimeoutMs?: number
  onSkip?: (serverName: string, reason: string) => void
}

interface Started { client: McpClientLike; tools: { name: string; description?: string; inputSchema?: unknown }[] }

/**
 * Start one server, bounded by `timeoutMs`. If the deadline wins, a client
 * that still comes up later is closed the moment it does — a given-up server
 * must never leave an orphaned child process behind.
 */
function startServer(
  make: NonNullable<McpToolBridgeDeps['makeClient']>,
  name: string,
  spec: McpStdioSpec,
  timeoutMs: number,
): Promise<Started> {
  let gaveUp = false
  const attempt = (async (): Promise<Started> => {
    const client = await make(spec, { timeoutMs })
    if (gaveUp) { await client.close().catch(() => {}); throw new Error('abandoned') }
    try {
      const { tools } = await client.listTools()
      if (gaveUp) throw new Error('abandoned')
      return { client, tools }
    } catch (err) {
      await client.close().catch(() => {})
      throw err
    }
  })()
  attempt.catch(() => {}) // a loss after the deadline is handled inside `attempt`
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true
      reject(new Error(`mcp server "${name}" did not start within ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer))
}

export async function createMcpToolBridge(
  specs: Record<string, McpStdioSpec>,
  deps?: McpToolBridgeDeps,
): Promise<McpToolBridge> {
  const make = deps?.makeClient ?? connectStdio
  const isOptional = deps?.isOptional ?? (() => false)
  const timeoutMs = deps?.startupTimeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS
  const owners = new Map<string, McpClientLike>() // toolName → client
  const toolServer = new Map<string, string>() // toolName → owning server name (spec key)
  const clients: McpClientLike[] = []
  const tools: ToolSpec[] = []

  // All servers start concurrently: spawn latency is the slowest server, not
  // the sum of all of them (this used to be a sequential loop, so one slow
  // plugin also delayed every server after it).
  const entries = Object.entries(specs)
  const results = await Promise.allSettled(entries.map(([name, spec]) => startServer(make, name, spec, timeoutMs)))

  let fatal: unknown
  let failed = false
  results.forEach((r, i) => {
    const name = entries[i]![0]
    if (r.status === 'fulfilled') { clients.push(r.value.client); return }
    if (isOptional(name)) {
      deps?.onSkip?.(name, r.reason instanceof Error ? r.reason.message : String(r.reason))
    } else if (!failed) {
      failed = true
      fatal = r.reason
    }
  })
  if (failed) {
    // A required server is down. The McpToolBridge (which owns .close()) is
    // never returned, so close every server that DID come up before
    // rethrowing — otherwise their child processes are orphaned.
    await Promise.all(clients.map(c => c.close().catch(() => {})))
    throw fatal
  }

  // Walk in spec order, so tool order (and last-server-wins on duplicate
  // names) stays deterministic regardless of which server answered first.
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const serverName = entries[i]![0]
    for (const t of r.value.tools) {
      owners.set(t.name, r.value.client)
      toolServer.set(t.name, serverName) // last-server-wins on duplicate tool names
      tools.push({
        name: t.name,
        description: t.description ?? t.name,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { ...EMPTY_SCHEMA },
      })
    }
  })

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
    serverOf(name) {
      return toolServer.get(name)
    },
  }
}
