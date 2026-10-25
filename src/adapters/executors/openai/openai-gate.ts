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
import { authorize } from '../../../domain/authorize'

export type GateDecision = 'allow' | 'deny'

export function gateTool(args: {
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
}): GateDecision {
  // 判定只在 domain/authorize.ts(架构终态 C2):旁路(dangerously,openaiGateOpts.bypass)→ 档位 × 类别(openai 不看
  // 能力表,它没有 per-tool 的那一档)→ 问不了(relayAs:'deny',v1 中途微信确认还没做)。面是 chat ⇒ 放行规则不看。
  //
  // classifyToolUse recognizes wechat MCP tools by their SDK-prefixed name
  // (`mcp__wechat__<name>`); built-in tools (Read/Write/Edit/Bash/...) pass
  // through unchanged. Other MCP servers get their own `mcp__<server>__<name>`
  // prefix, which classifyToolUse does NOT special-case — it falls through to
  // the fail-safe default ('subagent'), never the wechat tool's kind.
  const sdkName = args.mcpServer ? `mcp__${args.mcpServer}__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)
  const auth = authorize({ surface: 'chat', tier: args.tierProfile, permissionMode: args.permissionMode, executor: 'openai' }, { name: sdkName, kind })
  // chat 面上不会落成「问」(relayAs 是 deny);万一以后放开了而这里没跟着改,宁可拒。
  return auth.verdict === 'allow' ? 'allow' : 'deny'
}
