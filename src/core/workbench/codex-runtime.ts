import type { AgentActivity, AgentEvent } from '../agent-provider'

/** Public child replies only. Tool output, prompts and reasoning never enter this map. */
export class CodexChildOccurrence {
  readonly id: string
  private status: AgentActivity['status'] = 'running'
  private replies = new Map<string, string>()
  constructor(readonly threadId: string, readonly turnId: string, readonly parentId: string) {
    this.id = `codex-child:${threadId}:${turnId}`
  }
  get running() { return this.status === 'running' }
  text(itemId: string, text: string, replace: boolean) {
    if (!this.running) return
    if (!this.replies.has(itemId) && this.replies.size >= 1000) throw new Error('codex_child_message_limit')
    this.replies.set(itemId, (replace ? text : (this.replies.get(itemId) ?? '') + text).slice(0, 40_000))
    // Bound retained public output across separate message items as well.
    let remaining = 40_000
    for (const [id, value] of this.replies) { this.replies.set(id, value.slice(0, remaining)); remaining -= Math.min(value.length, remaining) }
  }
  finish(status: unknown) {
    if (!this.running) return
    this.status = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : status === 'cancelled' ? 'cancelled' : 'failed'
  }
  event(): AgentEvent {
    const output = [...this.replies.values()].join('\n\n').slice(0, 40_000)
    return { kind: 'tool_call', tool: 'subagent', activity: {
      id: this.id, type: 'agent', status: this.status,
      label: this.running ? '子助手执行中' : this.status === 'completed' ? '子助手已完成' : this.status === 'failed' ? '子助手执行失败' : '子助手已停止',
      parentId: this.parentId, agentIds: [this.threadId], ...(output ? { output } : {}),
    } }
  }
}
