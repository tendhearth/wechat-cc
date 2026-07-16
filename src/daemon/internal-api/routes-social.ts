/**
 * internal-api social route — agent-social M1 (T7b-core). Mirrors
 * routes-a2a.ts's `/v1/a2a/send` shape: 503 when the broker isn't wired
 * (social_enabled + social_disclosure_policy not both configured), else
 * delegate straight to `broker.seek()`. Split into its own file (rather
 * than appended to routes-a2a.ts) since agent-social is a distinct
 * capability/trust surface from the bare a2a exec/notify/pair routes — see
 * docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md.
 */
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import type { InternalApiDeps, RouteTable } from './types'

export function socialRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/social/seek': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const { topic, city } = body as { topic: string; city?: string }
      const outcome = await deps.social.broker.seek(topic, city ? { city } : undefined)
      return { status: 200, body: outcome }
    },
    // 觅食台 P2 — read routes over P1's stored rows (dashboard/CLI listing).
    'GET /v1/social/seeks': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { seeks: deps.social.seekStore.list() } }
    },
    'GET /v1/social/echoes': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { echoes: deps.social.echoStore.listAll() } }
    },
    // 觅食台 P2 Task 3 — inbound on/off toggle over a2a_listen, replacing the
    // "hand-edit agent-config.json" instruction. restart_required: true
    // because the A2A server binds a2a_listen at boot (bootstrap/index.ts);
    // live rebind is out of scope for this pass.
    'GET /v1/social/inbound': async () => {
      const l = loadAgentConfig(deps.stateDir).a2a_listen
      return { status: 200, body: l ? { enabled: true, host: l.host, port: l.port } : { enabled: false } }
    },
    'POST /v1/social/inbound': async (_q, body) => {
      // `body` is null on an empty/`null` request body (readJsonBody) — guard
      // it (as the sibling inline-validated POST routes do) so a missing body
      // reads as `enabled:false` instead of throwing a 500.
      const enabled = !!((body ?? {}) as { enabled?: unknown }).enabled
      const cfg = loadAgentConfig(deps.stateDir)
      const updated = enabled
        ? { ...cfg, a2a_listen: { host: '127.0.0.1', port: 8717 } }
        : (() => { const { a2a_listen, ...rest } = cfg; return rest })()
      saveAgentConfig(deps.stateDir, updated)
      return { status: 200, body: { enabled, restart_required: true } }
    },
    // async foraging spine — the answerer's pledge rows (mirrors GET echoes).
    'GET /v1/social/pledges': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { pledges: deps.social.pledgeStore.list() } }
    },
    // 揭晓 — desktop reveal buttons. id comes in the BODY (router is exact-match,
    // no :id path params). null outcome ⇒ no such row ⇒ 404.
    'POST /v1/social/echoes/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealEcho(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
    'POST /v1/social/pledges/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealPledge(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
  }
}
