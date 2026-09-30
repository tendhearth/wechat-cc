/**
 * Room —— 每个 daemon 一个的 Durable Object(spec §3–§6)。
 *
 * 持有这台 daemon 唯一的已认证 WebSocket 与连进来的手机流,沿用老中继的 `{stream, frame}` 包装转发;
 * 执行限额;存推送登记并调 APNs / FCM。休眠 API:内存状态随时会丢,一切路由都能从 socket
 * attachment 重建 —— daemon socket 的 attachment 记着 authed / authedAt / replaced,手机的记着 stream。
 *
 * 僵尸 socket(老中继的 bug,spec §2 #2):关闭处理只在「关掉的正是当前 daemon、且没有别的当前 daemon」
 * 时才清手机流;被替换的、没登录的 socket 断开什么也不动。
 */
import { DurableObject } from 'cloudflare:workers'
import { b64uEncode, DaemonControl, RELAY_SUBPROTOCOL, verifyRelayLogin, type RelayError } from '@wechat-cc/protocol'
import { limitsFrom, type Limits } from './limits'
import { count } from './metrics'

export type DaemonAtt = { role: 'daemon'; id: string; challenge: string; openedAt: number; authed: boolean; authedAt: number; replaced: boolean }
export type PhoneAtt = { role: 'phone'; stream: string }
export type Att = DaemonAtt | PhoneAtt

export function expiredLogins(atts: readonly DaemonAtt[], now: number, timeoutMs: number): DaemonAtt[] {
  return atts.filter(a => !a.authed && a.openedAt + timeoutMs <= now)
}

export class Room extends DurableObject<Env> {
  protected limits: Limits

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.limits = limitsFrom(env)
    // daemon 心跳用固定串,边缘直接回、不唤醒房间(tunnel-client 发 {"ping":1})。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":1}', '{"pong":1}'))
  }

  protected att(ws: WebSocket): Att | null {
    try { return ws.deserializeAttachment() as Att | null } catch { return null }
  }

  protected sendJson(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)) } catch { /* 已经关了 */ }
  }

  protected fail(ws: WebSocket, code: RelayError, closeCode: number): void {
    count(this.env, `error_${code}`)
    this.sendJson(ws, { error: code })
    try { ws.close(closeCode, code) } catch { /* 已经关了 */ }
  }

  /** 当前 daemon:已认证、未被替换、authedAt 最大的那条(可排除一条正在关的)。 */
  protected currentDaemon(exclude?: WebSocket): WebSocket | null {
    let best: WebSocket | null = null
    let bestAt = -1
    for (const ws of this.ctx.getWebSockets('daemon')) {
      if (ws === exclude) continue
      const a = this.att(ws)
      if (a?.role !== 'daemon' || !a.authed || a.replaced) continue
      if (a.authedAt > bestAt) { best = ws; bestAt = a.authedAt }
    }
    return best
  }

  async fetch(req: Request): Promise<Response> {
    const role = req.headers.get('x-relay-role')
    const id = req.headers.get('x-relay-id') ?? ''
    if (role === 'daemon') return this.openDaemon(id)
    if (role === 'phone') return this.onPhoneOpen()
    return new Response('bad role', { status: 400 })
  }

  private async openDaemon(id: string): Promise<Response> {
    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ['daemon'])
    const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
    const a: DaemonAtt = { role: 'daemon', id, challenge, openedAt: Date.now(), authed: false, authedAt: 0, replaced: false }
    server.serializeAttachment(a)
    this.sendJson(server, { challenge, ts: a.openedAt })
    const due = a.openedAt + this.limits.loginTimeoutMs
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > due) await this.ctx.storage.setAlarm(due)
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL } })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const socks = this.ctx.getWebSockets('daemon')
    const pending: Array<[WebSocket, DaemonAtt]> = []
    for (const ws of socks) { const a = this.att(ws); if (a?.role === 'daemon' && !a.authed) pending.push([ws, a]) }
    const expired = new Set(expiredLogins(pending.map(p => p[1]), now, this.limits.loginTimeoutMs))
    let next: number | null = null
    for (const [ws, a] of pending) {
      if (expired.has(a)) this.fail(ws, 'login_failed', 4001)
      else next = Math.min(next ?? Infinity, a.openedAt + this.limits.loginTimeoutMs)
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return   // 协议全是 JSON 文本
    const a = this.att(ws)
    if (!a) return
    if (a.role === 'phone') { await this.onPhoneMessage(ws, a, message); return }
    if (!a.authed) { this.onLogin(ws, a, message); return }
    await this.onDaemonData(ws, message)
  }

  private onLogin(ws: WebSocket, a: DaemonAtt, raw: string): void {
    let obj: unknown
    try { obj = JSON.parse(raw) } catch { this.fail(ws, 'login_failed', 4001); return }
    const m = DaemonControl.safeParse(obj)
    if (!m.success || !('pub' in m.data) || !verifyRelayLogin(a.id, a.challenge, m.data.pub, m.data.sig)) {
      this.fail(ws, 'login_failed', 4001)
      return
    }
    // 新的已认证连接替换旧的:先把旧的标成 replaced 再关,它的 close 回调就什么也不动。
    for (const old of this.ctx.getWebSockets('daemon')) {
      if (old === ws) continue
      const oa = this.att(old)
      if (oa?.role === 'daemon' && oa.authed && !oa.replaced) {
        old.serializeAttachment({ ...oa, replaced: true })
        try { old.close(4000, 'replaced') } catch { /* 已经关了 */ }
      }
    }
    ws.serializeAttachment({ ...a, authed: true, authedAt: Date.now(), challenge: '' })
    count(this.env, 'daemon_login')
    this.sendJson(ws, { login_ok: true })
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code) } catch { /* 已经关了 */ }
    const a = this.att(ws)
    if (!a) return
    if (a.role === 'phone') { this.onPhoneClose(ws, a); return }
    if (a.authed && !a.replaced && !this.currentDaemon(ws)) this.onDaemonGone()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011)
  }

  // ── Task 5 / Task 7 填的钩子 ───────────────────────────────────────
  protected async onDaemonData(_ws: WebSocket, _raw: string): Promise<void> { /* Task 5 */ }
  protected async onPhoneOpen(): Promise<Response> { return new Response('not implemented', { status: 501 }) }
  protected async onPhoneMessage(_ws: WebSocket, _a: PhoneAtt, _raw: string): Promise<void> { /* Task 5 */ }
  protected onPhoneClose(_ws: WebSocket, _a: PhoneAtt): void { /* Task 5 */ }
  protected onDaemonGone(): void { /* Task 5 */ }
}
