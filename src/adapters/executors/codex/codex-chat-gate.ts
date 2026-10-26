/**
 * Codex 对话的逐条审批(主人 2026-10-26 点头:「Codex 对话逐条问」)。
 *
 * 主人自己的对话(admin 档,strict)里 codex app-server 跑 on-request:它要批的命令 / 改文件 / MCP 调用发给客户端,
 * 这里逐条交给 authorize()(经 permission-rules/chat.ts 的 authorizeChatCall,和 Claude / Gemini / openai 同一条路):
 *   - 命令 / 改文件:codex 自己已经判定这一条要批(越出沙箱、或它认为危险)⇒ 起点就是「问」(reported);
 *     主人的放行规则可以替主人放(回复里多一行「按规则「…」放行了 …」)、可以拒;红线照旧问;
 *   - MCP 调用:按档位 × 类别判(和 Claude 的 canUseTool 一样):档位放的直接放,档位说问的(memory_delete /
 *     daemon_remediate …)先过规则再问;
 *   - 要问 ⇒ 经微信拍板卡问主人(ilink.askUser,和 Claude 对话同一张卡、同一个待批登记处),10 分钟没回 ⇒ 拒,
 *     卡送不到 ⇒ 拒。拒了 codex 收到 decline,这次调用记成失败,模型看得到。
 *
 * 不给网、访客、定时、审查这些档的会话不是 on-request,根本收不到审批请求(compilePolicy('codex'))。
 */
import { authorizeChatCall, type ChatOwnerRules } from '../../permission-rules/chat'
import { classifyToolUse, type ToolKind } from '../../../domain/user-tier'
import type { SpawnContext } from '../../../ports/agent-provider'
import type { CodexChatApprovalRequest, CodexChatApprove } from './codex-app-server'

export interface CodexChatGateDeps {
  askUser: (adminChatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  /** 这个对话的审批卡发给谁(resolveAdminChatId);没有 ⇒ 拒。 */
  adminFor: (chatId: string) => string | null
  /** 主人自己的对话走放行规则(现取:规则那一层比 provider 晚接线)。不给 / 回 null ⇒ 不看规则。 */
  ownerRules?: () => ChatOwnerRules | null
  log: (tag: string, line: string) => void
  /** 拍板卡等多久(缺省 10 分钟,和 Claude 对话一样)。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const PROMPT_MAX = 800

/** 5 位 base36(待批登记处的旧码只认恰好 5 位;permission-relay.ts 同一个取法)。 */
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5)
}

const isMcp = (tool: string) => tool.startsWith('mcp__')

/** 这一条审批是什么类别的工具(只用于档位那一层与日志;命令 / 改文件走 reported,类别不改落点)。 */
function kindOf(req: CodexChatApprovalRequest): ToolKind {
  if (isMcp(req.tool)) return classifyToolUse(req.tool, req.input ?? {})
  if (req.tool === 'fileChange') return 'fs_write'
  return classifyToolUse('Bash', { command: req.command ?? '' })
}

/** 拍板卡上那一段:命令 / 改文件 / 工具 + codex 给的说明(截断)。 */
function promptOf(req: CodexChatApprovalRequest): string {
  const what = req.tool === 'commandExecution' ? '执行命令' : req.tool === 'fileChange' ? '改文件' : `调用 ${req.tool}`
  const body = req.description.length > PROMPT_MAX ? `${req.description.slice(0, PROMPT_MAX - 1)}…` : req.description
  return `Codex 想${what}:\n${body}`
}

export function makeCodexChatGate(deps: CodexChatGateDeps): (ctx: SpawnContext) => CodexChatApprove {
  return (ctx: SpawnContext): CodexChatApprove => {
    let seq = 0
    return async (req, signal) => {
      if (signal.aborted) return false
      const kind = kindOf(req)
      const mcp = isMcp(req.tool)
      const input: Record<string, unknown> = mcp ? (req.input ?? {}) : req.command ? { command: req.command } : {}
      const auth = await authorizeChatCall(
        { tier: ctx.tierProfile, permissionMode: ctx.permissionMode, executor: 'codex' },
        // MCP:档位 × 类别(能力表里 codex 不逐条问 ⇒ never;admin / trusted 每一类档位都明说了)。命令 / 改文件:codex 报上来要批的。
        mcp ? { name: req.tool, kind, askUser: 'never' } : { name: req.tool, kind, reported: true },
        { chatId: ctx.chatId, provider: 'codex', tool: req.tool, input, ...(req.paths ? { paths: req.paths } : {}) },
        deps.ownerRules?.() ?? null,
      )
      if (auth.verdict === 'allow') {
        if (auth.reason === 'owner_rules') deps.log('PERMISSION', `allow-by-owner-rule: provider=codex tool=${req.tool} kind=${kind}`)
        return true
      }
      if (auth.verdict === 'deny') {
        deps.log('PERMISSION', `${auth.reason === 'owner_rules' ? 'deny-by-owner-rule' : 'deny'}: provider=codex tool=${req.tool} kind=${kind}`)
        return false
      }
      const admin = deps.adminFor(ctx.chatId)
      if (!admin) { deps.log('PERMISSION', `relay-but-no-admin: provider=codex tool=${req.tool} kind=${kind} — denying`); return false }
      if (signal.aborted) return false
      const hash = shortHash(`${ctx.chatId}:codex:${req.tool}:${++seq}:${Date.now()}`)
      const answer = await deps.askUser(admin, promptOf(req), hash, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      if (answer === 'allow') return !signal.aborted
      deps.log('PERMISSION', `${answer}: provider=codex tool=${req.tool} hash=${hash}`)
      return false
    }
  }
}
