/**
 * internal-api 配对码 routes (spec §7). Mirrors routes-social.ts: 503 when the
 * engine isn't wired (no mailbox_relays), else delegate to boot.pairing. Both
 * tier=trusted (see route-tiers.ts). start() mints+returns a code; accept()
 * takes a 6-digit code.
 */
import type { InternalApiDeps, RouteTable } from './types'

export function pairRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/pair/start': async () => {
      if (!deps.pairing) return { status: 503, body: { error: 'pairing_not_wired' } }
      return { status: 200, body: await deps.pairing.start() }
    },
    'POST /v1/pair/accept': async (_q, body) => {
      if (!deps.pairing) return { status: 503, body: { error: 'pairing_not_wired' } }
      const code = ((body ?? {}) as { code?: unknown }).code
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { status: 400, body: { error: 'invalid_code' } }
      const result = await deps.pairing.accept(code)
      return { status: 200, body: result }
    },
  }
}
