/**
 * internal-api — localhost HTTP entry that the standalone wechat-mcp
 * stdio MCP server (RFC 03 §5) calls back into for tool implementations
 * (reply, memory, voice, projects, ...). Without this, the stdio MCP
 * subprocess would have no way to reach the daemon's ilink connection,
 * memory directory, etc.
 *
 * Trust model:
 *   - Binds 127.0.0.1 only (never reachable off-host)
 *   - Random port (binds to :0, captures actual port post-listen)
 *   - 32-byte random bearer token written to <stateDir>/internal-token
 *     mode 0600. MCP children read it and present in Authorization header.
 *   - Constant-time compare via crypto.timingSafeEqual
 *
 * Token rotation: a fresh token is generated on every daemon start. If
 * a stale MCP child has an old token, it gets 401 — handled by the
 * client by re-reading the token file. (Daemon overwrites in place.)
 *
 * This file owns the server lifecycle and the auth/body/dispatch
 * middleware. Route handler implementations live in ./routes.ts; deps
 * + interface types live in ./types.ts. The split is purely organisational
 * — no behaviour change vs the pre-split monolithic internal-api.ts.
 */
import { writeFileAtomic } from '../../lib/json-file'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { makeTokenRegistry, type TokenInfo } from './token-registry'
import { minTierFor, moduleFor, tierMeets } from './route-tiers'
import type { UserTier } from '../../core/user-tier'
import type { AddressInfo } from 'node:net'
import {
  errMsg,
  LATE_KEYS,
  type InternalApi,
  type InternalApiDeps,
  type RouteTable,
} from './types'
import { makeMaybePrefix, makeRoutes } from './routes'
import { UNDER_TEST_RUNNER } from '../../lib/config'
import { RESPONSE_SCHEMAS } from '@wechat-cc/protocol/desktop-api'

/** 回包对不上响应契约 ⇒ 抛(只在测试里调)。没有契约的路由不核。 */
export function assertResponseContract(routeKey: string, body: unknown): void {
  const schema = RESPONSE_SCHEMAS[routeKey]
  if (!schema) return
  const r = schema.safeParse(body)
  if (!r.success) throw new Error(`response_contract ${routeKey}: ${JSON.stringify(r.error.issues).slice(0, 600)}`)
}
import { computePresence } from './routes-presence'
import { REQUEST_SCHEMAS } from './schema'
import { ALL_CHATS, SEND_SCOPED_ROUTES, sendScopeDecision, sharedTokenTurn } from './send-scope'
import { replyDeliveryFor } from '../../core/capability-matrix'

export type {
  InternalApi,
  InternalApiDeps,
  InternalApiDelegateDep,
  InternalApiIlinkDep,
  InternalApiPrefixDeps,
  LateDeps,
  LateKey,
} from './types'

const TOKEN_FILE = 'internal-token'
// Separate admin-tier credential (option B security fix) — see the
// "OPERATOR token" note in token-registry.ts's module doc comment. Kept in
// its own file (not appended to / merged with TOKEN_FILE) so a process that
// only needs the daemon-wide trusted token never has admin sitting next to
// it on disk.
const OPERATOR_TOKEN_FILE = 'internal-operator-token'

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const tokenPath = join(deps.stateDir, TOKEN_FILE)
  const operatorTokenPath = join(deps.stateDir, OPERATOR_TOKEN_FILE)
  const registry = makeTokenRegistry()
  let server: Server | null = null
  let boundPort: number | null = null
  let token: Buffer | null = null
  // Late binding for conversation controller — wired after buildBootstrap() returns.
  // Routes access deps.conversation at request time; we update the same deps object.
  // (deps is passed by reference to makeRoutes which closes over it, so mutations
  // are visible at request time without any additional indirection.)

  // Bug fix (fix round 1, alongside the routeAllow/TTL security fixes):
  // routes-federation.ts calls `deps.mintSessionToken(...)` directly, but
  // nothing ever assigned that field on the deps object — only test doubles
  // stubbed it, so the real wired route would have thrown `deps.
  // mintSessionToken is not a function` on first use. registry only exists
  // inside this closure, so createInternalApi is the one place that CAN
  // wire it: mutate deps right here (same pattern as the setKnowledge/
  // setPairing/... late-binders below, which also mutate this same `deps`
  // object that `makeRoutes` closed over), before ROUTES is built and long
  // before the HTTP listener can accept a first request.
  function mintSessionToken(tier: UserTier, sessionKey: string, opts?: import('./token-registry').MintTokenOpts): string {
    return registry.mint(tier, sessionKey, opts)
  }
  deps.mintSessionToken = mintSessionToken

  // Resolve the presented bearer to its { tier, origin } via the registry, or
  // null when unknown. Replaces the old single-token authOk so the route layer
  // can enforce the caller's tier (see token-registry.ts / route-tiers.ts).
  function authResolve(req: IncomingMessage): TokenInfo | null {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? '')
    if (!m) return null
    return registry.resolve(m[1]!.toLowerCase())
  }

  function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
    const payload = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', Buffer.byteLength(payload).toString())
    // CORS: echo the request Origin so the dashboard webview (Tauri's
    // `tauri://localhost` / `http://tauri.localhost`, or the dev shim's
    // `http://127.0.0.1:4174`) can read the response. The server only
    // listens on 127.0.0.1, so any caller already passed the trust
    // boundary — echoing is safe and avoids hard-coding origins per
    // platform / dev mode.
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
    res.end(payload)
  }

  const maybePrefix = makeMaybePrefix(deps)
  const ROUTES = makeRoutes({
    deps,
    getDelegate: () => deps.delegate ?? null,
    maybePrefix,
  })
  /**
   * 功能模块自己挂上来的路由(架构终态 A3):路由表里标了 `module: X` 的那几条,由模块 X 在它的 init 里 `mount`。
   * 模块关着 / 坏了 ⇒ 下面的模块门回 module_off / module_degraded;开着但还没挂上(开机途中)⇒ module_starting。
   */
  const MOUNTED: RouteTable = {}

  async function readJsonBody(req: IncomingMessage,maxBytes?:number): Promise<unknown> {
    if(maxBytes!==undefined){
      if(Number(req.headers['content-length'])>maxBytes){req.resume();throw Error('request_body_too_large')}
      return new Promise((resolve,reject)=>{
        const chunks:Buffer[]= [];let bytes=0
        const cleanup=()=>{req.off('data',onData);req.off('end',onEnd);req.off('error',onError);req.off('aborted',onAborted)}
        const onError=(error:Error)=>{cleanup();reject(error)}
        const onAborted=()=>onError(Error('request_aborted'))
        const onData=(chunk:Buffer)=>{
          bytes+=chunk.length
          if(bytes>maxBytes){cleanup();chunks.length=0;req.resume();reject(Error('request_body_too_large'));return}
          chunks.push(chunk)
        }
        const onEnd=()=>{cleanup();try{const text=Buffer.concat(chunks).toString('utf8');resolve(text?JSON.parse(text):null)}catch(error){reject(error)}}
        req.on('data',onData);req.on('end',onEnd);req.on('error',onError);req.on('aborted',onAborted)
      })
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string))
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return null
    return JSON.parse(text)
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = (req.headers.origin && typeof req.headers.origin === 'string') ? req.headers.origin : undefined

    // CORS preflight — browsers strip auth + custom headers off OPTIONS,
    // so it MUST NOT go through authOk. Replying 204 with the standard
    // Access-Control-* headers lets the actual GET/POST proceed with the
    // Authorization header attached. Without this, the dashboard's A2A
    // tab and any other webview fetch silently fails: preflight 401 →
    // browser blocks the real request, no error visible to the user
    // beyond a stale "loading…" or a "未启动?" banner.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
      res.setHeader('Access-Control-Max-Age', '600')  // cache preflight 10 min
      res.end()
      return
    }

    const caller = authResolve(req)
    if (!caller) {
      deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`, {
        event: 'auth_rejected',
        method: req.method,
        url: req.url,
      })
      return send(res, 401, { error: 'unauthorized' }, origin)
    }

    const method = req.method ?? 'GET'

    // self-restart activity (spec 2026-08-03-daemon-self-restart-on-stale-code)
    // — an authenticated non-GET is the owner DOING something in the app, and
    // most of those never touch mw-messages OR SessionManager, so neither of
    // the idle signals would see them. The worst case is not a race but a
    // deterministic one: POST /v1/customer-review kicks off minutes of
    // sequential LLM calls in its own fire-and-forget Set, so a review longer
    // than IDLE_QUIET_MS would ALWAYS look idle, and restarting mid-review
    // makes the next boot reclaim it as `failed` — the owner sees "分析失败"
    // with no reason and the spent tokens gone. Marking here covers that plus
    // plugin install/upgrade, import-local, a2a install, memory write, penpal,
    // voice config — the whole class, at the one place they all pass through.
    //
    // GET is deliberately excluded: the desktop dashboard polls GETs every 5s
    // forever, so marking those would pin quietFor() below the threshold for
    // as long as the app is open and disable self-restart entirely.
    if (method !== 'GET') {
      try { deps.markInboundActivity?.() } catch { /* 绝不能因为记一笔就打断请求 */ }
    }

    const rawUrl = req.url ?? '/'
    const url = new URL(rawUrl, 'http://internal')
    const routeKey = `${method} ${url.pathname}`
    const route = ROUTES[routeKey] ?? MOUNTED[routeKey]

    if (!route && !moduleFor(routeKey)) {
      return send(res, 404, { error: 'not_found', method, url: rawUrl }, origin)
    }

    // Tier gate: the caller's tier (from its token) must meet the route's
    // declared minimum. Unlisted routes default to admin (fail-closed).
    const need = minTierFor(routeKey)
    if (!tierMeets(caller.tier, need)) {
      deps.log?.('INTERNAL_API', `403 ${routeKey} caller=${caller.tier} need=${need}`, {
        event: 'tier_denied', path: routeKey, caller: caller.tier, required: need,
      })
      return send(res, 403, { error: 'forbidden', required: need }, origin)
    }

    // Route-allow gate: some tokens (currently the operator token — see
    // token-registry.ts's "ROUTE-SCOPING" doc note) are restricted to a
    // fixed set of routes regardless of their tier, so an admin-tier grant
    // that leaks doesn't hand out the whole admin surface. Checked after
    // the tier gate so a route-scoped token still needs the right tier too.
    if (caller.routeAllow && !caller.routeAllow.has(routeKey)) {
      deps.log?.('INTERNAL_API', `403 ${routeKey} caller=${caller.tier}/${caller.origin} route_not_allowed`, {
        event: 'route_not_allowed', path: routeKey, caller: caller.tier, origin: caller.origin,
      })
      return send(res, 403, { error: 'route_not_allowed' }, origin)
    }

    // Module gate(第三批 3b,设计稿 2026-10-22-daemon-module-design):表里标了 module 的路由,那个模块此刻
    // 不是 ok ⇒ 统一 503,处理器里不用再写分支。放在鉴权两道门**之后**:没权限的照旧 401 / 403,
    // 不让「模块关着」变成探测装了什么功能的口子。主人关的 ⇒ module_off;开着却没起来 ⇒ module_degraded
    // 带原因 —— 别把坏了说成关了。subsystems 里找不到这个模块(测试 / 还没登记)⇒ 放给处理器,它自己的兜底照旧。
    const mod = moduleFor(routeKey)
    if (mod) {
      const st = deps.subsystems?.().find(s => s.name === mod)
      if (st && st.state !== 'ok') {
        const code = st.state === 'off' ? 'module_off' : 'module_degraded'
        deps.log?.('INTERNAL_API', `503 ${routeKey} ${code} module=${mod}`, { event: code, path: routeKey, module: mod })
        return send(res, 503, { error: code, module: mod, ...(st.state !== 'off' && st.error ? { detail: st.error } : {}) }, origin)
      }
    }

    // 表里有、模块也没说关着 / 坏了,只是处理器还没挂上来:开机途中(模块还没 init 到)。
    if (!route) return send(res, 503, { error: 'module_starting', module: mod }, origin)

    let body: unknown = null
    if (method === 'POST') {
      try {
        body = await readJsonBody(req,url.pathname==='/v1/workbench/attachment'?12*1024*1024:url.pathname.startsWith('/v1/workbench/')?128*1024:undefined)
      } catch (err) {
        if(err instanceof Error&&err.message==='request_body_too_large'){
          // A rejected stream may still contain unread chunks. Do not reuse its
          // connection for a following request before the parser finishes it.
          // Bun's node:http compatibility layer needs the explicit end as well
          // as the header; end after finish so the 413 response is flushed first.
          const socket=req.socket
          res.once('finish',()=>{if(!socket.destroyed)socket.end()})
          res.setHeader('connection','close')
          return send(res,413,{error:'request_body_too_large'},origin)
        }
        return send(res, 400, { error: 'malformed_json', detail: errMsg(err) }, origin)
      }
    }

    const reqSchema = REQUEST_SCHEMAS[routeKey]
    if (reqSchema) {
      const input = method === 'POST'
        ? body
        : Object.fromEntries(url.searchParams.entries())
      const parsed = reqSchema.safeParse(input)
      if (!parsed.success) {
        deps.log?.('INTERNAL_API', `400 ${routeKey} schema mismatch`, {
          path: routeKey,
          issues: parsed.error.issues,
        })
        return send(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() }, origin)
      }
      if (method === 'POST') body = parsed.data
      // GET: handler still reads from url.searchParams (legacy contract);
      // schema validation just gatekeeps.
    }

    // Derive the caller's chatId from a session token's sessionKey
    // (`provider/alias/chatId`) — chatId is everything after the SECOND
    // `/` so a chatId that itself contains `/` survives intact. File-origin
    // tokens (the daemon-wide operator token) never carry a sessionKey, so
    // chatId stays undefined for them — routes that scope by chatId (e.g.
    // memory/*) treat undefined + origin!=='session' as "unrestricted".
    const callerChatId = caller.origin === 'session' && caller.sessionKey
      ? caller.sessionKey.split('/').slice(2).join('/')
      : undefined
    // 共享令牌按本轮绑定(回复交付第 2 步):agy 走 daemon 交付时,`agy-static` 的「自己的 chat」就是此刻
    // 正在跑的那一轮 agy 的聊天 —— 附件路由与发送类的 chat 范围门用它。其它路由(记忆 / 提醒……)照旧
    // 只看令牌里读出来的 chatId(agy-static 没有)。
    const sharedTurn = sharedTokenTurn(caller, {
      agyDaemon: replyDeliveryFor('agy') === 'daemon',
      turnChatFor: deps.replyDelivery ? (p) => deps.replyDelivery!.turnChatFor(p) : undefined,
    })
    const turnChatId = sharedTurn?.kind === 'bound' ? sharedTurn.chatId : undefined
    const callerInfo = {
      tier: caller.tier, origin: caller.origin, chatId: callerChatId,
      ...(sharedTurn ? { sharedTurn: sharedTurn.kind, ...(turnChatId ? { turnChatId } : {}) } : {}),
    }

    // Chat-scope gate for the send family (send-scope.ts): a session of ANY
    // tier may only send to / edit in its OWN chat (tightened 2026-10-04 for
    // admin too); the one cross-chat path is the admin-only `message` route,
    // allowed and logged (chat_scope_admin_cross); broadcast: admin sessions only. Runs after schema validation and BEFORE the handler,
    // so a denied request never reaches the App reply sink, the outbound
    // tap, or ilink. File / operator tokens are not affected.
    const sendTarget = SEND_SCOPED_ROUTES[routeKey]
    if (sendTarget) {
      const target = sendTarget(body)
      const decision = sendScopeDecision(target, sharedTurn
        ? { tier: caller.tier, origin: caller.origin, chatId: turnChatId, sessionKey: caller.sessionKey, sharedTokenBound: true }
        : { ...callerInfo, sessionKey: caller.sessionKey }, routeKey)
      const targetLabel = target === ALL_CHATS ? '*' : target
      if (decision.kind === 'deny') {
        const own = sharedTurn ? (turnChatId ?? `-(agy-static turn=${sharedTurn.kind})`) : (callerChatId ?? '-')
        deps.log?.('INTERNAL_API', `403 ${routeKey} caller=${caller.tier}/${caller.origin} chat_scope own=${own} target=${targetLabel}`, {
          event: 'chat_scope_denied', path: routeKey, caller: caller.tier, origin: caller.origin,
          callerChat: (sharedTurn ? turnChatId : callerChatId) ?? null, target: targetLabel,
          ...(sharedTurn ? { sharedTurn: sharedTurn.kind } : {}),
        })
        return send(res, 403, { error: 'chat_scope', message: decision.message }, origin)
      }
      if (decision.kind === 'admin_cross') {
        // `message` 跨 chat(send-scope.ts):放行,记一笔审计 —— 主人「帮我告诉某人」的用量。
        deps.log?.('INTERNAL_API', `${routeKey} admin cross-chat own=${callerChatId ?? '-'} target=${targetLabel}`, {
          event: 'chat_scope_admin_cross', path: routeKey, callerChat: callerChatId ?? null, target: targetLabel,
        })
      }
    }

    // busy-registry hold (spec 2026-08-11 §2) — non-GET authenticated
    // request awaits the handler with a token held, released right after.
    // Same "worst case" motivation as markInboundActivity above: without
    // this, a slow handler is invisible to the idle self-restart check
    // between activity ticks. holdBusy itself must never break the request.
    const releaseBusy = method !== 'GET'
      ? (() => { try { return deps.holdBusy?.(`api:${routeKey}`) } catch { return undefined } })()
      : undefined
    try {
      // 调用方断开(MCP 子进程死了 / 工具调用被客户端放弃)⇒ signal 中止。只有长轮询的路由(GET /v1/cli/say)读它:
      // 挂着的等待不能当成「还有人在等」(terminal_say 评审 #2a,2026-10-24)。
      // Bun 的 node:http 客户端断开时不发 res 'close'(10-24 实测),只发 req 'aborted' 与 socket 'close';node 三个都发。
      // onSent:回包真写出去了('finish';socket 已断时不发,Bun 与 node 都是,10-24 实测)才调 —— terminal_say 据此才算
      // 「回话被领走」;没写出去就留给它自己的兜底(告诉主人),评审 #662 二轮 #1。
      const ac = new AbortController()
      const sock = req.socket
      const gone = () => { if (!res.writableFinished) ac.abort() }
      req.on('aborted', gone)
      res.on('close', gone)
      sock?.on('close', gone)
      // 登记前就已经断了(比如在读 body / 校验那段时间里断的)⇒ 那些事件不会再来,直接算断开(评审 #662 二轮 #2)
      if (sock?.destroyed || req.destroyed) gone()
      const onSent: Array<() => void> = []
      try {
        const out = await route(url.searchParams, body, callerInfo, { signal: ac.signal, onSent: (cb) => { onSent.push(cb) } })
        // 契约(架构终态 F1):测试里每个 2xx 回包都对着响应契约核一遍 —— 契约写错了、处理器回的形状变了,测试当场红;
        // 生产里不核(不为契约多花一次 parse,也不因契约漏写一个可选字段就让主人的请求失败)。
        if (UNDER_TEST_RUNNER && out.status >= 200 && out.status < 300) assertResponseContract(routeKey, out.body)
        if (onSent.length && !ac.signal.aborted) res.once('finish', () => { for (const cb of onSent) { try { cb() } catch { /* 回调出错不影响已回的包 */ } } })
        send(res, out.status, out.body, origin)
      } finally {
        // keep-alive 的同一条连接上会来很多请求:这一个请求一结束(回完 / 断开 / 抛错)就摘掉,不在 socket 上越挂越多
        sock?.off('close', gone)
      }
    } catch (err) {
      // 配置文件读不出来 / 刚被别处改过 ⇒ lib/json-file 拒写(3e,2026-10-22)。任何路由碰上都回一个看得懂的码,
      // 不是 500,daemon 也不退。
      const code = (err as { code?: unknown })?.code
      if (code === 'config_unreadable' || code === 'config_busy') {
        deps.log?.('INTERNAL_API', `409 ${method} ${rawUrl}: ${errMsg(err)}`, { event: 'config_write_refused', method, url: rawUrl, error: errMsg(err) })
        send(res, 409, { error: code, detail: errMsg(err) }, origin)
        return
      }
      deps.log?.('INTERNAL_API', `500 ${method} ${rawUrl}: ${errMsg(err)}`, {
        event: 'route_threw',
        method,
        url: rawUrl,
        error: errMsg(err),
      })
      send(res, 500, { error: 'internal', detail: errMsg(err) }, origin)
    } finally {
      try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
    }
  }

  return {
    async start() {
      if (server) throw new Error('internal-api already started')

      mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
      const tokenHex = randomBytes(32).toString('hex')
      token = Buffer.from(tokenHex, 'hex')
      // Register the daemon-wide file token as `trusted` — it's shell-readable,
      // so it can't grant more than the least-trusted process that reads it.
      registry.registerFileToken(tokenHex)
      // Write atomically — token consumers may already be reading on rotate(lib/json-file:独立 tmp + fsync + rename,
      // Windows 上 rename 被占用会短重试)。
      writeFileAtomic(tokenPath, tokenHex + '\n', { mode: 0o600 })

      // Separate admin-tier operator token (option B) — a distinct random
      // secret, registered `admin`, written to its own 0600 file. See
      // token-registry.ts's module doc comment for the rationale: this is
      // the one deliberate exception to "admin never from a file", scoped
      // to a credential only the local machine owner can read. Same
      // generate → registerOperatorToken → atomic write pattern as the
      // trusted file token above.
      const opTokenHex = randomBytes(32).toString('hex')
      registry.registerOperatorToken(opTokenHex)
      writeFileAtomic(operatorTokenPath, opTokenHex + '\n', { mode: 0o600 })

      server = createServer(handleRequest)
      // Catch listener errors so we surface bind failures to start()'s caller.
      const listenError = new Promise<never>((_, reject) => {
        server!.once('error', reject)
      })
      const listen = new Promise<void>(resolve => {
        server!.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
      })
      await Promise.race([listen, listenError])

      const addr = server.address() as AddressInfo | null
      if (!addr || typeof addr === 'string') {
        throw new Error('internal-api failed to bind: no address info')
      }
      boundPort = addr.port
      deps.log?.('INTERNAL_API', `listening on 127.0.0.1:${boundPort}`)

      return { port: boundPort, tokenFilePath: tokenPath, operatorTokenFilePath: operatorTokenPath }
    },

    async stop(opts) {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => err ? reject(err) : resolve())
      })
      server = null
      boundPort = null
      token = null
      if (opts?.unlinkToken) {
        const { unlinkSync, existsSync } = await import('node:fs')
        if (existsSync(tokenPath)) unlinkSync(tokenPath)
        if (existsSync(operatorTokenPath)) unlinkSync(operatorTokenPath)
      }
      deps.log?.('INTERNAL_API', 'stopped')
    },

    port() {
      if (boundPort === null) throw new Error('internal-api not started yet')
      return boundPort
    },

    tokenFilePath() {
      return tokenPath
    },

    mount(module, table) {
      for (const [key, handler] of Object.entries(table)) {
        if (moduleFor(key) !== module) throw new Error(`internal-api: ${module} mounted '${key}' but the route table does not mark it module: '${module}'`)
        if (ROUTES[key] || MOUNTED[key]) throw new Error(`internal-api: '${key}' is already registered`)
        MOUNTED[key] = handler
      }
    },

    provide(patch) {
      for (const k of LATE_KEYS) {
        const v = patch[k]
        if (v !== undefined) (deps as unknown as Record<string, unknown>)[k] = v
      }
    },

    getPresence() {
      return computePresence(deps)
    },
    mintSessionToken,
    invalidateSession(sessionKey: string) {
      registry.invalidateSession(sessionKey)
    },
    // 手机设置面板的窄接口(梳理第 6 步):同一个注册表,只给 device / link 的登记、查、撤、列。
    panelTokens: {
      register: (tokenHex, info) => registry.register(tokenHex, info),
      resolve: (tokenHex) => registry.resolve(tokenHex),
      invalidateSession: (sessionKey) => registry.invalidateSession(sessionKey),
      listSessions: (origin) => registry.listSessions(origin),
    },
  }
}
