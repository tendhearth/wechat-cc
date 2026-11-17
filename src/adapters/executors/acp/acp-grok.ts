/**
 * Grok 账号 ACP 接线。所有进程只使用 CC 专属 HOME 内独立登录。
 * 不提供 cheapEval/strongEval，避免有限账号额度成为后台判断/故障转移候选。
 * 不注入 stdio MCP：initialize 仅声明 http/sse，CC 当前工具出口为 stdio。
 */
import type { AgentProvider } from '../../../ports/agent-provider'
import { createAcpProvider } from './acp-agent-provider'
import { NO_CC_MCP_INSTRUCTIONS } from '../../../domain/provider-capabilities'

export { ACP_GROK_CAPABILITIES } from '../../../domain/provider-capabilities'
export interface AcpGrokOptions {
  bin: string
  model?: string
  log: (tag: string, line: string) => void
  spawn?: typeof import('node:child_process').spawn
  workbench?: boolean
  stateDir?: string
}

export function createAcpGrokProvider(options: AcpGrokOptions): AgentProvider {
  const provider = createAcpProvider({
    command: options.bin, args: ['agent', '--no-leader', 'stdio'], displayName: 'Grok', targetProvider: 'grok',
    policyTarget: 'grok-acp', grokStateDir: options.stateDir, authMethod: 'cached_token', authErrorCode: 'grok_auth_required',
    permissions: options.workbench ? 'bridge' : 'mode', text: options.workbench ? 'append' : 'messages',
    resume: 'strict', notice: null, requireMcpCapabilities: true,
    mcpServers: context => { context.reportMatterTools?.(false); return [] },
    model: context => context.model ?? options.model,
    log: options.log, spawn: options.spawn,
  })
  return { ...provider, spawn: (project, context) => provider.spawn(project, { ...context, appendInstructions: [context.appendInstructions, NO_CC_MCP_INSTRUCTIONS].filter(Boolean).join('\n\n') }) }
}
