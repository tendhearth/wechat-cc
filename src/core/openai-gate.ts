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
import { classifyToolUse, type TierProfile } from '../domain/user-tier'
import type { PermissionMode } from '../ports/agent-provider'
import { compilePolicy } from '../domain/policy'
import { decideTool } from '../domain/tool-decision'

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
  const policy = compilePolicy('openai', args.tierProfile, args.permissionMode)
  if (policy.bypass) return 'allow'

  // classifyToolUse recognizes wechat MCP tools by their SDK-prefixed name
  // (`mcp__wechat__<name>`); built-in tools (Read/Write/Edit/Bash/...) pass
  // through unchanged. Other MCP servers get their own `mcp__<server>__<name>`
  // prefix, which classifyToolUse does NOT special-case — it falls through to
  // the fail-safe default ('subagent'), never the wechat tool's kind.
  const sdkName = args.mcpServer ? `mcp__${args.mcpServer}__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)

  // 判定在 ./tool-decision.ts(三家共用);openai 不看能力表(它没有 per-tool 的那一档)。
  // v1: relay collapses to deny in strict mode — mid-turn WeChat confirmation round-trip is deferred.
  const verdict = decideTool(args.tierProfile, kind)
  return verdict === 'relay' ? policy.relayAs : verdict
}
