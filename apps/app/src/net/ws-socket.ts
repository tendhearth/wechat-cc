import type { ProtocolSocket } from '@wechat-cc/protocol'

/** RN / 浏览器形状的 WebSocket(构造函数可注入,测试用假的)。 */
export type WsLike = {
  send(s: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
}
export type WsCtor = new (url: string) => WsLike

/**
 * WebSocket → 协议包的 ProtocolSocket。协议只走文本帧;RN 有时只报 error 不报 close,
 * 这里保证 onClose 恰好一次(协议客户端据此退避重连)。
 */
export function makeWsSocket(url: string, Ws: WsCtor): ProtocolSocket {
  const ws = new Ws(url)
  let openCb: (() => void) | null = null
  let msgCb: ((s: string) => void) | null = null
  let closeCb: (() => void) | null = null
  let closed = false
  const fireClose = () => {
    if (closed) return
    closed = true
    try { ws.close() } catch { /* 已关 */ }
    closeCb?.()
  }
  ws.onopen = () => { if (!closed) openCb?.() }
  ws.onmessage = ev => { if (!closed && typeof ev.data === 'string') msgCb?.(ev.data) }
  ws.onerror = () => fireClose()
  ws.onclose = () => fireClose()
  return {
    send: s => ws.send(s),
    close: fireClose,
    onOpen: cb => { openCb = cb },
    onMessage: cb => { msgCb = cb },
    onClose: cb => { closeCb = cb },
  }
}
