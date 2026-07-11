/**
 * Resilient MCP bridge for the ingestion engine.
 *
 * `createMcpToolBridge` connects to ALL specs atomically — one plugin failing
 * to spawn (e.g. a heavy model-loading server that crashes on startup) rejects
 * the whole call. Ingestion must not lose its entire cycle because one optional
 * source is down: it connects to each plugin INDEPENDENTLY, skips the ones that
 * fail (logged), and exposes a combined bridge over whatever came up. So a dead
 * wxsearch/wxmedia still lets wxvault + wxgraph + wxfacts do their work.
 */
import { createMcpToolBridge, type McpStdioSpec, type McpClientLike, type McpToolBridge } from '../../../core/openai-mcp-bridge'

export interface ResilientBridge {
  tools: Array<{ name: string }>
  call: (name: string, input?: unknown) => Promise<string>
  close: () => Promise<void>
}

export async function createResilientBridge(
  specs: Record<string, McpStdioSpec>,
  opts?: { log?: (tag: string, msg: string) => void; makeClient?: (spec: McpStdioSpec) => Promise<McpClientLike> },
): Promise<ResilientBridge> {
  const bridges: McpToolBridge[] = []
  const owner = new Map<string, McpToolBridge>()
  const tools: Array<{ name: string }> = []

  for (const [name, spec] of Object.entries(specs)) {
    try {
      const b = await createMcpToolBridge({ [name]: spec }, opts?.makeClient ? { makeClient: opts.makeClient } : undefined)
      bridges.push(b)
      for (const t of b.tools) {
        tools.push({ name: t.name })
        owner.set(t.name, b)   // last-wins on duplicate tool names, same as createMcpToolBridge
      }
    } catch (err) {
      opts?.log?.('INGEST', `plugin "${name}" unavailable this cycle (skipped): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    tools,
    call: (name, input) => {
      const b = owner.get(name)
      if (!b) return Promise.reject(new Error(`no connected plugin owns tool ${name}`))
      return b.call(name, input)
    },
    close: async () => { await Promise.all(bridges.map(b => b.close().catch(() => {}))) },
  }
}
