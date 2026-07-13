/**
 * Provider-agnostic grounded social judge. The judge decides whether an inbound
 * intent matches the owner; "grounded" = it can call the wx* plugin MCP tools
 * to read real facts. Only the CONSTRUCTION of the judge provider is
 * provider-specific — the spawn/collect path and the SOCIAL_JUDGE_PROFILE +
 * plugins-only isolation are shared. Returns null when no grounded adapter
 * fits the provider (caller falls back to cheapEval).
 */
import type { AgentProvider } from '../../core/agent-provider'
import { collectTurn } from '../../core/agent-provider'
import type { ProviderId } from '../../core/conversation'
import { SOCIAL_JUDGE_PROFILE } from '../../core/user-tier'
import type { McpStdioSpec } from '../bootstrap/mcp-specs'

export interface GroundedJudgeDeps {
  providerId: ProviderId
  pluginMcp: Record<string, McpStdioSpec>
  stateDir: string
  log: (tag: string, msg: string) => void
  openai?: { apiKey: string; baseUrl: string; model: string }
  claude?: { model: () => string; claudeBin?: string }
}

export type JudgeRunTurn = (systemPrompt: string, userPrompt: string) => Promise<string>

/**
 * Wrap a plugins-only judge provider in the shared one-shot runTurn: spawn a
 * constrained `_social_judge` session (SOCIAL_JUDGE_PROFILE + strict), dispatch
 * the userPrompt, collect assistant text, close. Fresh session per call.
 */
function runTurnVia(provider: AgentProvider, stateDir: string): JudgeRunTurn {
  return async (systemPrompt, userPrompt) => {
    let session: Awaited<ReturnType<AgentProvider['spawn']>> | null = null
    try {
      session = await provider.spawn(
        { alias: '_social_judge', path: stateDir },
        {
          // NOT TIER_PROFILES.guest: classifyToolUse buckets every
          // plugin MCP tool (the wx* fact tools this judge exists to
          // call) as `plugin_tool`, which guest denies — the judge
          // would get "Permission denied" on every call and silently
          // degrade to topic-text-only grounding (T7b-core review).
          // NOT TIER_PROFILES.admin either: admin denies nothing, so
          // it would also unlock this session's builtin Read/Write/
          // Bash/WebFetch/subagent tools. SOCIAL_JUDGE_PROFILE allows
          // ONLY plugin_tool — exactly the wx* facts, nothing else.
          tierProfile: SOCIAL_JUDGE_PROFILE,
          permissionMode: 'strict',
          chatId: '_social_judge',
          appendInstructions: systemPrompt,
        },
      )
      const result = await collectTurn(session.dispatch(userPrompt))
      return result.assistantText.join('')
    } finally {
      if (session) { try { await session.close() } catch { /* swallow shutdown errors */ } }
    }
  }
}

/** openai adapter — plugins-only, no wechat/delegate. Lifted from bootstrap. */
function buildOpenaiJudgeProvider(deps: GroundedJudgeDeps): AgentProvider | null {
  const o = deps.openai
  if (!o) return null
  // Dynamic imports mirror the original bootstrap block (keeps the openai loop
  // out of the daemon's startup path when social is off).
  return {
    async spawn(project, ctx) {
      const { createOpenAiAgentProvider } = await import('../../core/openai-agent-provider')
      const { createAiSdkChatModel } = await import('../../core/openai-chat-model')
      const { createMcpToolBridge } = await import('../../core/openai-mcp-bridge')
      const { buildOpenaiMcpSpecs } = await import('../bootstrap/mcp-specs')
      const provider = createOpenAiAgentProvider({
        makeChatModel: (model) => createAiSdkChatModel({ baseURL: o.baseUrl, apiKey: o.apiKey, model: model ?? o.model }),
        makeMcpBridge: async (sessionEnv) => createMcpToolBridge(
          buildOpenaiMcpSpecs({ wechat: null, delegate: null, pluginMcp: deps.pluginMcp }, sessionEnv),
        ),
        log: deps.log,
      })
      return provider.spawn(project, ctx)
    },
  }
}

/** claude adapter — plugins-only, no wechat/delegate. */
function buildClaudeJudgeProvider(deps: GroundedJudgeDeps): AgentProvider | null {
  const c = deps.claude
  if (!c) return null
  const pluginMcpForClaude = Object.fromEntries(
    Object.entries(deps.pluginMcp).map(([k, s]) => [k, { type: 'stdio' as const, ...s }]),
  )
  return {
    async spawn(project, ctx) {
      const { createClaudeAgentProvider, buildClaudeJudgeOptions } = await import('../../core/claude-agent-provider')
      const provider = createClaudeAgentProvider({
        sdkOptionsForProject: buildClaudeJudgeOptions({ pluginMcpForClaude, model: c.model(), claudeBin: c.claudeBin }),
        ...(c.claudeBin ? { claudeBin: c.claudeBin } : {}),
      })
      return provider.spawn(project, ctx)
    },
  }
}

export function makeGroundedJudgeRunTurn(deps: GroundedJudgeDeps): JudgeRunTurn | null {
  let provider: AgentProvider | null = null
  if (deps.providerId === 'openai') provider = buildOpenaiJudgeProvider(deps)
  else if (deps.providerId === 'claude') provider = buildClaudeJudgeProvider(deps)
  if (!provider) return null
  return runTurnVia(provider, deps.stateDir)
}
