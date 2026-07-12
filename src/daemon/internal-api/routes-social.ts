/**
 * internal-api social route — agent-social M1 (T7b-core). Mirrors
 * routes-a2a.ts's `/v1/a2a/send` shape: 503 when the broker isn't wired
 * (social_enabled + social_disclosure_policy not both configured), else
 * delegate straight to `broker.seek()`. Split into its own file (rather
 * than appended to routes-a2a.ts) since agent-social is a distinct
 * capability/trust surface from the bare a2a exec/notify/pair routes — see
 * docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md.
 */
import type { InternalApiDeps, RouteTable } from './types'

export function socialRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/social/seek': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const { topic, city } = body as { topic: string; city?: string }
      const outcome = await deps.social.broker.seek(topic, city ? { city } : undefined)
      return { status: 200, body: outcome }
    },
  }
}
