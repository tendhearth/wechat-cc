/**
 * A2A server — inbound HTTP listener that lets registered external
 * A2A agents push notify(...) calls into wechat-cc.
 *
 * Two endpoints:
 *   GET  /.well-known/agent.json — daemon's Agent Card (unauthenticated)
 *   POST /a2a/notify — push a message to the operator
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
import { IntentCardSchema, type IntentCard, type MatchReceipt } from './a2a-intent'

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
  peer: ProviderId
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
}

/**
 * A peer's "seek" Intent Card, delivered for THIS owner's agent to judge
 * against its owner's derived facts and answer with a policy-filtered
 * Match Receipt. Part of the agent-social M1 broker flow.
 */
export interface IntentEvent {
  agent: A2AAgentRecord
  card: IntentCard
}

/**
 * A peer confirming that ITS owner said yes to lighting up a previously
 * matched intent — the second half of the broker's dual-confirm handshake
 * (see social-broker's `confirmPeer`). The peer's own `onIntentConfirm`
 * handler is what actually asks its owner and returns the answer.
 */
export interface IntentConfirmEvent {
  agent: A2AAgentRecord
  intent_id: string
}

export interface AuthFailedEvent {
  /** The claimed agent_id from the request body. Only emitted when the
   *  body is parseable AND has agent_id — pure noise (random scanners
   *  hitting the port with no body) is dropped without recording. */
  agent_id_claimed: string
  reason: 'missing_bearer' | 'wrong_bearer' | 'agent_id_mismatch'
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
  /** Optional. When wired, enables POST /a2a/intent — judge a peer's Intent
   *  Card against the owner's derived facts and return a Match Receipt.
   *  Undefined → /a2a/intent returns 501. */
  onIntent?: (event: IntentEvent) => Promise<MatchReceipt>
  /** Optional. When wired, enables POST /a2a/intent/confirm — a peer asks
   *  THIS owner to confirm lighting up a previously matched intent (the
   *  dual-confirm handshake's second leg). Undefined → 501. */
  onIntentConfirm?: (event: IntentConfirmEvent) => Promise<{ ok: boolean }>
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
  port(): number
}

export function createA2AServer(opts: A2AServerOpts): A2AServer {
  let server: ReturnType<typeof Bun.serve> | null = null

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
          peer: 'string (optional, \'claude\'|\'codex\'; default claude)',
          cwd: 'string (optional, working directory on this machine)',
        },
      }] : []),
      // Advertised only when this machine is wired to broker intents (onIntent set).
      ...(opts.onIntent ? [{
        name: 'intent',
        description: 'Broker a "seek" intent: judge a match against my owner and return a policy-filtered Match Receipt.',
        endpoint: '/a2a/intent',
        method: 'POST',
        request_schema: { agent_id: 'string', card: 'IntentCard' },
      }] : []),
    ],
  }

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

      const peer = (typeof body.peer === 'string' && body.peer ? body.peer : 'claude') as ProviderId
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
      try {
        const result = await opts.onExec({ agent, peer, prompt: body.prompt, cwd })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ ok: false, reason: msg }), { status: 200 })
      }
    }
    if (url.pathname === '/a2a/intent/confirm') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onIntentConfirm) return new Response(JSON.stringify({ error: 'intent_confirm_not_supported' }), { status: 501 })

      let body: { agent_id?: unknown; intent_id?: unknown }
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

      if (typeof body.intent_id !== 'string' || body.intent_id.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }
      try {
        const result = await opts.onIntentConfirm({ agent, intent_id: body.intent_id })
        return new Response(JSON.stringify(result), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'intent_confirm_failed', detail: msg }), { status: 500 })
      }
    }
    if (url.pathname === '/a2a/intent') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!opts.onIntent) return new Response(JSON.stringify({ error: 'intent_not_supported' }), { status: 501 })

      let body: { agent_id?: unknown; card?: unknown }
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

      const parsed = IntentCardSchema.safeParse(body.card)
      if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid_card' }), { status: 400 })
      try {
        const receipt = await opts.onIntent({ agent, card: parsed.data })
        return new Response(JSON.stringify(receipt), { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: 'intent_failed', detail: msg }), { status: 500 })
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
        const result = await opts.onPair({ secret: body.secret, brainId: body.brain_id, execKey: body.exec_key })
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
      server = Bun.serve({
        hostname: opts.host,
        port: opts.port,
        // /a2a/exec runs a full local agent (tens of seconds to minutes) with
        // no response bytes until it finishes — Bun's default 10s idleTimeout
        // would drop the connection mid-run. Raise to Bun's max (255s). Longer
        // tasks would need response streaming/heartbeat (future).
        idleTimeout: 255,
        fetch: handle,
      })
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
  }
}
