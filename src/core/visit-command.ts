/**
 * visit-command.ts — 微信里的「串门」触发词。确定性解析,和 揭晓/回信 同款。
 *
 *   串门                → 去第一条开着的信道
 *   串门 <通道前缀>      → 去指定那条
 *   /visit [<前缀>]     → 同上(英文别名)
 */
export function parseVisitCommand(text: string): { channel?: string } | null {
  const m = /^\s*(?:串门|去串门|出去串个门|\/visit)(?:\s+([A-Za-z0-9:\-]{2,}))?\s*[!！。]?\s*$/.exec(text)
  if (!m) return null
  return m[1] ? { channel: m[1] } : {}
}
