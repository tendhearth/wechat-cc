/**
 * visit-command.ts — 微信里的「串门」触发词。确定性解析,和 揭晓/回信 同款。
 *
 *   串门                → 有真信道去真的,没有去邻居家
 *   串门 邻居 / 串门 阿柚 → 指定去邻居家(某一位)
 *   串门 <通道前缀>      → 去指定那条真信道
 *   /visit [<目标>]     → 同上(英文别名)
 */
export function parseVisitCommand(text: string): { channel?: string } | null {
  const m = /^\s*(?:串门|去串门|出去串个门|\/visit)(?:\s+([A-Za-z0-9:\-\u4e00-\u9fff]{2,}))?\s*[!！。]?\s*$/.exec(text)
  if (!m) return null
  return m[1] ? { channel: m[1] } : {}
}
