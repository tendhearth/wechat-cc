/**
 * A2A server — inbound HTTP listener that lets registered external
 * A2A agents push notify(...) calls into wechat-cc.
 *
 * Endpoints:
 *   GET  /.well-known/agent.json — daemon's Agent Card (unauthenticated)
 *   POST /a2a/notify — push a message to the operator
 *   POST /a2a/exec   — delegated work (only for may_exec peers)
 *   POST /a2a/letter — a sealed pen-pal envelope for one of my channels
 *   POST /a2a/pair   — the 6-digit pairing rendezvous
 *
 * The server itself is dumb: it verifies Bearer auth, validates the
 * body shape, and hands off to an injected `onNotify` callback. The
 * callback (wired in bootstrap) is what actually routes the message
 * to the operator's chat via sendAssistantText.
 *
 * Default-binds 127.0.0.1. Operator must explicitly opt into wider
 * binding via agent-config.a2a_listen.host. OFF by default — start()
 * is only called when a2a_listen is configured.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'
import type { ProviderId } from './conversation'
import { A2A_PROTO_VERSION } from './a2a-intent'
import { serve, type Server } from '../lib/runtime/http'

/**
 * How long the HAND holds an /a2a/exec connection open with no bytes flowing.
 * Bun's hard maximum — it cannot be raised.
 *
 * Load-bearing coupling: the BRAIN's own delegate timeout MUST stay strictly
 * below this, or the hand hangs up first on a long task and the brain sees a
 * network error instead of its own clean timeout — surfacing to the user as
 * 「连不上那台手」 when the truth is 「那台手还在跑」. Asserted in
 * a2a-delegate-timeout.test.ts.
 */
export const A2A_EXEC_IDLE_TIMEOUT_S = 255

export interface NotifyEvent {
  agent: A2AAgentRecord
  text: string
  urgency?: 'normal' | 'critical'
  metadata?: Record<string, unknown>
}

/**
 * A delegated task: the caller (a "brain" wechat-cc) asks THIS machine to run
 * its local agent on `prompt` and return the result. The "hand" side of the
 * one-brain-many-hands model — backed by the delegate one-shot dispatcher.
 */
export interface ExecEvent {
  agent: A2AAgentRecord
  /** 省略 ⇒ 由**本机**决定用哪个 agent(dispatchDelegate 解析)。写死 claude
   *  会让任何不装 claude 的机器当不了手 —— 见 bootstrap/delegate.ts。 */
  peer?: ProviderId
  prompt: string
  cwd?: string
}

export type ExecResult = { ok: true; response: string } | { ok: false; reason: string }

/**
 * A pairing handshake: a brain presents a one-time invite secret (minted by
 * `hand invite`) plus the id + exec key it wants registered. The hand verifies
 * the secret and, if valid, registers the brain so its later /a2a/exec calls
 * authenticate. Auth here is the one-time secret itself, not a Bearer token.
 */
export interface PairEvent {
  secret: string
  brainId: string
  execKey: string
  /** 脑自己的 a2a 地址 + 手→脑的钥匙(spec 2026-09-09-cli-hook-push §6.5);老脑不带。 */
  brainUrl?: string
  callbackKey?: string
}

/**
 * 终端会话桥(§6.5):手把本机 claude / codex 的 hook 事件与权限请求转给脑;
 * 脑把「看 / 说」转给手执行。由 main.ts 在 hub 建好后 setCliHandlers 挂上。
 */
export interface A2ACliHandlers {
  /** 脑侧:收手转来的事件。origin 是**已验证**的手 id(不信 body 里的)。 */
  onEvent?: (agent: A2AAgentRecord, ev: Record<string, unknown>) => Promise<unknown>
  onPermissionOpen?: (agent: A2AAgentRecord, req: Record<string, unknown>) => Promise<unknown>
  onPermissionWait?: (agent: A2AAgentRecord, hash: string, waitMs: number) => Promise<unknown>
  /** 手侧:脑要看 / 说某条本机会话。只有 may_exec 的脑能调。 */
  onReply?: (agent: A2AAgentRecord, req: { kind: 'view' | 'say'; session_id: string; text?: string }) => Promise<unknown>
}

/**
 * A sealed E2E letter delivered over the pen-pal channel. `agent_id` is the
 * verified Bearer id (routing metadata only, NOT the plaintext sender's real
 * identity). The payload itself carries only ciphertext + AEAD fields —
 * plaintext never crosses the wire or this event.
 */
export interface LetterEvent {
  agent_id: string
  channel_id: string
  nonce: string
  ct: string
  tag: string
}

export interface AuthFailedEvent {
  /** The claimed agent_id from the request body. Only emitted when the
   *  body is parseable AND has agent_id — pure noise (random scanners
   *  hitting the port with no body) is dropped without recording. */
  agent_id_claimed: string
  /** `exec_not_authorized`:bearer 是对的,但这个对端没有被授权在这台机器上
   *  派活(may_exec=false)。与前三种「你不是你说的那个人」不同 —— 这是
   *  「你是,但你没这个权限」,值得区分:前者可能是攻击,后者多半是配错了
   *  (该走 hand accept / hand invite 而走了社交配对)。 */
  reason: 'missing_bearer' | 'wrong_bearer' | 'agent_id_mismatch' | 'exec_not_authorized'
}

export interface A2AServerOpts {
  host: string
  port: number
  registry: A2ARegistry
  onNotify: (event: NotifyEvent) => Promise<void>
  /**
   * Optional. When wired, enables POST /a2a/exec — run the local agent on a
   * delegated task and return the result. Undefined → /a2a/exec returns 501.
   */
  onExec?: (event: ExecEvent) => Promise<ExecResult>
  /**
   * Optional. When wired, enables POST /a2a/pair — a brain completes the
   * smooth-pairing handshake by presenting a one-time invite secret (minted
   * by `hand invite`) plus the id + exec key it wants registered. Returns
   * { ok } so the brain knows whether the secret was accepted. Undefined →
   * /a2a/pair returns 501. Auth is the one-time secret, not a Bearer token.
   */
  onPair?: (event: PairEvent) => Promise<{ ok: boolean; error?: string }>
  /** Optional. When wired, enables POST /a2a/letter — a peer delivers a sealed
   *  E2E pen-pal letter (ciphertext only, never plaintext) addressed to a
   *  PenpalHandle channel on this machine. Undefined → /a2a/letter returns 501. */
  onLetter?: (event: LetterEvent) => Promise<{ ok: boolean; error?: string }>
  /** Optional hook called when a notify request is rejected with 401/403
   *  AND we can identify which agent_id the caller claimed. Used by
   *  bootstrap to write an `a2a_events` row with status='auth_failed' so
   *  the operator sees "agent X tried with the wrong key" in the activity
   *  drawer. Not called for malformed requests (no body / no agent_id). */
  onAuthFailed?: (event: AuthFailedEvent) => void
  daemonInfo: { name: string; version: string }
}

export interface A2AServer {
  start(): Promise<void>
  stop(): Promise<void>
  baseUrl(): string
  /** 终端会话桥的处理器,晚绑定(hub 在 main.ts 里比 a2a 服务晚建)。 */
  setCliHandlers(h: A2ACliHandlers): void
  port(): number
}

export function createA2AServer(opts: A2AServerOpts): A2AServer {
  let server: Server | null = null

  // Fire-and-forget wrapper — observability hook must not crash the response.
  function emitAuthFailed(event: AuthFailedEvent): void {
    if (!opts.onAuthFailed) return
    try { opts.onAuthFailed(event) }
    catch { /* swallow — never let observability break a 401 response */ }
  }

  const agentCard = {
    name: opts.daemonInfo.name,
    description: 'WeChat bridge for AI agents — notify the operator via WeChat chat.',
    version: opts.daemonInfo.version,
    proto_version: A2A_PROTO_VERSION,
    auth: { type: 'bearer', required: true },
    capabilities: [
      {
        name: 'notify',
        description: 'Push a message to the operator\'s WeChat chat. Operator may reply via their claude/codex session, which can then call back via A2A.',
        endpoint: '/a2a/notify',
        method: 'POST',
        request_schema: {
          agent_id: 'string (your registered id with this wechat-cc)',
          text: 'string',
          urgency: 'string (optional, \'normal\'|\'critical\')',
          metadata: 'object (optional)',
        },
      },
      // Advertised only when this machine is wired as a "hand" (onExec set).
      ...(opts.onExec ? [{
        name: 'exec',
        description: 'Run this machine\'s local agent on a task and return the result (one-brain-many-hands: the caller delegates, this hand executes locally).',
        endpoint: '/a2a/exec',
        method: 'POST',
        request_schema: {
          agent_id: 'string (your registered id with this wechat-cc)',
          prompt: 'string (the task)',
          peer: 'string (optional, \'claude\'|\'codex\'|…; 省略则由本机自己选)',
          cwd: 'string (optional, working directory on this machine)',
        },
      }] : []),
      // Advertised only when this machine is wired to receive inbound letters.
      ...(opts.onLetter ? [{
        name: 'letter',
        description: 'Deliver a sealed E2E pen-pal letter (ciphertext only) to a channel on this machine.',
        endpoint: '/a2a/letter',
        method: 'POST',
        request_schema: { agent_id: 'string', channel_id: 'string', nonce: 'string', ct: 'string', tag: 'string' },
      }] : []),
    ],
  }

  let cli: A2ACliHandlers = {}

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/.well-known/agent.json') {
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
      return new Response(JSON.stringify(agentCard), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname === '/a2a/notify') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

      // Parse body FIRST so auth-fail events can record the claimed agent_id.
      // Malformed bodies don't get an event row (no agent_id to attribute it
      // to — that's just port-scanner noise we shouldn't pollute the events
      // log with). The slight info leak vs auth-first-ordering is acceptable
      // because the server is localhost-only by default.
      let body: { agent_id?: unknown; text?: unknown; urgency?: unknown; metadata?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string' || typeof body.text !== 'string' || body.text.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      const claimedId = body.agent_id

      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'missing_bearer' })
        return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      }
      const bearer = auth.slice('Bearer '.length).trim()

      const agent = opts.registry.verifyBearer(claimedId, bearer)
      if (!agent) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'wrong_bearer' })
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      // verifyBearer already binds the agent to its key, so this is defense-in-depth.
      if (agent.id !== claimedId) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'agent_id_mismatch' })
        return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
      }
      if (agent.paused) return new Response(JSON.stringify({ ok: true, paused: true }), { status: 202 })

      const urgency: 'normal' | 'critical' | undefined =
        body.urgency === 'critical' ? 'critical' : body.urgency === 'normal' ? 'normal' : undefined

      try {
        await opts.onNotify({
          agent, text: body.text, urgency,
          metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata as Record<string, unknown> : undefined,
        })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'notify_failed', detail: msg }), { status: 500 })
      }
    }
    if (url.pathname === '/a2a/exec') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onExec) return new Response(JSON.stringify({ error: 'exec_not_supported' }), { status: 501 })

      let body: { agent_id?: unknown; prompt?: unknown; peer?: unknown; cwd?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string' || typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      const claimedId = body.agent_id

      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'missing_bearer' })
        return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      }
      const agent = opts.registry.verifyBearer(claimedId, auth.slice('Bearer '.length).trim())
      if (!agent) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'wrong_bearer' })
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      if (agent.id !== claimedId) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'agent_id_mismatch' })
        return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
      }
      if (agent.paused) return new Response(JSON.stringify({ ok: false, reason: 'paused' }), { status: 202 })

      // 授权:**只有我明确授权过的大脑**能在这台机器上跑东西。
      //
      // bearer 只证明「你在我的 registry 里」,而 registry 是一张**平的**表:
      // 我自己的另一台机器(hand accept / hand invite —— 两端都要 CLI 访问权,
      // 等价于一次 SSH 密钥交换)和朋友的 bot(六位配对码 / a2a install)
      // 混在一起,记录形状还一模一样(都是 capabilities: [])。此前这里没有
      // 这道检查,于是「谁能在我机器上执行代码」这件事,实际答案是「任何配过
      // 对的人」—— 而 claude 那条路给的还是 trusted 档。见 agent-config.ts
      // 的 may_exec。
      if (!agent.may_exec) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'exec_not_authorized' })
        return new Response(JSON.stringify({ error: 'exec_not_authorized' }), { status: 403 })
      }

      // 缺省不再补 'claude' —— 交给 onExec/dispatchDelegate 用**本机自己的**
      // 默认 provider 解析。写死 claude 会让任何不装 claude 的机器当不了手。
      const peer = (typeof body.peer === 'string' && body.peer ? body.peer : undefined) as ProviderId | undefined
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
      try {
        const result = await opts.onExec({ agent, peer, prompt: body.prompt, cwd })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ ok: false, reason: msg }), { status: 200 })
      }
    }
    if (url.pathname === '/a2a/cli/event' || url.pathname === '/a2a/cli/permission' || url.pathname === '/a2a/cli/reply') {
      // 终端会话桥(§6.5)。认证与 notify 同款:body.agent_id + Bearer = registry 里那把钥匙。
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      let body: Record<string, unknown>
      if (req.method === 'GET') {
        body = Object.fromEntries(url.searchParams.entries())
      } else if (req.method === 'POST') {
        try { body = await req.json() as Record<string, unknown> } catch { return json(400, { error: 'invalid_json' }) }
      } else return new Response('method not allowed', { status: 405 })
      if (!body || typeof body !== 'object' || typeof body['agent_id'] !== 'string') return json(400, { error: 'invalid_body' })
      const claimedId = body['agent_id']
      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) { emitAuthFailed({ agent_id_claimed: claimedId, reason: 'missing_bearer' }); return json(401, { error: 'missing_bearer' }) }
      const agent = opts.registry.verifyBearer(claimedId, auth.slice('Bearer '.length).trim())
      if (!agent) { emitAuthFailed({ agent_id_claimed: claimedId, reason: 'wrong_bearer' }); return json(401, { error: 'unauthorized' }) }
      if (agent.id !== claimedId) { emitAuthFailed({ agent_id_claimed: claimedId, reason: 'agent_id_mismatch' }); return json(403, { error: 'agent_id_mismatch' }) }
      if (agent.paused) return json(202, { ok: false, reason: 'paused' })
      try {
        if (url.pathname === '/a2a/cli/event') {
          if (!cli.onEvent) return json(501, { error: 'cli_bridge_not_wired' })
          return json(200, await cli.onEvent(agent, body))
        }
        if (url.pathname === '/a2a/cli/permission') {
          // 同一个路径两件事:带 hash 是轮询,不带是登记(a2a-client 只会 POST)。
          if (typeof body['hash'] !== 'string') {
            if (!cli.onPermissionOpen) return json(501, { error: 'cli_bridge_not_wired' })
            return json(200, await cli.onPermissionOpen(agent, body))
          }
          if (!cli.onPermissionWait) return json(501, { error: 'cli_bridge_not_wired' })
          const hash = typeof body['hash'] === 'string' ? body['hash'] : ''
          const waitRaw = Number(body['wait_ms'] ?? '0')
          const waitMs = Math.max(0, Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, 25_000))
          return json(200, await cli.onPermissionWait(agent, hash, waitMs))
        }
        // /a2a/cli/reply:在这台机上看 / 接着跑某条会话 —— 只有我授权过的脑能调(与 exec 同一道门)。
        if (!agent.may_exec) { emitAuthFailed({ agent_id_claimed: claimedId, reason: 'exec_not_authorized' }); return json(403, { error: 'exec_not_authorized' }) }
        if (!cli.onReply) return json(501, { error: 'cli_bridge_not_wired' })
        const kind = body['kind']
        const sessionId = body['session_id']
        if ((kind !== 'view' && kind !== 'say') || typeof sessionId !== 'string' || !sessionId) return json(400, { error: 'invalid_body' })
        const text = typeof body['text'] === 'string' ? body['text'] : undefined
        return json(200, await cli.onReply(agent, { kind, session_id: sessionId, ...(text ? { text } : {}) }))
      } catch (err) {
        return json(500, { error: 'cli_bridge_failed', detail: err instanceof Error ? err.message : String(err) })
      }
    }
    if (url.pathname === '/a2a/letter') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onLetter) return new Response(JSON.stringify({ error: 'letter_not_supported' }), { status: 501 })

      let body: { agent_id?: unknown; channel_id?: unknown; nonce?: unknown; ct?: unknown; tag?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string') return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      const claimedId = body.agent_id

      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'missing_bearer' })
        return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      }
      const agent = opts.registry.verifyBearer(claimedId, auth.slice('Bearer '.length).trim())
      if (!agent) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'wrong_bearer' })
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      if (agent.id !== claimedId) {
        emitAuthFailed({ agent_id_claimed: claimedId, reason: 'agent_id_mismatch' })
        return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
      }
      if (agent.paused) return new Response(JSON.stringify({ ok: false, reason: 'paused' }), { status: 202 })

      if (typeof body.channel_id !== 'string' || body.channel_id.length === 0
        || typeof body.nonce !== 'string' || body.nonce.length === 0
        || typeof body.ct !== 'string' || body.ct.length === 0
        || typeof body.tag !== 'string' || body.tag.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      try {
        // `agent_id` stays the verified Bearer `agent.id` — client-supplied
        // agent_id is never trusted as the acting identity. The wire payload
        // carries only sealed fields; plaintext never crosses.
        const result = await opts.onLetter({
          agent_id: agent.id, channel_id: body.channel_id, nonce: body.nonce, ct: body.ct, tag: body.tag,
        })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'letter_failed', detail: msg }), { status: 500 })
      }
    }
    if (url.pathname === '/a2a/pair') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onPair) return new Response(JSON.stringify({ error: 'pair_not_supported' }), { status: 501 })

      let body: { secret?: unknown; brain_id?: unknown; exec_key?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      // The secret IS the auth here — verified against the pending invite by
      // onPair. Shape-check the registration fields the brain wants applied.
      if (typeof body.secret !== 'string' || !body.secret
        || typeof body.brain_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.brain_id)
        || typeof body.exec_key !== 'string' || body.exec_key.length < 16) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      try {
        const extra = body as { brain_url?: unknown; callback_key?: unknown }
        const brainUrl = typeof extra.brain_url === 'string' && extra.brain_url ? extra.brain_url : undefined
        const callbackKey = typeof extra.callback_key === 'string' && extra.callback_key.length >= 16 ? extra.callback_key : undefined
        const result = await opts.onPair({ secret: body.secret, brainId: body.brain_id, execKey: body.exec_key, ...(brainUrl && callbackKey ? { brainUrl, callbackKey } : {}) })
        return result.ok
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: result.error ?? 'pairing_rejected' }), { status: 401 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 })
      }
    }
    return new Response('not found', { status: 404 })
  }

  return {
    async start() {
      if (server) return
      server = serve({
        hostname: opts.host,
        port: opts.port,
        // /a2a/exec runs a full local agent (tens of seconds to minutes) with
        // no response bytes until it finishes — Bun's default 10s idleTimeout
        // would drop the connection mid-run. Raise to Bun's max (255s). Longer
        // tasks would need response streaming/heartbeat (future).
        idleTimeout: A2A_EXEC_IDLE_TIMEOUT_S,
        fetch: handle,
      })
      await server.ready
    },
    async stop() {
      server?.stop()
      server = null
    },
    baseUrl() {
      if (!server) throw new Error('a2a-server not started')
      return `http://${opts.host}:${server.port!}`
    },
    port() {
      if (!server) throw new Error('a2a-server not started')
      return server.port!
    },
    setCliHandlers(h) {
      cli = h
    },
  }
}
