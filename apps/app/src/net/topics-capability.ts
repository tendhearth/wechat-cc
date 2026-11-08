import { ServerHello, type ProtocolSocket } from '@wechat-cc/protocol'
/** Observe the explicit hello capability; protocol client still owns handshake validation and all crypto. */
export function observeTopics(socket: ProtocolSocket, advertise: (supported: boolean) => void): ProtocolSocket {
  advertise(false)
  return {
    send: s => socket.send(s), close: () => socket.close(), onOpen: cb => socket.onOpen(cb), onClose: cb => socket.onClose(() => { advertise(false); cb() }),
    onMessage: cb => socket.onMessage(s => {
      try { const hello = ServerHello.safeParse(JSON.parse(s)); if (hello.success) advertise(hello.data.v === 2 && hello.data.topics === 'v1') } catch { /* Protocol client reports malformed frames. */ }
      cb(s)
    }),
  }
}
