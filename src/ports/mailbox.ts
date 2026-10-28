/**
 * 信箱的口(架构终态 E5):中继上的信封、信箱身份、出站客户端、配对码推出来的会面身份。实现在
 * src/adapters/mailbox/(要 node:crypto,app 拿不了);app 的配对引擎只经这里认它们的形状,
 * 加解密经 `PairingCrypto` 由组装的地方(daemon/bootstrap/wire-pairing.ts)注入。只有类型,没有逻辑。
 * 见 spec §3.1 / §3.2 / §4。
 */

export interface Envelope { eph_pub: string; nonce: string; ct: string; tag: string }
export interface EnvelopeInner { path: string; bearer: string; body: unknown }
export interface PeerMailbox { addr: string; enc_pub: string; relays: string[] }
export interface MailboxIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

/**
 * Outbound HTTP to a relay (/drop, /fetch, /ack). Pure HTTP, timeout-bounded,
 * no app logic — the mailbox analogue of a2a-client.ts. See spec §3.1.
 */
export interface MailboxClient {
  drop(relayUrl: string, to: string, envelope: string): Promise<boolean>
  fetch(relayUrl: string, mailbox: string, since: number, ts: number, sig: string): Promise<{ items: Array<{ cursor: number; envelope: string }>; next_cursor: number } | null>
  ack(relayUrl: string, mailbox: string, upToCursor: number, ts: number, sig: string): Promise<boolean>
}

/** Same shape as MailboxIdentity — usable by sealEnvelope/openEnvelope/signFetch. */
export interface RendezvousIdentity { addr: string; enc_pub: string; enc_priv: string; sign(message: string): string }

/**
 * 配对引擎要的那几样加密(spec §4):从配对码推会面身份、封 / 拆信封、给取件签名。
 * 实现是 adapters/mailbox 里的同名函数,原样转交 —— 引擎自己不碰 node:crypto。
 */
export interface PairingCrypto {
  deriveRendezvous(code: string): RendezvousIdentity
  sealEnvelope(inner: EnvelopeInner, peerEncPub: string): Envelope
  openEnvelope(myEncPriv: string, env: Envelope): EnvelopeInner | null
  signFetch(sign: (m: string) => string, mailbox: string, ts: number): string
}
