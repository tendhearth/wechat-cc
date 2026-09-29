/**
 * wire-model-options.ts — 按 spawn 热读 agent-config 的模型选择 + Claude SDK 的
 * Options 组装(sdkOptionsForProject)。从 bootstrap/index.ts 逐字搬出(2026-09-27
 * bootstrap 拆分,spec 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,
 * 只参数化:deps.stateDir → ctx.stateDir;wire-plugins 的三个 spec、permissionMode /
 * buildCanUseTool(wire-permissions)、claudeBin 走 parts.*。
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderId } from '../../core/conversation'
import type { TierProfile } from '../../core/user-tier'
import type { PermissionMode } from '../../core/capability-matrix'
import { tierProfileToClaudeSdkOpts, DEFAULT_CLAUDE_MODEL } from '../../core/claude-agent-provider'
import { DEFAULT_AGY_MODEL } from '../../core/agy-agent-provider'
import { DEFAULT_CURSOR_MODEL } from '../../core/acp-cursor-chat'
import { makeMtimeCachedConfigReader, modelForProvider } from '../../lib/agent-config'
import type { Bootstrap, BootstrapCtx } from './types'
import type { PluginsSlice } from './wire-plugins'
import type { PermissionsSlice } from './wire-permissions'

export interface ModelOptionsSlice {
  readAgentConfig: ReturnType<typeof makeMtimeCachedConfigReader>
  currentClaudeModel: () => string
  currentModelFor: (providerId: ProviderId) => string | undefined
  sdkOptionsForProject: Bootstrap['sdkOptionsForProject']
}

export function wireModelOptions(
  ctx: Pick<BootstrapCtx, 'stateDir'>,
  parts: {
    plugins: Pick<PluginsSlice, 'wechatStdioForClaude' | 'delegateStdioForClaude' | 'pluginMcpForClaude'>
    permissionMode: PermissionMode
    buildCanUseTool: PermissionsSlice['buildCanUseTool']
    claudeBin: string | undefined
  },
): ModelOptionsSlice {
  // The model is re-read per spawn via an mtime-cached reader (one stat, parse
  // only on change) instead of being captured once. An operator's `/model`
  // switch rewrites agent-config.json, so the next session spawned in each chat
  // picks up the new model with NO daemon restart (an in-flight session keeps
  // its model until released). Claude reads `currentClaudeModel()` in its
  // Options builder; codex/cursor read `currentModelFor()` per spawn via
  // SpawnContext.model (session-manager forwards it) — all three hot-reload.
  const readAgentConfig = makeMtimeCachedConfigReader(ctx.stateDir)
  const currentClaudeModel = (): string => {
    const c = readAgentConfig()
    return c.provider === 'claude' && c.model ? c.model : DEFAULT_CLAUDE_MODEL
  }
  // Per-spawn pinned model, resolved PER provider id (not the global default).
  // `modelForProvider` owns the field rule: openai→openaiModel and
  // cursor→cursorModel resolve unconditionally (own field), while claude/codex
  // share `model` so it only applies when the global provider matches. This is
  // what lets `/api <model>` (which switches ONE chat to openai while the
  // global default may stay claude) hot-reload the openai model on the next
  // spawn with no restart. Read via the mtime-cached reader.
  const currentModelFor = (providerId: ProviderId): string | undefined => {
    const pinned = modelForProvider(readAgentConfig(), providerId)
    if (pinned !== undefined) return pinned
    // 没钉时报 provider 实际会用的默认值,而不是 undefined —— 这个值同时
    // 进系统提示(「当前模型 …」),说「provider 默认」不如说出真名。
    // claude 的默认在 currentClaudeModel();cursor/agy 与 providers.ts 里
    // 注册时的字面量一致(改那边记得改这边)。
    if (providerId === 'claude') return currentClaudeModel()
    if (providerId === 'cursor') return DEFAULT_CURSOR_MODEL
    if (providerId === 'agy') return DEFAULT_AGY_MODEL
    return undefined
  }

  const sdkOptionsForProject = (_alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string): Options => {
    // The per-session system prompt is assembled by the daemon's
    // `buildInstructions` thunk (see SessionManager wiring below) and arrives
    // here via SpawnContext — this builder no longer calls buildSystemPrompt,
    // so claude/codex share one provider-agnostic source.
    const systemPrompt = appendInstructions ?? ''
    // Per-session internal-api auth: merge the daemon-computed env overlay
    // (WECHAT_SESSION_TOKEN — the bearer the MCP children send — plus the
    // non-secret WECHAT_SESSION_TIER the wechat child gates admin tools on)
    // into the wechat + delegate children. session-manager builds this once;
    // every provider merges the same overlay, so the route layer enforces a
    // consistent tier across claude/codex/cursor.
    const sessionEnv = mcpEnv ?? {}
    const wechatEnv = parts.plugins.wechatStdioForClaude ? { ...parts.plugins.wechatStdioForClaude.env, ...sessionEnv } : undefined
    const delegateEnv = parts.plugins.delegateStdioForClaude ? { ...parts.plugins.delegateStdioForClaude.env, ...sessionEnv } : undefined
    const common: Options = {
      cwd: path,
      model: currentClaudeModel(),
      mcpServers: {
        ...(parts.plugins.wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...parts.plugins.wechatStdioForClaude, env: wechatEnv! } } : {}),
        ...(parts.plugins.delegateStdioForClaude ? { delegate: { type: 'stdio' as const, ...parts.plugins.delegateStdioForClaude, env: delegateEnv! } } : {}),
        ...parts.plugins.pluginMcpForClaude,
      },
      // Using preset+append (instead of raw string) keeps MCP tools inline in
      // the system prompt — otherwise they're deferred behind ToolSearch,
      // which adds a round-trip every time Claude wants to call `reply`
      // (~10-15s per inbound). Extra ~2-4k tokens per turn is a fair trade.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Drop 'user' from settingSources (2026-05-08): user-global
      // ~/.claude/settings.json is meant for the human's interactive CLI
      // — its `effortLevel`, `alwaysThinkingEnabled`, custom mcpServers,
      // model alias preferences (cf. opus[1m] / 404 incident driving
      // commit e6f40f5) shouldn't bleed into a long-running headless
      // daemon. project + local still load so a per-project .claude/
      // setup the user wires in CWD continues to work.
      settingSources: ['project', 'local'],
      ...(parts.claudeBin ? { pathToClaudeCodeExecutable: parts.claudeBin } : {}),
    }
    // Task 13 — SDK permission knobs derived from the spawn-time tierProfile
    // via the provider's pure translation helper. Pre-Task-13 this branched
    // on `deps.dangerouslySkipPermissions`; post-Task-13 that flag only
    // influences which tier is resolved (see the resolveTier closure in
    // makeCanUseTool above), and the SDK options follow the tier.
    //
    // canUseTool is always wired — even at admin tier the relay may need
    // to surface destructive-Bash or memory_delete prompts that the
    // matrix's per-tool askUser flag asks for. Under bypassPermissions the
    // SDK won't fire canUseTool; under default mode canUseTool is what
    // gates everything not statically excluded via disallowedTools.
    const tierOpts = tierProfileToClaudeSdkOpts(tierProfile, parts.permissionMode)
    // Build canUseTool with this session's chatId baked in. Done per-call
    // (not once at bootstrap) so concurrent sessions on different chats
    // each get a closure resolving tier/mode for their OWN chatId.
    const canUseTool = parts.buildCanUseTool(chatId)
    return {
      ...common,
      permissionMode: tierOpts.permissionMode,
      ...(tierOpts.disallowedTools ? { disallowedTools: tierOpts.disallowedTools } : {}),
      canUseTool,
    }
  }

  return { readAgentConfig, currentClaudeModel, currentModelFor, sdkOptionsForProject }
}
