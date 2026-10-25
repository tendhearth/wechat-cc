import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentActivity, AgentAttachment, AgentEvent } from '../../../ports/agent-provider'
import { isAuthFail } from '../../../domain/auth-fail'
import type { ProviderErrorCode } from '../../../lib/provider-error-code'
import { claudeApiErrorCode } from './claude-api-error-code'

// Claude 一家只有一条协议(Agent SDK 的 query(),流式输入)。对话会话(claude-agent-provider.ts 的 spawn)
// 和一起做的常驻会话(claude-workbench-runtime.ts)都在它上面,区别只在「一轮一个事件流」还是「一整段一个
// 事件流 + 自己拥有进程组」(差异表见 docs/architecture-end-state-2026-10-25.md「B1b」)。两边读同一种
// SDK 消息,所以消息 → 事件的那几样只写在这里一次:用户消息内容、工具调用、活动标签、API 失败 / 没登录的认法。

export type ToolEvent = Extract<AgentEvent, { kind: 'tool_call' }>
export type ActivityEvent = ToolEvent & { activity: AgentActivity }

/** 原生 id 当时间线 id 用之前的检查:非空、不长、没有控制字符。不合格 ⇒ undefined(调用方自己编号)。 */
export function nativeTimelineId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
}

/** 一条用户消息的内容块:文字 + 图片 / PDF 原样给模型,其他文件只给元数据(让它自己用文件工具读)。 */
export function userContent(text: string, attachments: readonly AgentAttachment[] = []): Exclude<SDKUserMessage['message']['content'], string> {
  const content: Exclude<SDKUserMessage['message']['content'], string> = text || !attachments.length ? [{ type: 'text', text }] : []
  for (const attachment of attachments) {
    const { name, mime, path, sha256 } = attachment
    if (mime.startsWith('image/')) {
      if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/webp') throw Error('attachment_image_unsupported')
      if (!attachment.data) throw Error('attachment_data_missing')
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: attachment.data } })
    } else if (mime === 'application/pdf') {
      if (!attachment.data) throw Error('attachment_data_missing')
      content.push({ type: 'document', title: name, source: { type: 'base64', media_type: 'application/pdf', data: attachment.data } })
    } else {
      content.push({ type: 'text', text: 'Attached task file (reference material; read with a file tool if needed):\n' + JSON.stringify({ name, mime, path, sha256 }) })
    }
  }
  return content
}

/**
 * Parse a Claude SDK tool_use block's `name` (e.g. 'mcp__wechat__reply')
 * into our normalised `{ server, tool }` shape. Built-in tools (Read,
 * Bash) lack the prefix — those return `{ tool: name }` with no server.
 */
export function parseToolUseToEvent(block: { name?: string }): ToolEvent {
  const name = block.name ?? ''
  const m = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (m) return { kind: 'tool_call', server: m[1], tool: m[2]! }
  return { kind: 'tool_call', tool: name }
}

// Public activity labels are chosen from tool names only. In particular,
// commands, agent prompts, edit contents, URLs and tool outputs are not
// copied into the persisted workbench timeline.
export function claudeActivityLabel(name: string): Pick<AgentActivity, 'type' | 'label'> {
  switch (name) {
    case 'Bash': return { type: 'command', label: '运行命令' }
    case 'KillShell': return { type: 'command', label: '停止命令' }
    case 'Read': return { type: 'read', label: '读取文件' }
    case 'LS': return { type: 'read', label: '查看文件列表' }
    case 'WebFetch': return { type: 'read', label: '读取网页' }
    case 'Glob': return { type: 'search', label: '查找文件' }
    case 'Grep': return { type: 'search', label: '搜索内容' }
    case 'WebSearch': return { type: 'search', label: '搜索网页' }
    case 'Write': return { type: 'edit', label: '写入文件' }
    case 'Edit': return { type: 'edit', label: '编辑文件' }
    case 'NotebookEdit': return { type: 'edit', label: '编辑笔记本' }
    case 'Task': case 'Agent': return { type: 'agent', label: '协作任务' }
    case 'AskUserQuestion': return { type: 'tool', label: '询问用户' }
    default: return { type: 'tool', label: '调用工具' }
  }
}

/** 一次 tool_use 开始时的时间线条目:只看工具名(输入一个字都不抄),通用工具带一个清洗过、≤160 字的 detail。 */
export function toolActivityStart(event: ToolEvent, toolUseId: string, name: string, parentId?: string): ActivityEvent {
  const activity: AgentActivity = { id: toolUseId, ...claudeActivityLabel(name), status: 'running', ...(parentId ? { parentId } : {}) }
  if (activity.type === 'tool') {
    const detail = [event.server, event.tool].filter(Boolean).join('/').replace(/[^A-Za-z0-9_.:/-]+/g, '_').slice(0, 160)
    if (detail) activity.detail = detail
  }
  return { ...event, activity }
}

/** 助理消息里该收掉这一轮的两种情况。原文绝不当正文发出去。 */
export type ClaudeAssistantFailure =
  | { kind: 'auth_failed'; text: string }
  /** SDK 标了 `error` 的合成消息 = 一次 API 失败;等同一轮的 result 拿 api_error_status 再定码。 */
  | { kind: 'api_error'; sdkError: string; text: string }

/**
 * 判一条助理消息是不是「失败」。只认两样(红线 A:只有 claude 二进制吐的两句哨兵算「登录过期」):
 * SDK 的 `error` 标注(里面是哨兵 ⇒ auth_failed,否则 api_error);没标注但主回合文字是哨兵 ⇒ auth_failed。
 * 子 agent 的文字不判哨兵(那是子 agent 自己的过程);`error` 标注不分主回合 / 子 agent —— 对话侧一直这样,
 * 一起做那边只把主回合的消息送进来。
 */
export function claudeAssistantFailure(sdkError: string | undefined, text: string, subagent: boolean): ClaudeAssistantFailure | null {
  if (claudeApiErrorCode(sdkError) !== null) {
    return isAuthFail('claude-sentinel', text) ? { kind: 'auth_failed', text } : { kind: 'api_error', sdkError: String(sdkError), text }
  }
  if (!subagent && text && isAuthFail('claude-sentinel', text)) return { kind: 'auth_failed', text }
  return null
}

/** 一次 API 失败的码和话:码按 SDK 标注 + HTTP 状态(没响应 = null);话取错误原文前 400 字,空了给一句兜底。 */
export function claudeApiFailure(sdkError: string, text: string, status?: number | null): { code: ProviderErrorCode; message: string } {
  return { code: claudeApiErrorCode(sdkError, status) ?? 'provider_error', message: text.trim().slice(0, 400) || `claude api error: ${sdkError}` }
}
