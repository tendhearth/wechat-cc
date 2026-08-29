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
  | { kind: 'tool_call'; tool: string }
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
        // Not observed in the spike but plausibly claude-code-shaped; surface
        // a name when one exists, otherwise skip silently.
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
