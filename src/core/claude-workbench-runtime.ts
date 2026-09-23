import { randomUUID } from 'node:crypto'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentActivity, AgentAttachment, AgentEvent, AgentRuntimeSnapshot, AgentSession, SpawnContext } from './agent-provider'
import { AsyncQueue } from './async-queue'
import { ClaudeWorkbenchEvents } from './claude-workbench-events'
import { ownClaudeWorkbenchProcess } from './claude-workbench-process'
import { isAuthFail } from './auth-fail'

type ToolEvent = Extract<AgentEvent, { kind: 'tool_call' }>
type ActivityEvent = ToolEvent & { activity: AgentActivity }
type Value = Record<string, any>
interface Helpers {
  content(text: string, attachments?: readonly AgentAttachment[]): SDKUserMessage['message']['content']
  tool(block: { name?: string }): ToolEvent
  label(name: string): Pick<AgentActivity, 'type' | 'label'>
}
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
const MAX_CHILD_OUTPUT = 40_000
const CLOSE_TIMEOUT = 2_500


interface Task {
  key: string
  toolId?: string
  background?: boolean
  terminal: boolean
  activity: AgentActivity
  parts: Map<string, string>
  outputLength: number
}

/** One reader owns one immutable workbench epoch. No native result or empty
 * background snapshot proves that the automatic notification queue is drained. */
export function createClaudeWorkbenchSession(baseOptions: Options, context: SpawnContext, helpers: Helpers): AgentSession {
  if (process.platform === 'win32') throw new Error('claude_workbench_process_groups_unsupported')
  if (baseOptions.spawnClaudeCodeProcess) throw new Error('claude_workbench_custom_spawn_unsupported')
  const processOwner = ownClaudeWorkbenchProcess(baseOptions.stderr)
  const abort = baseOptions.abortController ?? new AbortController()
  const input = new AsyncQueue<SDKUserMessage>(), output = new ClaudeWorkbenchEvents()
  const options: Options = { ...baseOptions, abortController: abort, spawnClaudeCodeProcess: processOwner.spawn, includePartialMessages: true,
    extraArgs: { ...baseOptions.extraArgs, 'replay-user-messages': null } }
  const tasks = new Map<string, Task>(), taskByTool = new Map<string, Task>(), live = new Set<string>()
  const operations = new Map<string, ActivityEvent>()
  let streamMessageId: string | null = null // API message id currently streaming, from stream_event message_start
  const streamed = new Map<string, string>() // itemId → text streamed so far, for reconciliation against the final assistant block
  const suppressedStream = new Set<string>() // itemIds whose accumulated text tripped the claude-sentinel auth-fail gate; cleared on message_stop
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  const requestIds = new Set<string>()
  let retained = false, foreground: AgentRuntimeSnapshot['foreground'] = 'unknown', started = false, ended = false, closing = false
  let sessionId = context.resumeSessionId, registrationKnown = false, sequence = 0
  let closePromise: Promise<void> | undefined, resolveDrain!: () => void
  const drained = new Promise<void>(resolve => { resolveDrain = resolve })
  const q = query({ prompt: input.iterable(), options })
  const pushTask = (task: Task) => output.push({ kind: 'tool_call', tool: task.activity.type === 'command' ? 'Bash' : 'Agent', activity: { ...task.activity } })
  const task = (key: string, toolId?: string, type?: string): Task => {
    let existing = tasks.get(key)
    if (!existing && toolId) {
      const orphan = taskByTool.get(toolId)
      if (orphan?.key.startsWith('tool:')) {
        tasks.delete(orphan.key); live.delete(orphan.key); orphan.key = key; tasks.set(key, orphan); existing = orphan
      }
    }
    if (!existing) {
      if (tasks.size >= 512) throw new Error('claude_runtime_task_limit')
      existing = { key, toolId, terminal: false, activity: { id: `claude:task:${key}`, type: type === 'local_bash' ? 'command' : 'agent', label: type === 'local_bash' ? '后台命令' : '子助手', status: 'running', ...(toolId ? { parentId: toolId } : {}) }, parts: new Map(), outputLength: 0 }
      tasks.set(key, existing); pushTask(existing)
    }
    if (toolId) { if (!taskByTool.has(toolId) && taskByTool.size >= 512) throw new Error('claude_runtime_task_owner_limit'); existing.toolId = toolId; existing.activity.parentId = toolId; taskByTool.set(toolId, existing) }
    return existing
  }
  const terminalTask = (entry: Task, status: AgentActivity['status']) => {
    if (entry.terminal) return
    entry.terminal = true; live.delete(entry.key); entry.activity.status = status; pushTask(entry)
  }
  const rejectPending = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear() }
  const settle = (status: 'cancelled' | 'interrupted') => {
    for (const entry of tasks.values()) terminalTask(entry, status)
    for (const [key, event] of operations) if (event.activity.status === 'running') {
      const next = { ...event, activity: { ...event.activity, status } }; operations.set(key, next); output.push(next)
    }
    live.clear()
  }
  const finish = (error?: Error) => {
    if (ended) return
    ended = true
    if (error) {
      foreground = 'unknown'
      try { settle('interrupted') } catch { live.clear() }
      rejectPending(error)
      try { output.fail(error) } finally {
        // The caller still receives the cached close failure if teardown is uncertain.
        void close().catch(() => {})
      }
    } else output.end()
  }
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true; foreground = 'unknown'; rejectPending(new Error('claude_runtime_closed')); input.end(); try { settle('cancelled') } catch { live.clear() }; finish()
    closePromise = (async () => {
      const deadline = Date.now() + CLOSE_TIMEOUT
      let ownershipError: unknown
      try { processOwner.prepareClose(deadline) } catch (error) { ownershipError = error }
      try { abort.abort() } catch {}
      let sdkClose: Promise<unknown> = Promise.resolve()
      try { sdkClose = Promise.resolve(q.close()).catch(() => {}) } catch { /* The owned group below is the authoritative teardown. */ }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.all([processOwner.close(deadline), Promise.race([Promise.all([drained, sdkClose]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('claude_runtime_reader_not_closed')), Math.max(0, deadline - Date.now())) })])])
        if (ownershipError) throw ownershipError
      } finally { if (timer) clearTimeout(timer) }
    })()
    return closePromise
  }
  const reportParent = (model: unknown) => {
    if (id(model)) context.reportExecution?.({ model: model as string, ...(sessionId ? { sessionId } : {}), source: 'native_message' })
  }
  const receive = (message: Value) => {
    if (closing || ended) return
    if (message.type === 'stream_event') {
      if (id(message.parent_tool_use_id)) return // a sub-agent's own stream never joins the parent timeline
      const ev = object(message.event) ? message.event : null
      if (!ev) return
      if (ev.type === 'message_start') { streamMessageId = id(object(ev.message) ? ev.message.id : undefined) ?? null; return }
      if (ev.type === 'content_block_delta' && streamMessageId !== null && typeof ev.index === 'number') {
        const delta = object(ev.delta) ? ev.delta : null
        if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return
        const itemId = `claude:${streamMessageId}:text:${ev.index}`
        if (suppressedStream.has(itemId)) return // sentinel already matched this block; stop echoing it into the timeline
        if (!streamed.has(itemId) && streamed.size >= 64) { const oldest = streamed.keys().next().value; if (oldest !== undefined) streamed.delete(oldest) }
        const combined = (streamed.get(itemId) ?? '') + delta.text
        if (isAuthFail('claude-sentinel', combined)) { streamed.delete(itemId); suppressedStream.add(itemId); return }
        streamed.set(itemId, combined)
        foreground = 'running'
        output.push({ kind: 'text', text: delta.text, itemId, textMode: 'append' })
        return
      }
      if (ev.type === 'message_stop') { streamMessageId = null; suppressedStream.clear() }
      return
    }
    if (message.type === 'system') {
      if (message.subtype === 'init' && !message.parent_tool_use_id) {
        foreground = 'running'
        if (id(message.session_id)) sessionId = message.session_id
        // Only this installed native version has been proved to register Agent
        // and Bash backgrounds before the first result. Unknown versions retain.
        registrationKnown = message.claude_code_version === '2.1.267'
        if (!registrationKnown) retained = true
        reportParent(message.model); output.push({ kind: 'init', sessionId: sessionId ?? '' })
      } else if (message.subtype === 'background_tasks_changed') {
        if (!Array.isArray(message.tasks)) { retained = true; foreground = 'unknown'; return }
        const next = new Set<string>()
        for (const value of message.tasks) {
          retained = true
          if (!object(value) || !id(value.task_id)) continue
          const entry = task(value.task_id, undefined, typeof value.task_type === 'string' ? value.task_type : undefined)
          entry.background = true
          if (!entry.terminal) next.add(entry.key)
        }
        live.clear(); for (const value of next) live.add(value)
      } else if (message.subtype === 'task_started' || message.subtype === 'task_progress') {
        const key = id(message.task_id)
        if (!key) { retained = true; return }
        const entry = task(key, id(message.tool_use_id), typeof message.task_type === 'string' ? message.task_type : undefined)
        const background = typeof message.is_backgrounded === 'boolean' ? message.is_backgrounded : entry.background !== false
        entry.background = background
        if (background) retained = true
        if (background && !entry.terminal) live.add(key)
      } else if (message.subtype === 'task_notification' || message.subtype === 'task_updated') {
        const key = id(message.task_id)
        if (!key) { retained = true; return }
        const entry = task(key, id(message.tool_use_id))
        if (message.subtype === 'task_updated' && object(message.patch) && typeof message.patch.is_backgrounded === 'boolean') {
          entry.background = message.patch.is_backgrounded
          if (entry.background && !entry.terminal) live.add(key)
          else if (!entry.background) live.delete(key)
        }
        if (entry.background !== false) retained = true
        const status = message.subtype === 'task_notification' ? message.status : object(message.patch) ? message.patch.status : undefined
        if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed') terminalTask(entry, status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled')
        else if (status === 'running' && entry.background !== false && !entry.terminal) { retained = true; live.add(key) }
      }
      return
    }
    if (message.type === 'user') {
      if (!message.parent_tool_use_id && message.isReplay === true && message.session_id === sessionId) {
        const key = id(message.uuid), ack = key ? pending.get(key) : undefined
        if (ack) { pending.delete(key!); foreground = 'running'; ack.resolve() }
      }
      const content = message.message?.content
      if (Array.isArray(content)) for (const block of content) {
        if (!object(block) || block.type !== 'tool_result') continue
        const key = id(block.tool_use_id), previous = key ? operations.get(key) : undefined
        const parent = id(message.parent_tool_use_id), owner = parent ? taskByTool.get(parent)?.activity.id ?? parent : undefined
        if (!previous || previous.activity.status !== 'running' || previous.activity.parentId !== owner) continue
        const next: ActivityEvent = { ...previous, activity: { ...previous.activity, status: block.is_error === true ? 'failed' : 'completed' } }
        operations.set(key!, next); output.push(next)
      }
      return
    }
    if (message.type === 'assistant') {
      const parent = id(message.parent_tool_use_id)
      if (!parent) { foreground = 'running'; reportParent(message.message?.model) }
      const rawContent = message.message?.content
      const blocks = typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : Array.isArray(rawContent) ? rawContent : []
      const messageKey = id(message.uuid) ?? id(message.message?.id) ?? `message-${++sequence}`
      const combined = blocks.map(block => object(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '').join('')
      if (!parent && isAuthFail('claude-sentinel', combined)) { finish(new Error('claude reports not logged in')); return }
      const owner = parent ? taskByTool.get(parent) ?? task(`tool:${parent}`, parent) : undefined
      if (owner && owner.background !== false) { retained = true; if (!owner.terminal) live.add(owner.key) }
      for (const [index, block] of blocks.entries()) {
        if (!object(block)) continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          const key = `${messageKey}:text:${index}`
          if (!owner) {
            const apiId = id(message.message?.id)
            const streamedKey = apiId ? [...streamed.keys()].find(candidate => candidate.startsWith(`claude:${apiId}:text:`) && streamed.get(candidate) === block.text) : undefined
            const itemId = streamedKey ?? `claude:${key}`
            if (streamedKey) streamed.delete(streamedKey)
            output.push({ kind: 'text', text: block.text, itemId, textMode: 'replace' })
          }
          else {
            const old = owner.parts.get(key) ?? '', value = block.text.slice(0, MAX_CHILD_OUTPUT - owner.outputLength + old.length)
            if (value !== old) {
              if (!owner.parts.has(key) && owner.parts.size >= 512) throw new Error('claude_runtime_child_output_parts_limit')
              owner.outputLength += value.length - old.length; owner.parts.set(key, value)
              owner.activity.output = [...owner.parts.values()].join(''); pushTask(owner)
            }
          }
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : '', key = id(block.id)
          if (name === 'Monitor' || object(block.input) && block.input.run_in_background === true) retained = true
          const event = helpers.tool({ name })
          if (!key) { output.push(event); continue }
          if (operations.has(key)) continue
          if (operations.size >= 4096) throw new Error('claude_runtime_operation_limit')
          const activity: AgentActivity = { id: key, ...helpers.label(name), status: 'running', ...(owner ? { parentId: owner.activity.id } : {}) }
          if (activity.type === 'tool') { const detail = [event.server, event.tool].filter(Boolean).join('/').replace(/[^A-Za-z0-9_.:/-]+/g, '_').slice(0, 160); if (detail) activity.detail = detail }
          const start = { ...event, activity }; operations.set(key, start); output.push(start)
        }
      }
      return
    }
    if (message.type === 'result') {
      foreground = 'idle'
      streamMessageId = null; streamed.clear(); suppressedStream.clear() // a turn boundary bounds streamed-text lifetime explicitly
      output.push({ kind: 'result', sessionId: typeof message.session_id === 'string' ? message.session_id : sessionId ?? '', numTurns: typeof message.num_turns === 'number' ? message.num_turns : 0, durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : 0 })
      if (message.subtype && message.subtype !== 'success') finish(new Error(`claude_runtime_result_${message.subtype}`))
      else if (!retained && registrationKnown) finish()
      else if (!registrationKnown) retained = true
    }
  }
  void (async () => {
    try {
      for await (const message of q) if (object(message)) receive(message)
      if (!closing && !ended) finish(new Error('claude_runtime_stream_ended'))
    } catch (error) { if (!closing) finish(error instanceof Error ? error : new Error(String(error))) }
    finally { resolveDrain() }
  })()
  return {
    workbenchRuntime: {
      events: output,
      start(text, attachments) {
        if (started || ended || closing) throw new Error('claude_runtime_already_started_or_closed')
        const content = helpers.content(text, attachments)
        started = true; foreground = 'running'
        input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, uuid: randomUUID() })
      },
      async submit(requestId, text, attachments) {
        if (!started || ended || closing) throw new Error('claude_runtime_closed_or_not_started')
        if (!id(requestId) || requestIds.has(requestId)) throw new Error('claude_runtime_request_duplicate_or_invalid')
        if (pending.size >= 10) throw new Error('claude_runtime_pending_input_limit')
        if (requestIds.size >= 1024) { const error = new Error('claude_runtime_request_limit'); finish(error); throw error }
        const content = helpers.content(text, attachments), uuid = randomUUID()
        requestIds.add(requestId); retained = true
        const acknowledged = new Promise<void>((resolve, reject) => pending.set(uuid, { resolve, reject }))
        input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, uuid, priority: 'next' })
        return acknowledged
      },
      snapshot: () => ({ retained, foreground, backgroundCount: live.size, input: started && !ended && !closing && pending.size < 10 ? 'send' : 'queue' }),
    },
    dispatch() { throw new Error('claude_runtime_requires_lifetime_entry') },
    async cancel() { if (!closing && !ended) await q.interrupt() },
    close,
  }
}
