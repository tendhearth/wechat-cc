/**
 * 权限只编译一次(3c 最后一块,设计稿 docs/superpowers/specs/2026-10-22-policy-compile-design.md)。
 *
 * 档位(TIER_PROFILES / JOB_PROFILE / REVIEW_PROFILE)× 权限模式(strict / dangerously)翻成每家执行者实际的设置,
 * 以前每家各写一个翻译函数,散在各自的 provider 文件里(有的带 SDK 依赖,有的跟别处的说法对不上)。现在全在这一处,
 * 纯函数、零 SDK 依赖;provider 只读 `compilePolicy(...)` 的结果。36+ 格的全表由 policy.test.ts 快照钉住,
 * 哪一格变了 PR 里看得见。
 *
 * 第 1 步只是搬家 + 一个入口,行为不变:下面每家的翻译函数是从原文件逐字搬来的。
 * 缺口登记(档位说「问」、执行者做不到)和分派时拒,是第 2、3 步。
 */
import type { PermissionMode } from './permission-mode'
import { tierNameFromProfile, type TierProfile, type ToolKind } from './user-tier'

// ── claude(从 claude-agent-provider.ts 逐字搬来)
/**
 * Map ToolKind → the Claude Code built-in tool names that fall into it.
 * MCP tools (mcp__wechat__*) are NOT listed — they're gated by canUseTool
 * (a per-tool callback fires for every MCP invocation), which the
 * permission-relay layer sets up.
 */
const TOOL_KIND_TO_CLAUDE_BUILTINS: Record<ToolKind, ReadonlyArray<string>> = {
  reply: [],            // MCP-only
  share_page: [],       // MCP-only
  memory_read: [],      // MCP-only
  memory_write: [],     // MCP-only
  memory_delete: [],    // MCP-only
  observations_read: [],  // MCP-only
  observations_write: [], // MCP-only
  fs_read: ['Read', 'Glob', 'Grep', 'LS'],
  fs_write: ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'KillShell'],
  shell_destructive: [],   // virtual; same Bash tool, gated by canUseTool input inspection
  network: ['WebFetch', 'WebSearch'],
  subagent: ['Task'],
  a2a_send: [],            // MCP-only
  daemon_introspect: [],   // MCP-only (mcp__wechat__diagnostic_*), gated by canUseTool
  daemon_remediate: [],    // MCP-only (mcp__wechat__session_release / model_set / daemon_restart)
  file_locate: [],         // MCP-only (mcp__wechat__locate_file), gated by canUseTool
  plugin_tool: [],         // MCP-only (mcp__<plugin>__*), admin-only, gated by canUseTool
  social_seek: [],         // MCP-only (mcp__wechat__social_seek), admin-only, gated by canUseTool
  social_act: [],          // MCP-only (mcp__wechat__wish_list / wish_send / wish_cancel / intro_request / intro_accept / intro_decline / intro_offers / relationships / visit), admin-only, gated by canUseTool
  knowledge_search: [],    // MCP-only (mcp__wechat__knowledge_search), admin-only, gated by canUseTool
  federated_query: [],     // MCP-only (mcp__wechat__federated_query), admin-only, gated by canUseTool
  graph_query: [],         // MCP-only (mcp__wechat__contact_profile / top_contacts / relationship_subgraph / connectors / graph_status), admin-only, gated by canUseTool
  facts_query: [],         // MCP-only (mcp__wechat__extraction_batch / record_facts / contact_facts / find_facts / set_fact_status / extraction_status), admin-only, gated by canUseTool
  person_query: [],        // MCP-only (mcp__wechat__person_brief), admin-only, gated by canUseTool
  config_admin: [],        // MCP-only (mcp__wechat__config_get / config_set), admin-only, gated by canUseTool
  mode_switch: [],         // MCP-only (mcp__wechat__provider_switch), trusted+, gated by canUseTool
  message_other: [],       // MCP-only (mcp__wechat__message, 回复交付 §4.6), admin-only, gated by canUseTool
}

/**
 * 这一类工具是执行者**自己带的**(读写文件、命令、上网、子代理),而不是 wechat MCP / 插件 MCP 上的。
 * 按 Claude 内置工具的归类算(编码型 CLI 自带的就是这几样);shell_destructive 是 Bash 的一种用法,也算自带的。
 * enforcement-matrix 用它分清「靠 wechat MCP 按档注册」和「靠执行者自己」。
 */
export function isExecutorOwnKind(kind: ToolKind): boolean {
  return kind === 'shell_destructive' || TOOL_KIND_TO_CLAUDE_BUILTINS[kind].length > 0
}

export interface ClaudeTierSdkOpts {
  permissionMode: 'default' | 'bypassPermissions'
  disallowedTools?: string[]
}

/**
 * Pure translation from (TierProfile, permissionMode) → Claude SDK options.
 * The caller layers `canUseTool` on top of this — `disallowedTools` only
 * covers built-ins (which the SDK knows by name); MCP tools and
 * shell_destructive get filtered inside the canUseTool closure.
 *
 * `permissionMode='dangerously'` bypasses unconditionally — operator
 * opted into full SDK bypass regardless of tier. `permissionMode='strict'`
 * always uses `default` + canUseTool; tier-aware allow/relay/deny
 * decisions happen inside the canUseTool callback (see
 * `authorize` in domain/authorize.ts, called from permission-relay.ts). Pre-RFC-05 this function
 * inferred "dangerously-equivalent" from `relay.size === 0 && deny.size === 0`
 * (admin tier shape), which broke when admin tier policy changed (C4)
 * and when --dangerously didn't propagate to non-admin chats (C5).
 */
export function tierProfileToClaudeSdkOpts(tp: TierProfile, permissionMode: PermissionMode): ClaudeTierSdkOpts {
  if (permissionMode === 'dangerously') {
    return { permissionMode: 'bypassPermissions' }
  }

  // Build disallowedTools from the deny set's built-in tools only
  const disallowed: string[] = []
  for (const kind of tp.deny) {
    for (const name of TOOL_KIND_TO_CLAUDE_BUILTINS[kind]) disallowed.push(name)
  }

  return {
    permissionMode: 'default',
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  }
}

// ── codex(从已删的 codex-agent-provider.ts 逐字搬来;B1 起对话侧走 app-server,thread/start 的 sandbox / approvalPolicy 就是这两项)
/**
 * 档里不给网(审查轮 REVIEW_PROFILE、访客)⇒ 线程上把联网搜索关掉,不沿用主人 codex 配置里的默认(评审 #460)。
 * 沙箱网络不在这里设:不给网的档都是 read-only 沙箱,shell 本来就上不了网;而且会话不带 networkAccessEnabled
 * 是 e2e 假 codex 认出「这不是 cheapEval」的那根钉。
 */
export function codexNetworkOpts(tp: TierProfile): { webSearchEnabled?: false; webSearchMode?: 'disabled' } {
  return tp.deny.has('network') ? { webSearchEnabled: false, webSearchMode: 'disabled' } : {}
}

export interface CodexTierSdkOpts {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
}

/**
 * Pure translation from (TierProfile, permissionMode) → Codex SDK options.
 *
 * Codex has no per-tool callback equivalent to Claude's canUseTool.
 * Tier enforcement is therefore coarser:
 *   - `permissionMode='dangerously'` → full access on every chat (operator
 *     opted into bypass; tier doesn't matter)
 *   - admin → workspace-write sandbox + 'on-request'(主人 2026-10-26 点头:「Codex 对话逐条问」)。
 *     app-server 把它要批的命令 / 改文件 / MCP 调用发给客户端,对话侧逐条交给 authorize()(adapters/executors/codex/
 *     codex-chat-gate.ts):放行规则可以替主人放(回复里说一行),红线照旧问,其余经微信拍板卡问主人。没人可问的
 *     spawn(delegate、CLI 的一次性评估)在 codex-chat-provider 里落回 'never'。danger-full-access 仍只给 `--dangerously`。
 *   - trusted → workspace-write sandbox (no admin UI to field
 *     'on-request' prompts, so we use 'never' approval — destructive
 *     ops within the workspace cwd are still possible; documented
 *     limitation)
 *   - guest → read-only sandbox + untrusted approval (functionally
 *     restricted to reading + replying)
 *
 * Pre-RFC-05 this function ignored `permissionMode` entirely and
 * derived everything from `TierProfile` shape — which silently broke
 * the `--dangerously` operator override for non-admin chats (C5).
 */
export function tierProfileToCodexSdkOpts(tp: TierProfile, permissionMode: PermissionMode): CodexTierSdkOpts {
  if (permissionMode === 'dangerously') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  // strict mode. A profile that denies nothing AND relays nothing is the
  // full-bypass shape → danger-full-access.
  if (tp.deny.size === 0 && tp.relay.size === 0) {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  // Sandbox scope keys off what the tier can actually DO, not deny-set
  // cardinality: any tier that can write files and run shell (admin, trusted)
  // gets workspace-write; one that can't (guest — read/reply only) gets
  // read-only. The old `deny.size === 0` check mis-fired the moment a tier
  // denied a tool unrelated to fs/shell scope (e.g. the admin-only
  // daemon_introspect now in trusted.deny), collapsing trusted to read-only.
  if (tp.allow.has('fs_write') && tp.allow.has('shell')) {
    return { sandboxMode: 'workspace-write', approvalPolicy: tierNameFromProfile(tp) === 'admin' ? 'on-request' : 'never' }
  }
  return { sandboxMode: 'read-only', approvalPolicy: 'untrusted' }
}

// ── gemini(从 gemini-agent-provider.ts 逐字搬来)
export interface GeminiTierSdkOpts {
  /** strict ⇒ the per-tool gate runs; dangerously ⇒ operator bypassed everything. */
  gateEnabled: boolean
}

export function tierProfileToGeminiSdkOpts(_tp: TierProfile, permissionMode: PermissionMode): GeminiTierSdkOpts {
  return { gateEnabled: permissionMode !== 'dangerously' }
}

// ── cursor SDK 兜底(从 cursor-agent-provider.ts 逐字搬来)
export interface CursorTierSdkOpts {
  sandboxOptions: { enabled: boolean }
}

/**
 * Translate daemon TierProfile → Cursor SDK options.
 *
 * Heuristic: a profile with no relay and no deny is admin-equivalent
 * (sandbox off). Any non-empty relay or deny → enable sandbox. Matches
 * the same size-based heuristic Codex uses.
 *
 * Guest gets the same sandbox as trusted — Cursor lacks a read-only
 * mode, so guest can write inside cwd. Documented in README as a
 * known limitation; operators with strict guest separation route
 * guests to Claude.
 */
export function tierProfileToCursorSdkOpts(_tp: TierProfile, permissionMode: PermissionMode): CursorTierSdkOpts {
  // Cursor has no per-tool callback. The only knob is sandbox on/off.
  // Strict mode → always sandboxed (operator wanting unrestricted access
  // opts in via `--dangerously`). Pre-RFC-05 this varied by tier shape,
  // but post-C4 the "admin tier = no sandbox" shortcut conflated with
  // "admin can still call destructive Bash" — and cursor can't enforce
  // the relay, so the safer default is "sandboxed unless the operator
  // explicitly bypassed at daemon level".
  if (permissionMode === 'dangerously') {
    return { sandboxOptions: { enabled: false } }
  }
  return { sandboxOptions: { enabled: true } }
}

/** ACP Cursor(对话侧,`permissions:'mode'`):只看模式 —— dangerously 选放行项,否则选拒绝项。不看档位(稿 §2 第 4 条)。 */
export interface AcpModeAnswer { answer: 'allow' | 'reject' }
export function acpModeAnswer(_tp: TierProfile, permissionMode: PermissionMode): AcpModeAnswer {
  return { answer: permissionMode === 'dangerously' ? 'allow' : 'reject' }
}

/** agy:只有一个开关 —— dangerously ⇒ `--dangerously-skip-permissions`;MCP 由全局配置钉成 trusted,不随档位。 */
export interface AgyPermissionOpts { skipPermissions: boolean }
export function agyPermissionOpts(_tp: TierProfile, permissionMode: PermissionMode): AgyPermissionOpts {
  return { skipPermissions: permissionMode === 'dangerously' }
}

/**
 * openai 兼容(自研循环):逐工具闸门(openai-gate.ts 的 gateTool)按档位判;dangerously 全放。
 * `relayAs: 'deny'`:档位说「问」的,这一家现在一律拒、不问(稿 §6 第 6 步待主人点头)。
 */
export interface OpenaiGateOpts { bypass: boolean; relayAs: 'deny' }
export function openaiGateOpts(_tp: TierProfile, permissionMode: PermissionMode): OpenaiGateOpts {
  return { bypass: permissionMode === 'dangerously', relayAs: 'deny' }
}

/** 编译对象:按「怎么连的」分,不按 provider id —— cursor 有 ACP(生产)和 SDK 兜底两条路,翻法不同。 */
export type PolicyTarget = 'claude' | 'codex' | 'cursor-acp' | 'cursor-sdk' | 'openai' | 'gemini' | 'agy'
export interface ExecutorPolicySettings {
  claude: ClaudeTierSdkOpts
  codex: CodexTierSdkOpts & ReturnType<typeof codexNetworkOpts>
  'cursor-acp': AcpModeAnswer
  'cursor-sdk': CursorTierSdkOpts
  openai: OpenaiGateOpts
  gemini: GeminiTierSdkOpts
  agy: AgyPermissionOpts
}
export const POLICY_TARGETS: readonly PolicyTarget[] = ['claude', 'codex', 'cursor-acp', 'cursor-sdk', 'openai', 'gemini', 'agy']

/** 唯一入口:这一轮、这家执行者、这个档位和模式,实际用什么设置。 */
export function compilePolicy<T extends PolicyTarget>(target: T, tp: TierProfile, permissionMode: PermissionMode): ExecutorPolicySettings[T] {
  const compiled: { [K in PolicyTarget]: () => ExecutorPolicySettings[K] } = {
    claude: () => tierProfileToClaudeSdkOpts(tp, permissionMode),
    codex: () => ({ ...tierProfileToCodexSdkOpts(tp, permissionMode), ...codexNetworkOpts(tp) }),
    'cursor-acp': () => acpModeAnswer(tp, permissionMode),
    'cursor-sdk': () => tierProfileToCursorSdkOpts(tp, permissionMode),
    openai: () => openaiGateOpts(tp, permissionMode),
    gemini: () => tierProfileToGeminiSdkOpts(tp, permissionMode),
    agy: () => agyPermissionOpts(tp, permissionMode),
  }
  return compiled[target]() as ExecutorPolicySettings[T]
}
