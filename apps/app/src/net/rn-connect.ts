import { makeProtocolClient, type ProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { makeWsSocket, type WsCtor } from './ws-socket'

/** RN 的全局 WebSocket(形状与 WsLike 一致)。 */
export const rnSocket = (url: string): ProtocolSocket => makeWsSocket(url, WebSocket as unknown as WsCtor)
/** 配对时用的一次性协议客户端。 */
export const rnConnect = (url: string, token: string): ProtocolClient => makeProtocolClient({ open: () => rnSocket(url), token })
