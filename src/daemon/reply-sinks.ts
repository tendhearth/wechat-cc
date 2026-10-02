/**
 * Reply-sink registry — app-conversation-channel voice arc, Stage 0
 * (see .superpowers/sdd/task-1-brief.md).
 *
 * When the app channel is driving a turn for a chat, it `open()`s a sink
 * for that chatId before dispatching the turn. While the sink is open,
 * the `POST /v1/wechat/reply` route (src/daemon/internal-api/routes.ts)
 * captures the raw reply text here instead of ilink-sending it to WeChat.
 * `close()` deregisters the sink and returns the concatenated captured
 * text so the app channel can hand it back to its caller.
 */
export interface ReplySinks {
  /**
   * Register a capture buffer for chatId; returns a handle. Throws if one
   * is already active for chatId (in-flight guard should prevent this).
   */
  open(chatId: string): { close(): string }
  /**
   * Called by the reply route: if a sink is open for chatId, append text
   * and return true (caller must NOT ilink-send); else false.
   */
  capture(chatId: string, text: string): boolean
}

export function makeReplySinks(): ReplySinks {
  const sinks = new Map<string, string[]>()

  return {
    open(chatId: string) {
      if (sinks.has(chatId)) throw new Error('reply_sink_busy')
      sinks.set(chatId, [])
      return {
        close(): string {
          const buf = sinks.get(chatId) ?? []
          sinks.delete(chatId)
          return buf.join('\n')
        },
      }
    },
    capture(chatId: string, text: string): boolean {
      const buf = sinks.get(chatId)
      if (!buf) return false
      // 空白不是一条回复:照样认领(绝不能漏到微信),但不进拼接 —— 否则
      // close() 拼出一行空行,App 那头看到的就是一条「空消息」(2026-10-02)。
      if (text.trim()) buf.push(text)
      return true
    },
  }
}
