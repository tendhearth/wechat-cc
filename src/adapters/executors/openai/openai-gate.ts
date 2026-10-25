/**
 * Tier gate for the `openai` provider's tool loop.
 *
 * The openai tool loop (a later task) owns permission gating for each tool
 * call it is about to execute. This module does NOT invent a new policy
 * engine — it reuses the existing daemon-wide tier machinery in
 * `./user-tier`: `classifyToolUse(sdkToolName, input)` maps a tool call to a
 * `ToolKind`, and the caller's resolved `TierProfile` (`allow` / `relay` /
 * `deny` sets) decides what happens to that kind.
 *
 * v1: mid-turn WeChat confirmation for `relay`-classified tools is deferred
 * to a follow-up task, so under `permissionMode === 'strict'` a relay tool
 * collapses to `deny` rather than prompting. Under `permissionMode ===
 * 'dangerously'` every tool call is allowed, matching the daemon-wide
 * `--dangerously` bypass used by every other provider (see
 * `resolveEffectiveTier` in `./user-tier`).
 *
 * See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
 */
import { classifyToolUse, type TierProfile } from '../../../domain/user-tier'
import type { PermissionMode } from '../../../ports/agent-provider'
import { authorizeChatCall, type ChatOwnerRules } from '../../../core/permission-rules/chat'

export type GateDecision = 'allow' | 'deny'

/** 放和拒之外,规则拒绝时交给模型的话(和终端 / 一起做一样,拒绝的理由让执行者看得见)。 */
export interface GateResult { decision: GateDecision; message?: string }

export async function gateTool(args: {
  toolName: string
  /**
   * The REAL MCP server that owns this tool call (from
   * `McpToolBridge.serverOf`), or `undefined` for a built-in tool. Must be
   * the actual owning server — never assume `wechat` for every MCP tool,
   * or a same-named tool from another server (a plugin, `delegate`, …)
   * gets misclassified as the wechat tool of that name, which can
   * escalate a guest-denied tool into a guest-allowed one.
   */
  mcpServer?: string
  input: Record<string, unknown>
  tierProfile: TierProfile
  permissionMode: PermissionMode
  /** 这个会话的对话(主人自己的对话才看放行规则)。 */
  chatId: string
  /** 主人自己的对话走放行规则(2026-10-25,core/permission-rules/chat.ts)。不给 ⇒ 不看规则(问照旧落成拒)。 */
  ownerRules?: ChatOwnerRules | null
}): Promise<GateResult> {
  // 判定只在 domain/authorize.ts(架构终态 C2):旁路(dangerously,openaiGateOpts.bypass)→ 档位 × 类别(openai 不看
  // 能力表,它没有 per-tool 的那一档)→ 问不了(relayAs:'deny',v1 中途微信确认还没做)。主人自己的对话里,「问落成拒」之前
  // 先过放行规则(2026-10-25):规则明说放 ⇒ 放(回复里带一行),明说拒 ⇒ 拒,别的照旧拒。
  //
  // classifyToolUse recognizes wechat MCP tools by their SDK-prefixed name
  // (`mcp__wechat__<name>`); built-in tools (Read/Write/Edit/Bash/...) pass
  // through unchanged. Other MCP servers get their own `mcp__<server>__<name>`
  // prefix, which classifyToolUse does NOT special-case — it falls through to
  // the fail-safe default ('subagent'), never the wechat tool's kind.
  const sdkName = args.mcpServer ? `mcp__${args.mcpServer}__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)
  const auth = await authorizeChatCall(
    { tier: args.tierProfile, permissionMode: args.permissionMode, executor: 'openai' },
    { name: sdkName, kind },
    { chatId: args.chatId, provider: 'openai', tool: sdkName, input: args.input },
    args.ownerRules ?? null,
  )
  // chat 面上不会落成「问」(relayAs 是 deny);万一以后放开了而这里没跟着改,宁可拒。
  if (auth.verdict === 'allow') return { decision: 'allow' }
  return auth.denyMessage ? { decision: 'deny', message: auth.denyMessage } : { decision: 'deny' }
}
