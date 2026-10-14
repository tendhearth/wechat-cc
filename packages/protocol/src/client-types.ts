/**
 * client-types.ts — 协议客户端(`client.ts`)的对外接口。单独成文件,好让
 * 调用方(RN app、CLI 自检)只看这一份就知道要实现/能用什么。
 */

/**
 * 一条到中继的双向文本连接。调用方把 RN / 浏览器 / Node 的 WebSocket 包成这个
 * 形状;客户端每次重连都调一次 `ClientOpts.open()` 拿一个新的。
 */
export interface ProtocolSocket {
  /**
   * 发一帧文本。只会在 `onOpen` 回调触发之后调用(客户端等 open 才发握手,
   * 适配器不需要缓冲)。抛错会被客户端吞掉并记为 `send_failed`。
   */
  send(s: string): void
  /** 主动关闭。可重复调用;关闭后可以(但不必)再触发 `onClose`。 */
  close(): void
  /** 连接建立(WebSocket 的 open 事件)。客户端在这里发握手 `{hs, v:[1,2]}`。 */
  onOpen(cb: () => void): void
  /** 收到一帧文本(WebSocket message 事件的 data)。 */
  onMessage(cb: (s: string) => void): void
  /** 连接断开(close 事件;error 之后通常也会 close)。客户端据此按退避重连。 */
  onClose(cb: () => void): void
}

/** 连接状态(给 app 的连接状态机用,见 apps/app/src/net/connection.ts)。 */
export type ClientStatus = 'connecting' | 'ready' | 'down' | 'auth_failed'

export interface ClientOpts {
  /** 新建一条连接(每次重连调一次)。 */
  open: () => ProtocolSocket
  /** 设备/链接令牌:只进 HKDF salt 绑定密钥,从不上线。 */
  token: string
  /** 单次请求尝试的超时,缺省 15 s。 */
  requestTimeoutMs?: number
  /** 握手期限:open 起算到收到后台 `{hs}`,超时就断开按退避重连。缺省 = requestTimeoutMs。 */
  handshakeTimeoutMs?: number
  /**
   * 请求超时后最多再试几次,缺省 1。只作用于可重试的请求:GET/HEAD 缺省可重试,
   * 其它方法需在请求里显式 `retry: true`。重试沿用同一个 rid(后台可据此去重);
   * 超时时若这条连接自请求发出后什么都没收到,先丢掉连接,重试走新握手。
   */
  retries?: number
  /**
   * 一个请求从 `request()` 起的总期限。到期时还没发出去(一直连不上/握不上手)⇒
   * 以 `unreachable` 拒绝;到期时在途 ⇒ 这次超时后不再重试。等连接的时间不耗
   * 重试次数。缺省 = (requestTimeoutMs + handshakeTimeoutMs + 15 s 退避封顶) ×
   * (该请求可用的重试次数 + 1):每次尝试都够一整轮「退避 → 握手 → 等回复」。
   */
  requestDeadlineMs?: number
  /**
   * 保活间隔,缺省 30 s,0 关掉。v2 连接上挂着订阅、又没有挂起请求时,这么久什么都没收到就发
   * 一个 `ping`;`requestTimeoutMs` 内一帧都没回来 ⇒ 当死连接丢掉、退避重连、带 since 重新订阅。
   * v1 连接从不发。
   */
  keepaliveMs?: number
  /**
   * 只接受 v2(2026-10-10)。版本协商是明文,中继能把双方的 `v` 剥掉、降到没有防重放的 v1,
   * 再把抓到的密封请求重放。只跟会说 v2 的后台打交道的客户端(原生 app)应当打开:
   * 后台回的 hello 不是 v2 ⇒ 报 `downgrade_refused`、断开按退避重连,绝不走 v1。缺省 false(老后台照旧能连)。
   */
  requireV2?: boolean
  /** 时钟(毫秒),缺省 Date.now。用于判断连接是否稳定到可以清零退避。 */
  now?: () => number
  /** 丢弃了一条畸形/无法解密的线上消息,或 hello 畸形(只做记录)。 */
  onProtocolError?: (reason: string, detail?: unknown) => void
  /** 订阅被后台拒绝(`err{sid}`)或老后台不支持订阅;该订阅随即作废。 */
  onSubscriptionError?: (topic: string, code: string) => void
  /**
   * 连接状态变化:开始一条新连接 `connecting`;握手完成 `ready`;这条连接作废 `down`(之后按退避重连,
   * 或没事可做就不连);明文 `auth_failed` ⇒ `auth_failed`(致命,不会再连,之后不再报)。`close()` 之后不再报。
   * 钩子抛错被吞掉。
   */
  onStatus?: (s: ClientStatus) => void
}

export interface ProtocolRequest {
  method: string
  path: string
  headers?: Record<string, string>
  /** 字符串按 utf8 发;Uint8Array 按 base64 发(老后台 v1 不支持,拒绝 binary_body_needs_v2)。 */
  body?: string | Uint8Array
  /**
   * 超时后是否重试(次数见 `ClientOpts.retries`)。缺省:GET/HEAD 为 true,其它为
   * false —— 非幂等请求重发可能被执行两遍;确认后台按 rid 去重或请求本身幂等时再开。
   */
  retry?: boolean
}

export interface ProtocolResponse {
  status: number
  /** v1 后台没有响应头,恒为 `{}`。 */
  headers: Record<string, string>
  body: Uint8Array
  text(): string
  json<T>(): T
}

export interface EventMeta { epoch: string; seq: number }

export interface ProtocolClient {
  /** 最近一次握手协商出的版本;还没握过手为 null。 */
  version(): 1 | 2 | null
  request(r: ProtocolRequest): Promise<ProtocolResponse>
  /** 老后台(v1)下抛 Error('subscriptions_need_v2')。返回取消函数(幂等)。 */
  subscribe(topic: string, onEvent: (data: unknown, meta: EventMeta) => void): () => void
  close(): void
}
