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
import { classifyToolUse, type TierProfile } from './user-tier'
import type { PermissionMode } from './agent-provider'

export type GateDecision = 'allow' | 'deny'

export function gateTool(args: {
  toolName: string
  isMcp: boolean
  input: Record<string, unknown>
  tierProfile: TierProfile
  permissionMode: PermissionMode
}): GateDecision {
  if (args.permissionMode === 'dangerously') return 'allow'

  // classifyToolUse recognizes wechat MCP tools by their SDK-prefixed name
  // (`mcp__wechat__<name>`); built-in tools (Read/Write/Edit/Bash/...) pass
  // through unchanged.
  const sdkName = args.isMcp ? `mcp__wechat__${args.toolName}` : args.toolName
  const kind = classifyToolUse(sdkName, args.input)

  if (args.tierProfile.deny.has(kind)) return 'deny'
  // v1: relay collapses to deny in strict mode — mid-turn WeChat
  // confirmation round-trip is deferred to a follow-up task.
  if (args.tierProfile.relay.has(kind)) return 'deny'
  return 'allow'
}
