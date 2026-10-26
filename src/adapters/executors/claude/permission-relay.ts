import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Mode, ProviderId } from '../../../domain/conversation'
import { lookup, type PermissionMode } from '../../../domain/capability-matrix'
import { isReplyToolName } from '../../../ports/agent-provider'
import { classifyToolUse, TIER_PROFILES, type UserTier } from '../../../domain/user-tier'
import { authorize } from '../../../domain/authorize'
import { authorizeChatToolUse, type ChatOwnerRules } from '../../permission-rules/chat'

export interface PermissionRelayDeps {
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  /**
   * chatId of the chat that initiated this dispatch (for routing context
   * only — NOT the prompt target). Kept for log correlation; relay
   * prompts always go to `adminChatId`.
   */
  initiatingChatId: () => string | null
  /** chatId of an admin to receive prompts. May be null if no admins configured. */
  adminChatId: () => string | null
  /** Returns the tier of the initiating chat — the subject's tier for authorize(). */
  resolveTier: () => UserTier
  log: (tag: string, line: string) => void
  /**
   * Resolve the chat's CURRENT mode at the moment of the tool call.
   * Previously a static value captured at boot time which always read
   * 'solo' even for chats actually in chatroom/parallel/primary_tool —
   * caused the capability-matrix lookup to consult the wrong row and
   * could let through (or wrongly deny) tools depending on which mode
   * the chat was actually in. Callback shape lets bootstrap wire it
   * to `conversationStore.get(chatId)?.mode.kind`.
   */
  mode: () => Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
  /**
   * 主人自己的对话走放行规则(2026-10-25,core/permission-rules/chat.ts)。现取:规则那一层(终端会话功能里的
   * permission-gate)比这里晚接线。不给 / 回 null ⇒ 对话不看规则,和以前一样。
   */
  ownerRules?: () => ChatOwnerRules | null
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function makeCanUseTool(deps: PermissionRelayDeps): CanUseTool {
  return async (toolName, input, opts) => {
    // Chatroom beats: the coordinator captures each agent's plain text and
    // re-emits it prefixed ([Claude]/[Codex]). A direct reply-tool call would
    // (a) send an UN-prefixed message straight to the chat and (b) lose its
    // real argument to the verdict transcript (collectTurn records only
    // replyToolCalled, not the text). So deny reply outright during a debate
    // beat — force plain text. See conversation-coordinator.runBeat.
    // 2026-09:同样的理由对 parallel(/both)也成立,而且多一条 —— /both
    // 现在会在末尾给一条收口(见 dispatchParallel 的 buildParallelSynthesisPrompt)。
    // reply 工具一走,协调器就**看不到那位说了什么**,收口只能拿到半场,
    // 比不收口更糟。代价:参与者不能在 /both 里直接发图(纯文本会照常前缀
    // 转发);/chat 早就接受了同一个代价。
    // 回复交付 daemon 模式(spec 2026-10-03 §4.9):reply 族不注册了,扇出里要拒的只剩显式的 `message`
    // (往别处发)—— 同一个理由:协调器看不到那句话,前缀 / 收口都管不到它。
    // 判定只在 domain/authorize.ts(架构终态 C2):扇出拒 reply → 档位 × 类别 × 能力表 → 主人自己的对话里落到「问」的,
    // 先过放行规则(2026-10-25 主人点头,core/permission-rules/chat.ts;访客 / 信任的对话不看)。
    const mode = deps.mode()
    const fanOut = mode === 'chatroom' || mode === 'parallel'
    const replyFamily = isReplyToolName(toolName) || toolName === 'mcp__wechat__message'
    // 扇出里的 reply 在档位之前就判掉:这条路上不取档、不分类、不查能力表(和改之前一样 —— resolveTier 要读
    // access.json,这里不碰)。档位在这一层根本不被读,传最窄的 guest 只为满足类型。
    if (fanOut && replyFamily) {
      const verdict = authorize({ surface: 'chat', tier: TIER_PROFILES.guest, permissionMode: deps.permissionMode, executor: 'claude', fanOut }, { name: toolName, kind: 'reply', replyFamily })
      if (verdict.verdict === 'deny') {
        deps.log('PERMISSION', `deny-fanout-reply: mode=${deps.mode()} tool=${toolName}`)
        return {
          behavior: 'deny',
          message: 'reply tool is disabled in chatroom/parallel mode — respond with plain text, the host will relay it',
        } satisfies PermissionResult
      }
    }
    const tier = deps.resolveTier()
    const tp = TIER_PROFILES[tier]
    const kind = classifyToolUse(toolName, input as Record<string, unknown>)
    const base = lookup(deps.mode(), deps.provider, deps.permissionMode)
    // 和 Codex 对话的审批同一个入口(permission-rules/chat.ts 的 authorizeChatToolUse:分类 + authorizeChatCall)。
    const auth = await authorizeChatToolUse(
      { tier: tp, permissionMode: deps.permissionMode, executor: 'claude', fanOut },
      { tool: toolName, input: input as Record<string, unknown>, askUser: base.askUser, replyFamily },
      deps.initiatingChatId() ?? '',
      deps.ownerRules?.() ?? null,
    )
    const decision = auth.verdict

    if (decision === 'allow') {
      if (auth.reason === 'owner_rules') deps.log('PERMISSION', `allow-by-owner-rule: tool=${toolName} kind=${kind}`)
      return { behavior: 'allow' } satisfies PermissionResult
    }
    if (decision === 'deny' && auth.denyMessage) {
      deps.log('PERMISSION', `deny-by-owner-rule: tool=${toolName} kind=${kind}`)
      return { behavior: 'deny', message: auth.denyMessage } satisfies PermissionResult
    }
    if (decision === 'deny') {
      deps.log('PERMISSION', `deny: tool=${toolName} kind=${kind} tier=${tier}`)
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' (${kind}) not available to tier '${tier}'`,
      } satisfies PermissionResult
    }
    // relay
    const target = deps.adminChatId()
    if (!target) {
      deps.log('PERMISSION', `relay-but-no-admin: tool=${toolName} kind=${kind} — denying`)
      return {
        behavior: 'deny',
        message: 'no admin configured to approve permission requests',
      } satisfies PermissionResult
    }
    const hash = shortHash(opts.toolUseID ?? '')
    const prompt = opts.title ?? `Claude wants to run ${toolName} ${compactInput(input)}`
    const answer = await deps.askUser(target, prompt, hash, DEFAULT_TIMEOUT_MS)
    if (answer === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    deps.log('PERMISSION', `${answer}: tool=${toolName} hash=${hash}`)
    // 'undelivered' ≠ denied: the approver never saw the prompt (their push
    // window was closed). Tell the agent honestly so it can relay a useful
    // message to the initiating user instead of a false "主人拒绝了".
    const message = answer === 'undelivered'
      ? 'Could not deliver the approval request to the admin (their message window is likely closed). Tell the user this action needs the owner’s approval but the owner couldn’t be reached right now — ask them to try again shortly, or have the owner send you a message first.'
      : answer === 'timeout' ? 'User did not reply in time; request denied'
      : 'User denied the request'
    return { behavior: 'deny', message } satisfies PermissionResult
  }
}

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  // A base36 uint32 is 1–7 chars; the admin reply regex (pending-permissions.ts
  // PERMISSION_REPLY_RE) requires EXACTLY 5. padStart guards <5, slice(-5) guards >5.
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

function compactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = keys[0]
  if (!first) return ''
  const v = input[first]
  return `${first}=${typeof v === 'string' ? v.slice(0, 40) : typeof v}`
}
