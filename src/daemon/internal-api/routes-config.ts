/**
 * internal-api config-surface routes — the whitelist-only read/write face
 * behind the admin-only config_get/config_set MCP tools (see
 * src/lib/config-surface.ts for the whitelist and its security rationale).
 * Mirrors routes-memory.ts's shape: `configRoutes(deps): RouteTable`,
 * `{ status, body }` returns, inline validation.
 *
 * Both routes are 'admin' in route-tiers.ts. Every successful write lands
 * one 'config_changed' events row (db v31) — same audit posture as
 * POST /v1/memory/delete's memory_deleted. Audit failure does not undo the
 * write: the config file IS the source of truth, and a missing audit row is
 * strictly better than a config change that claims to have failed but took.
 */
import type { InternalApiDeps, RouteTable } from './types'
import { readConfigSurface, writeConfigKey } from '../../lib/config-surface'
import { makeEventsStore } from '../events/store'

export function configRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/config/surface': () => {
      return { status: 200, body: { keys: readConfigSurface(deps.stateDir) } }
    },

    'POST /v1/config/set': async (_q, body, caller) => {
      const b = (body ?? {}) as { key?: unknown; value?: unknown; reason?: unknown }
      if (typeof b.key !== 'string' || b.key.length === 0) return { status: 400, body: { error: 'invalid_key' } }
      if (b.value === undefined || b.value === null) return { status: 400, body: { error: 'invalid_value' } }
      const result = await writeConfigKey(deps.stateDir, b.key, b.value)
      if (result.ok && deps.db) {
        const auditChat = caller?.chatId ?? '_operator'
        const reason = typeof b.reason === 'string' && b.reason.length > 0 ? b.reason : '(no reason given)'
        try {
          await makeEventsStore(deps.db, auditChat).append({
            kind: 'config_changed',
            trigger: 'mcp_tool_call',
            reasoning: `${b.key}: ${JSON.stringify(result.previous)} → ${JSON.stringify(b.value)} — ${reason}`,
          })
        } catch { /* audit is best-effort; see header comment */ }
      }
      return { status: 200, body: result }
    },
  }
}
