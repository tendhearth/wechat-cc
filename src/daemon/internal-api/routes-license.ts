/**
 * internal-api license routes — read Pro entitlement + activate/deactivate the
 * license from the dashboard. Activation hits Lemon Squeezy (or unlocks locally
 * for a DEV- key); status is a pure local read. Takes effect on the next daemon
 * spawn for features gated at boot, immediately for features that call isPro()
 * per request.
 */
import { type InternalApiDeps, type RouteTable } from './types'
import type { LicenseActivateRequestT } from './schema'
import { getEntitlement, activate, clearLicense } from '../license/license'
import { hostname } from 'node:os'

export function licenseRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/license/status': () => {
      const e = getEntitlement(deps.stateDir)
      return { status: 200, body: { pro: e.pro, reason: e.reason, expires_at: e.expiresAt } }
    },

    'POST /v1/license/activate': async (_q, body) => {
      const { key } = body as LicenseActivateRequestT
      const r = await activate(deps.stateDir, key.trim(), hostname())
      return { status: 200, body: r.ok
        ? { ok: true, pro: r.entitlement.pro, reason: r.entitlement.reason, expires_at: r.entitlement.expiresAt,
            note: 'restart the daemon to apply Pro features' }
        : { ok: false, error: r.error } }
    },

    'POST /v1/license/deactivate': () => {
      clearLicense(deps.stateDir)
      return { status: 200, body: { ok: true, note: 'back to Free — restart the daemon to apply' } }
    },
  }
}
