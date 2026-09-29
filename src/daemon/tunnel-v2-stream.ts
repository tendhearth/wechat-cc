/**
 * tunnel-v2-stream.ts — 隧道一条手机流上的 v2 协议处理(2026-09-29,手机协议 v2 第 10 步)。
 * 由 tunnel-client.ts 在握手协商出 v2、且首个密封帧认出设备之后创建;一条流一次握手
 * 一个实例、一条 V2Channel(同一组密钥永不重建 —— 计数器 nonce 复用)。
 *
 *   - 帧由 tunnel-client 按流串行喂进来(计数器检查依赖到达顺序)。重放 / 认证失败的帧
 *     丢掉、流不断,每条流只记一次日志。
 *   - `req`:跟 v1 同一套 URL 改写(去 d/t、注入认证过的 d= 与 _via=tunnel),交给面板;
 *     `res` 带全部响应头,正文按 content-type 判 utf8 / base64。
 *   - `sub` / `unsub`:接到 PhoneEvents 集线器;每条 `ev` 发出前、每个 `req` 处理前
 *     重新核对这条流的令牌还在不在册 —— 不在 ⇒ `onRevoked`(调用方发明文 auth_failed
 *     并忘掉这条流),这里先把订阅全退掉。
 *
 * 线上来的一切先过 zod;不合形状就丢,永不往外抛。
 */
import { V2ClientMessage, SealedV2Frame, b64Encode, b64Decode, deriveV2Keys, makeV2Channel } from '@wechat-cc/protocol'
import type { V2Channel, V2ServerMessageT, ReqMsgT, SubMsgT } from '@wechat-cc/protocol'
import type { PhoneEvents } from './phone-events'
import { phoneTopicAllowed } from './phone-routes'

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

/**
 * 手机给的路径 → 合成的 loopback URL(v1 / v2 共用)。路径已认证但仍是不可信输入:必须以
 * / 开头(否则会拼进 authority 污染 host),畸形的(裸 %、带空格)new URL 会抛 —— 两种都
 * 返回原因字符串让调用方丢弃。d/t 一律剥掉,换成认证过的设备令牌;_via=tunnel 标记来源。
 */
export function tunnelRequestUrl(path: string, device: string | undefined): URL | 'non-absolute' | 'unparseable' {
  if (!path.startsWith('/')) return 'non-absolute'
  let u: URL
  try { u = new URL(`http://127.0.0.1${path}`) } catch { return 'unparseable' }
  u.searchParams.delete('d'); u.searchParams.delete('t')
  if (device) u.searchParams.set('d', device)
  u.searchParams.set('_via', 'tunnel')
  return u
}

/** 文本类 content-type ⇒ utf8,其余 ⇒ base64。 */
export function isTextContentType(ct: string | null): boolean {
  if (!ct) return false
  const mime = ct.split(';')[0]!.trim().toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript' || mime.endsWith('+json')
}

/**
 * 首个 v2 密封帧:对每个候选令牌各建一条新 channel 试开,只留开得了的那条(试错的 channel
 * 密钥是错的,扔掉;开对的那条计数器已经推进到这一帧)。都开不了 ⇒ null。
 */
export function identifyV2(shared: Uint8Array, tokens: string[], frame: unknown): { channel: V2Channel; token: string; plaintext: Uint8Array } | null {
  const sealed = SealedV2Frame.safeParse(frame)
  if (!sealed.success) return null
  for (const token of tokens) {
    const channel = makeV2Channel(deriveV2Keys(shared, token), 'server')
    try { return { channel, token, plaintext: channel.open(sealed.data) } } catch { /* 不是这个令牌 */ }
  }
  return null
}

export interface V2StreamDeps {
  stream: string
  channel: V2Channel
  /** 认证这条流的令牌(设备令牌或 /set 链接令牌)。 */
  token: string
  /** 往这条流发一个帧(已封好的密封帧)。 */
  send: (frame: unknown) => void
  handleRequest: (req: Request) => Promise<Response>
  events?: PhoneEvents
  /** 这条流的令牌此刻还有效吗。 */
  tokenValid: () => boolean
  /** 令牌失效:调用方发明文 auth_failed 并忘掉这条流(订阅这里已经退完)。 */
  onRevoked: () => void
  log: (tag: string, line: string) => void
}

export interface V2Stream {
  /** 已识别设备后的密封帧(首帧的明文由 identifyV2 给出,走 onPlaintext)。
   *  resolve 于开帧 + 分派之后:sub/unsub 在内做完,req 分派出去不等。 */
  onFrame(frame: unknown): Promise<void>
  onPlaintext(pt: Uint8Array): Promise<void>
  /** 退订这条流的全部订阅,之后什么都不再发。幂等。 */
  close(): void
}

export function makeV2Stream(deps: V2StreamDeps): V2Stream {
  const { stream, channel, log } = deps
  const subs = new Map<string, { unsub: (() => void) | null }>()
  let dead = false
  let warnedOpen = false

  function sendMsg(m: V2ServerMessageT): void {
    if (dead) return
    deps.send(channel.seal(utf8.encode(JSON.stringify(m))))
  }

  function close(): void {
    if (dead) return
    dead = true
    for (const e of subs.values()) { try { e.unsub?.() } catch { /* 集线器自己的事 */ } }
    subs.clear()
  }

  /** 令牌还在册 ⇒ true;否则退订、通知调用方关流,返回 false。 */
  function checkToken(): boolean {
    if (dead) return false
    let ok = false
    try { ok = deps.tokenValid() } catch { ok = false }
    if (ok) return true
    log('TUNNEL', `token revoked on ${stream} — closing v2 stream`)
    close()
    deps.onRevoked()
    return false
  }

  async function onReq(m: ReqMsgT): Promise<void> {
    if (!checkToken()) return
    const url = tunnelRequestUrl(m.path, deps.token)
    if (typeof url === 'string') { log('TUNNEL', `${url} path on ${stream} — rejected`); sendMsg({ t: 'err', rid: m.rid, code: 'bad_request' }); return }
    const method = m.method.toUpperCase()
    const init: RequestInit = { method }
    // 手机给的请求头原样透传 —— 面板路由绝不能从请求头取身份(身份只来自上面注入的 d=)。
    const headers: Record<string, string> = { ...(m.headers ?? {}) }
    if (m.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      try { init.body = m.bodyEncoding === 'base64' ? new Uint8Array(b64Decode(m.body)) : m.body }
      catch { sendMsg({ t: 'err', rid: m.rid, code: 'bad_request' }); return }
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
    let req: Request
    try { init.headers = headers; req = new Request(url.toString(), init) }
    catch { sendMsg({ t: 'err', rid: m.rid, code: 'bad_request' }); return }
    let res: Response
    let bytes: Uint8Array
    try {
      res = await deps.handleRequest(req)
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      log('TUNNEL', `handleRequest threw on ${stream}: ${String(e)}`)
      sendMsg({ t: 'err', rid: m.rid, code: 'internal' })
      return
    }
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v })
    const text = isTextContentType(res.headers.get('content-type'))
    sendMsg({
      t: 'res', rid: m.rid, status: res.status, headers: resHeaders,
      body: text ? utf8d.decode(bytes) : b64Encode(bytes),
      bodyEncoding: text ? 'utf8' : 'base64',
    })
  }

  function unsubscribe(sid: string): void {
    const e = subs.get(sid)
    if (!e) return
    subs.delete(sid)
    try { e.unsub?.() } catch { /* 同上 */ }
  }

  function onSub(m: SubMsgT): void {
    if (!deps.events) { sendMsg({ t: 'err', sid: m.sid, code: 'subscriptions_unavailable' }); return }
    if (!phoneTopicAllowed(m.topic)) { sendMsg({ t: 'err', sid: m.sid, code: 'topic_not_allowed' }); return }
    unsubscribe(m.sid)                                   // 同 sid ⇒ 替换
    const entry: { unsub: (() => void) | null } = { unsub: null }
    subs.set(m.sid, entry)
    entry.unsub = deps.events.subscribe(m.topic, m.since, (ev) => {
      if (dead || subs.get(m.sid) !== entry) throw new Error('stale subscription')   // 抛 ⇒ 集线器只摘这一个
      if (!checkToken()) return
      sendMsg({ t: 'ev', sid: m.sid, epoch: ev.epoch, seq: ev.seq, data: ev.data })
    })
    // subscribe 里同步发生的撤销来不及拿到 unsub —— 补退。
    if (dead || subs.get(m.sid) !== entry) entry.unsub()
  }

  async function onPlaintext(pt: Uint8Array): Promise<void> {
    if (dead) return
    let body: unknown
    try { body = JSON.parse(utf8d.decode(pt)) } catch { log('TUNNEL', `v2 non-JSON message on ${stream} — dropped`); return }
    const parsed = V2ClientMessage.safeParse(body)
    if (!parsed.success) { log('TUNNEL', `v2 malformed message on ${stream} — dropped`); return }
    const m = parsed.data
    // req 不在链上等:开帧已按序完成,处理并发(慢的 say 不挡后面的请求)。onReq 自己把
    // 失败回成密封 err;这里只兜住意外(比如 seal 计数器溢出)。
    if (m.t === 'req') void onReq(m).catch(e => log('TUNNEL', `v2 req handler threw on ${stream}: ${String(e)}`))
    else if (m.t === 'sub') { if (checkToken()) onSub(m) }
    else unsubscribe(m.sid)
  }

  return {
    async onFrame(frame) {
      if (dead) return
      const sealed = SealedV2Frame.safeParse(frame)
      let pt: Uint8Array | null = null
      let why = 'malformed'
      if (sealed.success) {
        try { pt = channel.open(sealed.data) } catch (e) { why = e instanceof Error ? e.message : 'auth' }
      }
      if (!pt) {
        if (!warnedOpen) { warnedOpen = true; log('TUNNEL', `v2 ${why} frame on ${stream} — dropped (further drops on this stream not logged)`) }
        return
      }
      await onPlaintext(pt)
    },
    onPlaintext,
    close,
  }
}
