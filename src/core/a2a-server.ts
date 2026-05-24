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

export interface NotifyEvent {
  agent: A2AAgentRecord
  text: string
  urgency?: 'normal' | 'critical'
  metadata?: Record<string, unknown>
}

export interface A2AServerOpts {
  host: string
  port: number
  registry: A2ARegistry
  onNotify: (event: NotifyEvent) => Promise<void>
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
      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) return new Response(JSON.stringify({ error: 'missing_bearer' }), { status: 401 })
      const bearer = auth.slice('Bearer '.length).trim()

      let body: { agent_id?: unknown; text?: unknown; urgency?: unknown; metadata?: unknown }
      try {
        body = await req.json() as typeof body
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }
      if (typeof body.agent_id !== 'string' || typeof body.text !== 'string' || body.text.length === 0) {
        return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 })
      }

      const agent = opts.registry.verifyBearer(body.agent_id, bearer)
      if (!agent) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      // verifyBearer already binds the agent to its key, so this is defense-in-depth.
      if (agent.id !== body.agent_id) return new Response(JSON.stringify({ error: 'agent_id_mismatch' }), { status: 403 })
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
    return new Response('not found', { status: 404 })
  }

  return {
    async start() {
      if (server) return
      server = Bun.serve({
        hostname: opts.host,
        port: opts.port,
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
