// Federation mint route — hands hearth a SHORT-LIVED admin-tier token so it
// can reach federated_query (POST /v1/knowledge/search, admin-gated). Two
// gates guard this beyond the route layer's operator-routeAllow + admin-tier:
// the caller must be the operator token (added to routeAllow in
// token-registry.ts), AND the explicit owner grant must exist (design
// option B — operator alone cannot mint admin data-tokens). The token value
// is never logged.
import type { InternalApiDeps, RouteTable } from './types'
import { readGrant } from './federation-grant'

const FEDERATION_SESSION_KEY = 'hearth-federated'

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
      const token = deps.mintSessionToken('admin', FEDERATION_SESSION_KEY)
      deps.log?.('INTERNAL_API', 'federation.mint ok', {
        event: 'federation.mint', integration: grant.integration,
      })
      return { status: 200, body: { token } }
    },
  }
}
