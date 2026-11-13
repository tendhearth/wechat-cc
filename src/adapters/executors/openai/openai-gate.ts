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
 * Relay calls use the same owner confirmation channel as Claude. Without
 * that channel, approval fails closed.
 *
 * See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
 */
import { classifyToolUse, type TierProfile } from '../../../domain/user-tier'
import type { PermissionMode } from '../../../ports/agent-provider'
import { authorizeChatCall, type ChatOwnerRules } from '../../permission-rules/chat'
import { randomUUID } from 'node:crypto'

export interface OpenAiApproval {
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  adminFor: (chatId: string) => string | null
}

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
  approval?: OpenAiApproval
  signal?: AbortSignal
}): Promise<GateResult> {
  if (args.signal?.aborted) return { decision: 'deny' }
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
  if (auth.verdict === 'allow') return { decision: 'allow' }
  if (auth.verdict === 'ask' && args.approval && !args.signal?.aborted) {
    const admin = args.approval.adminFor(args.chatId)
    if (!admin) return { decision: 'deny', message: 'no admin configured to approve permission requests' }
    try {
      const prompt = `OpenAI 想调用 ${sdkName}:\n${JSON.stringify(args.input)}`
      const answer = await args.approval.askUser(admin, prompt, randomUUID().replace(/-/g, '').slice(0, 5), 10 * 60_000)
      if (answer === 'allow' && !args.signal?.aborted) return { decision: 'allow' }
      return { decision: 'deny', message: answer === 'undelivered' ? 'Could not deliver the approval request to the owner; ask them to try again shortly.' : answer === 'timeout' ? 'User did not reply in time; request denied' : 'User denied the request' }
    } catch { return { decision: 'deny' } }
  }
  return auth.denyMessage ? { decision: 'deny', message: auth.denyMessage } : { decision: 'deny' }
}
