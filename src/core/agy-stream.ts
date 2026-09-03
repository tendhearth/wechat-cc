/**
 * Pure NDJSON parser/aggregator for agy's `--output-format stream-json`.
 *
 * The event shapes here are the *observed* behavior of agy 1.1.13 (Task 1
 * spike, 2026-08-17, docs/superpowers/specs/2026-08-17-agy-provider-design.md
 * §0 + scratchpad/agy-spike-findings.md) — there is no published version
 * contract for this NDJSON stream. Per spec §6 risk①, this parser MUST
 * silently skip any `event` or `step_type` it doesn't recognize (forward
 * compatibility over a future agy release changing/adding shapes) rather
 * than throwing. No caller-visible behavior should depend on an unknown
 * shape being rejected.
 */

/** stream-json 一行解析出的内部事件(与 CLI 解耦的窄化)。 */
export type AgyStreamEvent =
  | { kind: 'init'; conversationId: string }
  | { kind: 'text'; text: string } // 一个 agent_response step 聚合后的完整文本
  | { kind: 'tool_call'; tool: string; server?: string }
  | { kind: 'result'; conversationId: string; numTurns: number }
  | { kind: 'error'; message: string } // result.status !== SUCCESS

/** 喂入原始行,吐出零或多个事件;内部维护 step 聚合状态。 */
export interface AgyStreamParser {
  feed(line: string): AgyStreamEvent[]
  /** 流终止时冲洗未 DONE 的聚合文本(有则发一条 text)。 */
  flush(): AgyStreamEvent[]
}

interface PendingText {
  stepIndex: number
  text: string
}

/** call_mcp_tool's tool_info.parameters shape (spike findings §(a)). */
interface McpToolParams {
  ServerName?: unknown
  ToolName?: unknown
}

export function makeAgyStreamParser(): AgyStreamParser {
  let pending: PendingText | null = null
  const toolCallEmittedForStep = new Set<number>()

  function flushPending(): AgyStreamEvent[] {
    if (pending === null) return []
    const text = pending.text
    pending = null
    // **空的聚合不是一条消息。** 一个没有 text_delta 的 agent_response step
    // (纯状态变化)照样会建出 pending,此前 flush 时会吐 `{text:''}`:
    // 真机日志里就是 `chunks=3 preview=""`。后果不只是难看 —— solo 路径会
    // 为每个空 chunk 发一次注定失败的消息,chunks 计数也是虚的。
    if (text.trim() === '') return []
    return [{ kind: 'text', text }]
  }

  function handleStepUpdate(su: Record<string, unknown>): AgyStreamEvent[] {
    const stepIndex = su.step_index
    const state = su.state
    const stepType = su.step_type
    if (typeof stepIndex !== 'number' || typeof state !== 'string' || typeof stepType !== 'string') return []

    const out: AgyStreamEvent[] = []

    // Cross-step_index switch: if a previous agent_response aggregation
    // never saw DONE, flush it before touching this line's step.
    if (pending !== null && pending.stepIndex !== stepIndex) {
      out.push(...flushPending())
    }

    if (stepType === 'agent_response') {
      const delta = su.text_delta
      const deltaStr = typeof delta === 'string' ? delta : ''
      if (pending === null) {
        pending = { stepIndex, text: deltaStr }
      } else {
        pending.text += deltaStr
      }
      if (state === 'DONE') {
        out.push(...flushPending())
      }
      return out
    }

    if (stepType === 'tool') {
      const toolName = su.tool_name
      if (typeof toolName === 'string' && !toolCallEmittedForStep.has(stepIndex)) {
        toolCallEmittedForStep.add(stepIndex)
        if (toolName === 'call_mcp_tool') {
          const toolInfo = su.tool_info
          const params: McpToolParams =
            toolInfo !== null && typeof toolInfo === 'object' && 'parameters' in toolInfo && typeof (toolInfo as { parameters?: unknown }).parameters === 'object'
              ? ((toolInfo as { parameters?: unknown }).parameters as McpToolParams) ?? {}
              : {}
          const tool = typeof params.ToolName === 'string' ? params.ToolName : toolName
          const server = typeof params.ServerName === 'string' ? params.ServerName : undefined
          out.push(server !== undefined ? { kind: 'tool_call', tool, server } : { kind: 'tool_call', tool })
        } else {
          out.push({ kind: 'tool_call', tool: toolName })
        }
      }
      return out
    }

    // Unknown/non-actionable step_type (user_input, checkpoint, future
    // additions, …) — silently skip per spec §6 risk①.
    return out
  }

  function handleResult(result: Record<string, unknown>): AgyStreamEvent[] {
    const out = flushPending()
    const conversationId = typeof result.conversation_id === 'string' ? result.conversation_id : ''
    const status = typeof result.status === 'string' ? result.status : 'UNKNOWN'
    if (status === 'SUCCESS') {
      const numTurns = typeof result.num_turns === 'number' ? result.num_turns : 0
      out.push({ kind: 'result', conversationId, numTurns })
      return out
    }
    const errorField = result.error
    const message = typeof errorField === 'string' && errorField.length > 0 ? `agy result status=${status}: ${errorField}` : `agy result status=${status}`
    out.push({ kind: 'error', message })
    return out
  }

  return {
    feed(line: string): AgyStreamEvent[] {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return []
      }
      if (parsed === null || typeof parsed !== 'object') return []
      const obj = parsed as Record<string, unknown>
      const event = obj.event
      if (typeof event !== 'string') return []

      switch (event) {
        case 'init': {
          const conversationId = obj.conversation_id
          if (typeof conversationId !== 'string') return []
          return [{ kind: 'init', conversationId }]
        }
        case 'step_update': {
          const su = obj.step_update
          if (su === null || typeof su !== 'object') return []
          return handleStepUpdate(su as Record<string, unknown>)
        }
        case 'result': {
          const result = obj.result
          if (result === null || typeof result !== 'object') return []
          return handleResult(result as Record<string, unknown>)
        }
        default:
          // Unknown event kind — silently skip per spec §6 risk①.
          return []
      }
    },
    flush(): AgyStreamEvent[] {
      return flushPending()
    },
  }
}
