import type { AgentActivity, AgentEvent } from '../agent-provider'

/**
 * ACP `session/update` → `AgentEvent` 的纯翻译。不碰进程、不碰 RPC。
 *
 * 真机(cursor-agent acp,2026-09-17 spike)三条规矩来源:
 *  - `agent_message_chunk` 没有 `messageId`,同一轮里工具调用前后是两条助理消息 ⇒ 自己合成 itemId,
 *    遇到 tool_call 之后再来的文本翻新一条;
 *  - `toolCallId` 里嵌着字面换行 ⇒ 当活动 id(event_key / DOM id)前先清洗;
 *  - `rawOutput` 只有 `{success:true}`,真正载荷不在协议里 ⇒ 活动行只放路径与工具身份(与 codex-activity 同一条隐私规矩)。
 */
export interface AcpTranslator { update(update: unknown): AgentEvent[]; beginTurn(): void }

type Obj = Record<string, unknown>
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const display = (value: unknown, limit = 300): string => typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').slice(0, limit) : ''
const paths = (locations: unknown): string[] => Array.isArray(locations) ? [...new Set(locations.slice(0, 12).map(loc => object(loc) ? display(loc.path) : '').filter(Boolean))] : []

export function acpActivityId(toolCallId: string): string { return toolCallId.replace(CONTROL_CHARS, '_').slice(0, 200) }

const KINDS: Record<string, { type: AgentActivity['type']; label: string }> = {
  read: { type: 'read', label: '读取文件' }, edit: { type: 'edit', label: '修改文件' }, delete: { type: 'edit', label: '删除文件' }, move: { type: 'edit', label: '移动文件' },
  search: { type: 'search', label: '检索文件' }, execute: { type: 'command', label: '运行命令' }, fetch: { type: 'search', label: '获取网页' },
}
const OTHER = { type: 'tool' as const, label: '调用工具' }
/** 只有这两种「已知的兜底」kind 才把 title 当工具身份放进 detail;没见过 / 已过期的 toolCallId(kind 落回空字符串)
 *  不认识具体是什么调用,detail 只能放路径 —— title 对 execute 就是命令本身,放出去违反隐私规矩。 */
const IDENTITY_KINDS = new Set(['other', 'switch_mode'])
/** 没见过的 status 保留上一次的判定 —— 一条 tool_call_update 只带 `status:'queued'` 这类新值时,
 *  把已经 completed 的调用打回 running 会让活动行永远转圈。首次露面(previous 缺省 running)照旧 running。 */
const status = (value: unknown, previous: AgentActivity['status']): AgentActivity['status'] =>
  value === 'completed' ? 'completed' : value === 'failed' ? 'failed' : (value === 'pending' || value === 'in_progress') ? 'running' : previous

interface Remembered { kind: string; title: string; name: string; status: AgentActivity['status']; paths: string[] }

export function createAcpTranslator(): AcpTranslator {
  let turn = 0, message = 0, textSeen = false
  const calls = new Map<string, Remembered>()
  const activityEvent = (id: string, call: Remembered): AgentEvent | null => {
    if (call.kind === 'think') return null
    // hasOwn,不是 KINDS[kind]:kind 由 agent 说了算,`constructor` / `__proto__` 会从原型链上
    // 捞回一个函数当"活动规格",拼出一条形状不对的活动行。
    const spec = Object.hasOwn(KINDS, call.kind) ? KINDS[call.kind] : undefined
    const includeIdentity = IDENTITY_KINDS.has(call.kind)
    const resolved = spec ?? OTHER
    const activity: AgentActivity = { id, type: resolved.type, status: call.status, label: resolved.label }
    const detail = includeIdentity ? [...call.paths, display(call.title, 120)].filter(Boolean).join('\n') : call.paths.join('\n')
    if (detail) activity.detail = detail.slice(0, 2000)
    return { kind: 'tool_call', tool: call.name || call.kind || 'tool', activity }
  }
  return {
    beginTurn() { turn++; message = 0; textSeen = false; calls.clear() },
    update(update) {
      if (!object(update) || typeof update.sessionUpdate !== 'string') return []
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (!object(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') return []
        textSeen = true
        const itemId = typeof update.messageId === 'string' && update.messageId ? `acp:msg:${acpActivityId(update.messageId)}` : `acp:turn:${turn}:${message}`
        return [{ kind: 'text', text: update.content.text, itemId, textMode: 'append' }]
      }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return []
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return []
      const id = acpActivityId(update.toolCallId)
      if (update.sessionUpdate === 'tool_call' && textSeen) { message++; textSeen = false }
      const previous = calls.get(id) ?? { kind: '', title: '', name: '', status: 'running' as const, paths: [] }
      const call: Remembered = {
        kind: typeof update.kind === 'string' ? update.kind : previous.kind,
        title: typeof update.title === 'string' ? update.title : previous.title,
        name: typeof update.name === 'string' ? display(update.name, 120) : previous.name,
        status: status(update.status, previous.status),
        paths: update.locations === undefined ? previous.paths : paths(update.locations),
      }
      calls.set(id, call)
      const event = activityEvent(id, call)
      return event ? [event] : []
    },
  }
}

/** 权限卡正文:命令(execute 的 rawInput.command)/ 标题、agent 附带的说明文本、涉及路径。超过 20_000 字或形状不对 ⇒ null(不可完整显示就不放行)。 */
export function acpPermissionDescription(params: unknown): string | null {
  if (!object(params) || !object(params.toolCall) || !Array.isArray(params.options)) return null
  const call = params.toolCall
  const command = call.kind === 'execute' && object(call.rawInput) && typeof call.rawInput.command === 'string' ? call.rawInput.command : null
  const notes = Array.isArray(call.content) ? call.content.map(item => object(item) && item.type === 'content' && object(item.content) && item.content.type === 'text' && typeof item.content.text === 'string' ? item.content.text : '').filter(Boolean) : []
  const parts = [command ?? (typeof call.title === 'string' ? call.title : ''), ...notes, ...paths(call.locations)].filter(Boolean)
  const description = parts.join('\n')
  return description && description.length <= 20_000 ? description : null
}

/** 只认 once 档:daemon 的权限桥是逐次布尔,永远不替主人做长期授权。找不到 ⇒ null(调用方回 cancelled)。 */
export function acpPermissionOption(options: unknown, allow: boolean): string | null {
  if (!Array.isArray(options)) return null
  const wanted = allow ? 'allow_once' : 'reject_once'
  const option = options.find(item => object(item) && item.kind === wanted && typeof item.optionId === 'string' && item.optionId)
  return option ? String((option as Obj).optionId) : null
}
