/**
 * Pure NDJSON parser for cursor-agent's `--output-format stream-json`.
 *
 * Shapes are the OBSERVED behavior of cursor-agent 2026.08.11 (live spike,
 * 2026-08-25 — the stream is claude-code-flavored):
 *   {"type":"system","subtype":"init","session_id":"…","model":"Auto",…}
 *   {"type":"user","message":{…}}                       — echo, skipped
 *   {"type":"thinking","subtype":"delta"|"completed",…} — skipped
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"…",
 *    "session_id":"…","request_id":"…"}
 *
 * There is no published contract — like agy-stream.ts, unknown `type`s and
 * unknown content-block types are silently skipped (forward compatibility),
 * never thrown on.
 */

export type CursorStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; tool: string; server?: string }
  | { kind: 'result'; sessionId: string }
  | { kind: 'error'; message: string }

export interface CursorStreamParser {
  feed(line: string): CursorStreamEvent[]
  /** Nothing is aggregated across lines today; kept for parser-shape parity. */
  flush(): CursorStreamEvent[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function makeCursorStreamParser(): CursorStreamParser {
  return {
    feed(line: string): CursorStreamEvent[] {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return []
      }
      if (!isPlainObject(parsed)) return []
      const type = parsed.type
      if (typeof type !== 'string') return []

      if (type === 'system') {
        if (parsed.subtype !== 'init') return []
        const sessionId = parsed.session_id
        return typeof sessionId === 'string' && sessionId !== '' ? [{ kind: 'init', sessionId }] : []
      }

      if (type === 'assistant') {
        const message = parsed.message
        if (!isPlainObject(message) || !Array.isArray(message.content)) return []
        const out: CursorStreamEvent[] = []
        for (const block of message.content) {
          if (!isPlainObject(block)) continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            out.push({ kind: 'text', text: block.text })
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            out.push({ kind: 'tool_call', tool: block.name })
          }
        }
        return out
      }

      if (type === 'tool_call') {
        // 真实形状(2026-09-08 用 cursor-agent -p --output-format stream-json
        // 现场抓的,不是从 claude-code 类推的):
        //
        //   {"type":"tool_call","subtype":"started",
        //    "tool_call":{"mcpToolCall":{"args":{
        //        "name":"wechat-cc:wechat-ping",
        //        "serverIdentifier":"wechat-cc:wechat",
        //        "toolName":"ping"}}}}
        //
        //   内置工具则是判别键换个名字,参数各不相同:
        //   {"tool_call":{"readToolCall":{"args":{"path":…}}}}
        //
        // 顶层**没有** `name` 字段 —— 老代码读 parsed.name,永远 undefined,
        // 于是整条 cursor CLI 路一个 tool_call 事件都没发过:真机
        // [TURN] provider=cursor 那行 tools= 是空的,replyToolCalled 恒 false,
        // FALLBACK_REPLY 每轮把模型的心里话当回复发出去(主人截图:正文之后
        // 跟着「查一下洛杉矶此刻天气,再用微信回复你。」+「已回你微信了。」)。
        //
        // started/completed 同一次调用发两遍,只认 started,免得算重。
        if (parsed.subtype !== undefined && parsed.subtype !== 'started') return []
        const call = parsed.tool_call
        if (isPlainObject(call)) {
          const mcp = call.mcpToolCall
          if (isPlainObject(mcp) && isPlainObject(mcp.args)) {
            const a = mcp.args
            const tool = typeof a.toolName === 'string' ? a.toolName : undefined
            const server = typeof a.serverIdentifier === 'string' ? a.serverIdentifier
              : typeof a.providerIdentifier === 'string' ? a.providerIdentifier
              : undefined
            // toolName 缺失时退回复合名(`wechat-cc:wechat-ping`)—— 有名字
            // 总比丢掉整条事件强,日志里还能看出调了什么。
            const fallbackName = typeof a.name === 'string' ? a.name : undefined
            if (tool !== undefined) return [server !== undefined ? { kind: 'tool_call', tool, server } : { kind: 'tool_call', tool }]
            if (fallbackName !== undefined) return [{ kind: 'tool_call', tool: fallbackName }]
            return []
          }
          // 内置工具:判别键形如 `<name>ToolCall`,取前缀当工具名。
          for (const key of Object.keys(call)) {
            const m = /^(.+)ToolCall$/.exec(key)
            if (m && m[1]) return [{ kind: 'tool_call', tool: m[1] }]
          }
        }
        // 未知形状 —— 保留老的顶层 name 兜底,认不出就静默跳过。
        const name = (parsed as { name?: unknown }).name
        return typeof name === 'string' ? [{ kind: 'tool_call', tool: name }] : []
      }

      if (type === 'result') {
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
        const isError = parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype !== 'success')
        if (!isError) return [{ kind: 'result', sessionId }]
        const detail = typeof parsed.result === 'string' && parsed.result !== ''
          ? parsed.result
          : `subtype=${String(parsed.subtype ?? 'unknown')}`
        return [{ kind: 'error', message: `cursor-agent result error: ${detail}` }]
      }

      // user echo / thinking / unknown — skip.
      return []
    },
    flush(): CursorStreamEvent[] {
      return []
    },
  }
}
