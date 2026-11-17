/**
 * Grok 账号 ACP 接线。所有进程只使用 CC 专属 HOME 内独立登录。
 * 不提供 cheapEval/strongEval，避免有限账号额度成为后台判断/故障转移候选。
 * CC stdio MCP 经每会话回环 HTTP 传输接入；agent 未声明 HTTP 时如实回退。
 */
import type { AgentProvider } from '../../../ports/agent-provider'
import { createAcpProvider, type AcpMcpSession } from './acp-agent-provider'
import { acpMcpServersFor } from './acp-cursor-chat'
import { createMcpHttpBridge } from './mcp-http-bridge'
import type { McpStdioSpec } from '../mcp-stdio-spec'
import type { MatterMcpFactory } from '../matter-mcp'
import { NO_CC_MCP_INSTRUCTIONS } from '../../../domain/provider-capabilities'
import { errorWithProviderCode } from '../../../lib/provider-error-code'

export { ACP_GROK_CAPABILITIES } from '../../../domain/provider-capabilities'
export interface AcpGrokOptions {
  bin: string
  model?: string
  log: (tag: string, line: string) => void
  spawn?: typeof import('node:child_process').spawn
  workbench?: boolean
  stateDir?: string
  mcpSpecs?: { wechat: McpStdioSpec | null; delegate: McpStdioSpec | null }
  matterMcp?: MatterMcpFactory
  /** System-boundary injection for offline tests; never shares Grok's CLI spawn. */
  bridge?: typeof createMcpHttpBridge
  /** Injected by daemon/workbench; HEAD reachability with the shared 60s/15s cache. */
  networkPreflight: () => Promise<boolean>
  promptIdleTimeoutMs?: number
  cancelGraceMs?: number
}

export function createAcpGrokProvider(options: AcpGrokOptions): AgentProvider {
  const provider = createAcpProvider({
    command: options.bin, args: ['agent', '--no-leader', 'stdio'], displayName: 'Grok', targetProvider: 'grok',
    policyTarget: 'grok-acp', grokStateDir: options.stateDir, authMethod: 'cached_token', authErrorCode: 'grok_auth_required',
    permissions: options.workbench ? 'bridge' : 'mode', text: options.workbench ? 'append' : 'messages',
    resume: 'strict', notice: null,
    prepareMcp: async (context, initialized, project): Promise<AcpMcpSession> => {
      const fallback = (): AcpMcpSession => {
        context.reportMatterTools?.(false)
        return { servers: [], active: false, close: async () => {}, redact: line => line, supportsDelegation: false,
          instructions: context.oneoff ? [context.appendInstructions, NO_CC_MCP_INSTRUCTIONS].filter(Boolean).join('\n\n')
            : context.instructionsForMcp?.({ wechat: false, delegate: false }) ?? (options.workbench ? [context.appendInstructions, NO_CC_MCP_INSTRUCTIONS].filter(Boolean).join('\n\n') : NO_CC_MCP_INSTRUCTIONS) }
      }
      const caps = (initialized as { agentCapabilities?: { mcpCapabilities?: { http?: boolean } } })?.agentCapabilities?.mcpCapabilities
      if (caps?.http !== true || context.oneoff) return fallback()
      let startedBridge: Awaited<ReturnType<typeof createMcpHttpBridge>> | undefined
      try {
        const matter = options.workbench ? options.matterMcp?.(context) : undefined
        const specs: Record<string, McpStdioSpec | null> = options.workbench ? (matter ? { 'wechat-cc-matter': matter } : {}) : options.mcpSpecs ?? {}
        const servers = acpMcpServersFor(specs, context.mcpEnv)
        if (!servers.length) return fallback()
        const bridge = startedBridge = await (options.bridge ?? createMcpHttpBridge)(servers, { cwd: project.path, signal: context.preparationSignal, log: options.log })
        if (!bridge.active) { await bridge.close(); return fallback() }
        const available = { wechat: servers.some(s => s.name === 'wechat'), delegate: servers.some(s => s.name === 'delegate') }
        context.reportMatterTools?.(!!matter)
        return { ...bridge, get active() { return bridge.active }, supportsDelegation: available.delegate, fallback,
          instructions: options.workbench ? context.appendInstructions : context.instructionsForMcp?.(available) ?? context.appendInstructions }
      } catch {
        await startedBridge?.close().catch(() => {})
        options.log('MCP', 'Grok MCP injection unavailable; continuing without tools')
        return fallback()
      }
    },
    model: context => context.model ?? options.model,
    log: options.log, spawn: options.spawn,
    preflight: async () => {
      let reachable = false
      try { reachable = await options.networkPreflight() } catch { /* Fail closed, never spawn/retry. */ }
      if (!reachable) throw errorWithProviderCode('grok_network_unavailable', 'network')
    },
    promptIdleTimeoutMs: options.promptIdleTimeoutMs ?? 90_000,
    cancelGraceMs: options.cancelGraceMs ?? 5_000,
  })
  return provider
}
