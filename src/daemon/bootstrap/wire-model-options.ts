/**
 * wire-model-options.ts — 按 spawn 热读 agent-config 的模型选择 + Claude SDK 的
 * Options 组装(sdkOptionsForProject)。从 bootstrap/index.ts 逐字搬出(2026-09-27
 * bootstrap 拆分,spec 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,
 * 只参数化:deps.stateDir → ctx.stateDir;wire-plugins 的三个 spec、permissionMode /
 * buildCanUseTool(wire-permissions)、claudeBin 走 parts.*。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { floorReason } from '../../adapters/permission-rules/floor'
import { pathsUnder } from '../../adapters/permission-rules/paths'
import { toolInputFacts } from '../../domain/permission-rules/facts'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderId } from '../../domain/conversation'
import { TIER_PROFILES, classifyToolUse, type TierProfile } from '../../domain/user-tier'
import { authorize } from '../../domain/authorize'
import type { PermissionMode } from '../../domain/capability-matrix'
import { DEFAULT_CLAUDE_MODEL } from '../../adapters/executors/claude/claude-agent-provider'
import { compilePolicy } from '../../domain/policy'
import { DEFAULT_AGY_MODEL } from '../../adapters/executors/agy/agy-agent-provider'
import { DEFAULT_CURSOR_MODEL } from '../../adapters/executors/acp/acp-cursor-chat'
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

  const sdkOptionsForProject = (_alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string, spawnContext?: { permissionMode: PermissionMode }): Options => {
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
    // 非标准档(目前只有定时任务的只读档 JOB_PROFILE):不挂第三方插件与 delegate,canUseTool 按这一档判 ——
    // buildCanUseTool 是按 chatId 取档的,对主人永远是 admin(定时任务 10-20 终审)。
    const standardTier = (Object.values(TIER_PROFILES) as TierProfile[]).includes(tierProfile)
    const wechatEnv = parts.plugins.wechatStdioForClaude ? { ...parts.plugins.wechatStdioForClaude.env, ...sessionEnv } : undefined
    const delegateEnv = parts.plugins.delegateStdioForClaude ? { ...parts.plugins.delegateStdioForClaude.env, ...sessionEnv } : undefined
    const common: Options = {
      cwd: path,
      model: currentClaudeModel(),
      mcpServers: {
        ...(parts.plugins.wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...parts.plugins.wechatStdioForClaude, env: wechatEnv! } } : {}),
        ...(standardTier && parts.plugins.delegateStdioForClaude ? { delegate: { type: 'stdio' as const, ...parts.plugins.delegateStdioForClaude, env: delegateEnv! } } : {}),
        ...(standardTier ? parts.plugins.pluginMcpForClaude : {}),
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
    // 用**这一次** spawn 的权限模式(安全 10-20):session-manager 传进来的是 effectivePermissionMode 压过的
    // (访客 / 定时任务 ⇒ strict);以前这里读的是开机时的全局模式,访客在 dangerously 的 daemon 下照样拿到
    // bypassPermissions —— canUseTool 不触发、也没有 disallowedTools。没有 spawnContext(老调用点)⇒ 全局模式。
    const tierOpts = compilePolicy('claude', tierProfile, spawnContext?.permissionMode ?? parts.permissionMode)
    // Build canUseTool with this session's chatId baked in. Done per-call
    // (not once at bootstrap) so concurrent sessions on different chats
    // each get a closure resolving tier/mode for their OWN chatId.
    const canUseTool = standardTier ? parts.buildCanUseTool(chatId) : profileGate(tierProfile, { root: path, stateDir: ctx.stateDir })
    return {
      ...common,
      permissionMode: tierOpts.permissionMode,
      ...(tierOpts.disallowedTools ? { disallowedTools: tierOpts.disallowedTools } : {}),
      canUseTool,
    }
  }

  return { readAgentConfig, currentClaudeModel, currentModelFor, sdkOptionsForProject }
}

/**
 * 只按这一档判的 canUseTool(定时任务的只读档):分类落在 allow 里才放,其余一律拒、不弹卡(没人看着)。
 * 未知工具分类为 subagent ⇒ 被拒。再加两条(wechat-cc-2a 审 #408:无人看着 + 私密数据 + 外传通道):
 *   - 读文件只限这一轮的项目目录,碰到放行规则的红线(密钥、CC 的状态目录)一律拒;
 *   - 污点:这一轮一旦读过本机的东西(文件 / 记忆 / 观察),之后就不再上网 —— 被注入的网页没法把读到的拼进 URL 带走。
 * 每次 spawn 一个新闸门,污点不跨轮。
 */
function profileGate(tp: TierProfile, scope: { root: string; stateDir: string }): NonNullable<Options['canUseTool']> {
  let tainted = false
  const deny = (toolName: string, why: string) => ({ behavior: 'deny' as const, message: `这一轮是只读的定时任务,不能用 ${toolName}(${why})。` })
  return async (toolName, input) => {
    const args = (input ?? {}) as Record<string, unknown>
    const kind = classifyToolUse(toolName, args)
    // 判定只在 domain/authorize.ts(架构终态 C2,面 = job):不在档里 → 读过本机后上网 → 读文件的范围与红线。
    // 这里只算要碰路径的事实(项目目录、红线要 node:path / homedir),怎么组合成放 / 拒在那边。
    let readScope: { pathless: boolean; outside: boolean; redLine: string | null } | undefined
    if (kind === 'fs_read' && tp.allow.has(kind)) {
      const facts = toolInputFacts(args)
      const glob = typeof args.pattern === 'string' && isAbsolute(args.pattern) ? [args.pattern] : []
      const paths = [...facts.paths, ...glob].map(p => (isAbsolute(p) ? p : join(scope.root, p)))
      const pathless = toolName.startsWith('mcp__') && paths.length === 0
      const outside = !pathless && paths.length > 0 && !pathsUnder(paths, scope.root)
      const redLine = pathless || outside ? null : floorReason({ surface: 'workbench', provider: 'job', tool: 'Read', paths, cwd: scope.root, project: scope.root, isolatedWorktree: false, tier: 'admin', scope: 'job' }, homedir(), { stateDir: scope.stateDir })
      readScope = { pathless, outside, redLine }
    }
    const auth = authorize({ surface: 'job', tier: tp, permissionMode: 'strict', executor: 'claude' }, { name: toolName, kind }, { tainted, ...(readScope ? { readScope } : {}) })
    switch (auth.reason) {
      case 'job_profile': return deny(toolName, '不在只读档里')
      case 'job_tainted': return deny(toolName, '这一轮已经读过本机的东西,不再上网')
      case 'job_pathless': return deny(toolName, '没有路径')
      case 'job_outside': return deny(toolName, '只能读这个项目目录里的文件')
      case 'job_red_line': return deny(toolName, auth.detail ?? '')
    }
    if (auth.verdict !== 'allow') return deny(toolName, '不在只读档里')
    if (kind === 'fs_read' || kind === 'memory_read' || kind === 'observations_read') tainted = true
    return { behavior: 'allow', updatedInput: input }
  }
}
