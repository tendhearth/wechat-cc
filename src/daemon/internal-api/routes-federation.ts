// Federation mint route — hands hearth a SHORT-LIVED, ROUTE-SCOPED
// admin-tier token so it can reach federated_query (POST
// /v1/knowledge/search, admin-gated) and NOTHING else. Two gates guard this
// beyond the route layer's operator-routeAllow + admin-tier: the caller
// must be the operator token (added to routeAllow in token-registry.ts),
// AND the explicit owner grant must exist (design option B — operator alone
// cannot mint admin data-tokens). The token value is never logged.
//
// Fix round 1 (adversarial security review, HIGH + MEDIUM): the gates
// above only prove WHO may mint — they say nothing about what the minted
// CREDENTIAL itself can do once handed to hearth's launcher process. Before
// this fix, `mintSessionToken('admin', ...)` produced an unscoped,
// unlimited-lifetime admin token — full daemon admin (companion/converse =
// impersonate the owner in live WeChat, daemon/restart, file locate, every
// memory/knowledge read+write) that would live until daemon restart even
// after `--deauthorize` revoked the grant. The credential itself must carry
// the same least-privilege promise the design describes, not just rely on
// the (correct, but insufficient) app-layer promise that only federated_query
// ever calls it. So the token is minted with `routeAllow` restricted to the
// ONE route federated_query actually calls (verified against
// tools-federated.ts's `registerFederatedQueryTool` — it only ever does
// `client.request('POST', '/v1/knowledge/search', ...)`), and a `ttlMs` that
// bounds its lifetime to a few minutes so a leaked or post-deauthorize-stale
// token self-invalidates quickly instead of living until the next restart.
import type { InternalApiDeps, RouteTable } from './types'
import { readGrant } from './federation-grant'

const FEDERATION_SESSION_KEY = 'hearth-federated'
// The one route federated_query calls — see tools-federated.ts. Any other
// admin route (companion/converse, daemon/restart, /v1/locate, ...) must
// stay unreachable through this credential even though its TIER is admin.
const FEDERATION_ROUTE_ALLOW: ReadonlySet<string> = new Set(['POST /v1/knowledge/search'])
const FEDERATION_TOKEN_TTL_MS = 5 * 60_000 // 5 minutes

export function federationRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/federation/mint': async () => {
      const grant = readGrant(deps.stateDir)
      if (!grant) {
        deps.log?.('INTERNAL_API', '403 /v1/federation/mint federation_not_authorized', {
          event: 'federation.mint_denied',
        })
        return { status: 403, body: { error: 'federation_not_authorized' } }
      }
      // Defensive: deps.mintSessionToken is wired internally by
      // createInternalApi (index.ts), so it's always present by the time any
      // route can be dispatched — but a route handler must never assume
      // infra plumbing outside its own file stayed correct, same posture as
      // the other `_not_wired` 503 guards in this directory.
      if (!deps.mintSessionToken) {
        deps.log?.('INTERNAL_API', '503 /v1/federation/mint federation_mint_not_wired', {
          event: 'federation.mint_error',
        })
        return { status: 503, body: { error: 'federation_mint_not_wired' } }
      }
      const token = deps.mintSessionToken('admin', FEDERATION_SESSION_KEY, {
        routeAllow: FEDERATION_ROUTE_ALLOW,
        ttlMs: FEDERATION_TOKEN_TTL_MS,
      })
      deps.log?.('INTERNAL_API', 'federation.mint ok', {
        event: 'federation.mint', integration: grant.integration,
      })
      return { status: 200, body: { token } }
    },
  }
}
