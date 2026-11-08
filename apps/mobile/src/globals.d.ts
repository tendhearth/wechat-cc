/** phone.html 首个 <script> 里由 daemon 填的两个全局,和公网壳页(relay/pset.html)注入的 __CC_SHELL__。 */
declare var T: string
declare var REMOTE: { relay: string; id: string } | null
interface Window { __CC_SHELL__?: { relay: string; id: string } }

/**
 * packages/protocol 打包出的 IIFE(apps/mobile/src/protocol-generated.js,
 * sources.ts 的 readMobileSource 原地换进 transport.js 顶部的占位注释)挂的
 * 全局 —— 跟原生 App 同一个协议客户端(说 v2)。形状照抄
 * packages/protocol/src/browser.ts 的 CCP 常量与 client-types.ts,手改哪边都要带上另一边。
 */
interface CCPSocket {
  send(s: string): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (s: string) => void): void
  onClose(cb: () => void): void
}
interface CCPResponse { status: number; headers: Record<string, string>; body: Uint8Array; text(): string; json<T = any>(): T }
interface CCPClient {
  version(): 2 | null
  request(r: { method: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array; retry?: boolean }): Promise<CCPResponse>
  subscribe(topic: string, onEvent: (data: unknown, meta: { epoch: string; seq: number }) => void): () => void
  close(): void
}
declare var CCP: {
  b64u: { encode(bytes: Uint8Array): string; decode(s: string): Uint8Array }
  makeProtocolClient(opts: {
    open: () => CCPSocket
    token: string
    client?: 'web'; build?: string
    requestTimeoutMs?: number
    handshakeTimeoutMs?: number
    onSubscriptionError?: (topic: string, code: string) => void
    onProtocolError?: (reason: string, detail?: unknown) => void
  }): CCPClient
  /** 状态表与中文词(packages/protocol/src/status-table.ts,设计稿 2026-10-31 U5)。 */
  STATUS_TABLE: Record<'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped', { word: string; icon: string | null; tone: 'accent' | 'inkSoft'; group: 'waiting' | 'working' | 'back' }>
  STATUS_WORDS: Record<'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped', string>
  HOME_GROUP_WORDS: Record<'waiting' | 'working' | 'back', string>
  /** 「在做」却这么久没动静 ⇒ 提示可能卡住(ms)。 */
  QUIET_AFTER_MS: number
  ROW_HINT_WORDS: { quiet: string; pendingTotal: string }
}
