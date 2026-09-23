import type { AgentActivity, AgentEvent } from '../agent-provider'

type Item = Record<string, unknown>
const object = (value: unknown): value is Item => value !== null && typeof value === 'object' && !Array.isArray(value)
export const codexItemId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)
const display = (value: unknown, limit = 300): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : ''
const details = (values: unknown[]): string | undefined => [...new Set(values.slice(0, 12).map(value => display(value)).filter(Boolean))].join('\n').slice(0, 2000) || undefined

function outcome(item: Item, completed: boolean): AgentActivity['status'] {
  if (item.status === 'declined' || item.status === 'cancelled' || item.status === 'canceled') return 'cancelled'
  if (item.status === 'interrupted') return 'interrupted'
  if (item.status === 'failed' || item.status === 'errored' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'failed'
  if (item.status === 'completed') return 'completed'
  if (item.status === 'inProgress' || item.status === 'running') return 'running'
  // Status-less web search items use the item notification as their lifecycle.
  // An unknown future terminal status must not be presented as success.
  return completed ? (item.status == null ? 'completed' : 'interrupted') : 'running'
}

const agentLabels: Record<string, string> = {
  spawnAgent: '启动子助手', spawn_agent: '启动子助手',
  sendInput: '给子助手补充要求', send_input: '给子助手补充要求',
  sendMessage: '给子助手发送消息', send_message: '给子助手发送消息',
  followupTask: '给子助手补充任务', followup_task: '给子助手补充任务',
  resumeAgent: '继续子助手', resume_agent: '继续子助手',
  wait: '等待子助手', closeAgent: '结束子助手', close_agent: '结束子助手',
  interruptAgent: '停止子助手', interrupt_agent: '停止子助手',
  listAgents: '查看子助手', list_agents: '查看子助手',
}
const agentStates: Record<string, string> = {
  pendingInit: '正在启动', running: '正在处理', interrupted: '已中断',
  completed: '已完成', errored: '执行失败', shutdown: '已结束', notFound: '暂时不可用',
}

/** Public timeline projection. Never copy command strings, prompts, arguments,
 * outputs, patches, or child-agent messages into the activity details. */
export function codexActivityEvent(item: Item, completed: boolean): Extract<AgentEvent, { kind: 'tool_call' }> | null {
  if (!codexItemId(item.id)) return null
  const base = { id: item.id, status: outcome(item, completed) }
  let activity: AgentActivity
  switch (item.type) {
    case 'commandExecution': {
      const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(object) : []
      const fileActions = actions.length > 0 && actions.every(action => ['read', 'listFiles', 'search'].includes(String(action.type)))
      const searching = fileActions && actions.some(action => action.type === 'search')
      activity = { ...base, type: fileActions ? searching ? 'search' : 'read' : 'command', label: fileActions ? searching ? '检索文件' : '读取文件' : '运行命令' }
      if (fileActions) activity.detail = details(actions.map(action => action.path))
      break
    }
    case 'fileChange':
      activity = { ...base, type: 'edit', label: '修改文件', detail: details(Array.isArray(item.changes) ? item.changes.filter(object).map(change => change.path) : []) }
      break
    case 'webSearch':
      activity = { ...base, type: 'search', label: '搜索网页' }
      break
    case 'mcpToolCall':
    case 'dynamicToolCall':
      activity = { ...base, type: 'tool', label: '调用工具', detail: details([display(item.server, 120), display(item.tool, 120)]) }
      break
    case 'collabAgentToolCall':
    case 'collabToolCall': {
      // 0.153.4 uses receiverThreadIds/agentsStates; newer documented items
      // use optional receiverThreadId/newThreadId/agentStatus instead.
      const targets: unknown[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      const ids = [...new Set([...targets, item.receiverThreadId, item.newThreadId].filter(codexItemId))].slice(0, 32)
      const states = object(item.agentsStates) ? item.agentsStates : {}
      const stateDetails = ids.map((id, index) => {
        const state = states[id]
        const status = object(state) ? state.status : ids.length === 1 ? item.agentStatus : undefined
        const label = typeof status === 'string' && Object.hasOwn(agentStates, status) ? agentStates[status] : '状态未知'
        return `子助手 ${index + 1}：${label}`
      })
      // Completion here belongs to the operation (e.g. spawn), not the child.
      // Only explicitly reported child states appear in its separate detail.
      activity = { ...base, type: 'agent', label: typeof item.tool === 'string' && Object.hasOwn(agentLabels, item.tool) ? agentLabels[item.tool]! : '子助手操作' }
      if (codexItemId(item.senderThreadId)) activity.parentId = item.senderThreadId
      if (ids.length) { activity.agentIds = ids; activity.detail = details(stateDetails) }
      break
    }
    default: return null
  }
  if (!activity.detail) delete activity.detail
  return { kind: 'tool_call', tool: String(item.type), activity }
}
