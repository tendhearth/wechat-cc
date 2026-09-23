/**
 * outbound-taps.ts — 旁听某个 chat 这一轮发出去的助手文本。
 *
 * 和 reply-sinks.ts 的区别是**要害**:reply sink 是**改道**(拦下来不发
 * 微信,交给 app 通道);tap 是**旁听**(照发不误,只留一份副本)。打猎
 * 需要的是后者 —— 消息必须照常到主人手上,同时被记进战利品清单。
 *
 * 用法(打猎那一拍):
 *   const t = taps.tap(chatId)
 *   await dispatch(...)
 *   huntStore.recordHunt({ chatId, text: t.close().join('\n\n') })
 *
 * 刻意不抛异常:同一个 chat 已经有 tap 时返回一个空壳句柄,而不是像
 * reply sink 那样 throw。这条路径上抛异常会**打断一次真实的打猎发送**,
 * 而重复 tap 最坏的后果只是少记一次。
 */
export interface OutboundTap { close(): string[] }

export interface OutboundTaps {
  tap(chatId: string): OutboundTap
  /** 发送路径调用。没人旁听时是一次 Map 查找,可以无条件调。 */
  observe(chatId: string, text: string): void
}

const NOOP: OutboundTap = { close: () => [] }

export function makeOutboundTaps(): OutboundTaps {
  const taps = new Map<string, string[]>()
  return {
    tap(chatId) {
      if (taps.has(chatId)) return NOOP
      taps.set(chatId, [])
      return {
        close(): string[] {
          const buf = taps.get(chatId) ?? []
          taps.delete(chatId)
          return buf
        },
      }
    },
    observe(chatId, text) {
      const buf = taps.get(chatId)
      if (buf) buf.push(text)
    },
  }
}
