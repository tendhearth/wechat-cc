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
 *
 * 回复交付(spec 2026-10-03 §4.3 第 2 步 / §4.10):新路径的 provider 不调 reply 工具,daemon 把
 * **整个** TurnReply 经 `captureReply` 交过来 —— 文字照常拼进 close(),附件与旁白从 `extras()` 取,
 * 桌面 / 手机显示(旁白是灰色过程行)。语音 / 表情从此不会在 app 这一轮里漏到微信。
 */
import type { TurnAttachment, TurnReply } from '../core/turn-reply'

export interface SinkExtras { attachments: TurnAttachment[]; narration: string[] }

export interface ReplySinkHandle {
  close(): string
  /** 新交付路径交过来的附件与旁白(close 之前读)。旧路径 ⇒ 两个空数组。 */
  extras?(): SinkExtras
}

export interface ReplySinks {
  /**
   * Register a capture buffer for chatId; returns a handle. Throws if one
   * is already active for chatId (in-flight guard should prevent this).
   */
  open(chatId: string): ReplySinkHandle
  /**
   * Called by the reply route: if a sink is open for chatId, append text
   * and return true (caller must NOT ilink-send); else false.
   */
  capture(chatId: string, text: string): boolean
  /** 新交付路径:收下整个 TurnReply。没开 ⇒ false(调用方走微信)。 */
  captureReply?(chatId: string, reply: TurnReply): boolean
  /** 这个 chat 此刻有没有开着的接收器(长任务进度据此决定进不进微信)。 */
  isOpen?(chatId: string): boolean
}

interface Buf { texts: string[]; attachments: TurnAttachment[]; narration: string[] }

export function makeReplySinks(): ReplySinks {
  const sinks = new Map<string, Buf>()

  return {
    open(chatId: string) {
      if (sinks.has(chatId)) throw new Error('reply_sink_busy')
      const buf: Buf = { texts: [], attachments: [], narration: [] }
      sinks.set(chatId, buf)
      return {
        close(): string {
          if (sinks.get(chatId) === buf) sinks.delete(chatId)
          return buf.texts.join('\n')
        },
        extras: () => ({ attachments: [...buf.attachments], narration: [...buf.narration] }),
      }
    },
    capture(chatId: string, text: string): boolean {
      const buf = sinks.get(chatId)
      if (!buf) return false
      // 空白不是一条回复:照样认领(绝不能漏到微信),但不进拼接 —— 否则
      // close() 拼出一行空行,App 那头看到的就是一条「空消息」(2026-10-02)。
      if (text.trim()) buf.texts.push(text)
      return true
    },
    captureReply(chatId, reply) {
      const buf = sinks.get(chatId)
      if (!buf) return false
      if (!reply.silent && reply.text.trim()) buf.texts.push(reply.text)
      buf.attachments.push(...reply.attachments)
      buf.narration.push(...reply.narration)
      return true
    },
    isOpen: (chatId) => sinks.has(chatId),
  }
}
