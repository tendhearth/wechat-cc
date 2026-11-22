import { hostname } from 'node:os'
import { searchTerminalSpeech, TERMINAL_SEARCH_DEFAULT_LIMIT, TERMINAL_SEARCH_MAX_LIMIT } from '../../features/roster'
import type { InternalApiDeps, RouteTable } from './types'

export function terminalSearchRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/terminal/search': (query, _body, caller) => {
      if (caller?.origin !== 'operator') return { status: 403, body: { error: 'forbidden' } }
      const q = query.get('q')?.trim() ?? ''
      const length = Array.from(q).length
      const rawLimit = query.get('limit')
      const limit = rawLimit === null ? TERMINAL_SEARCH_DEFAULT_LIMIT : Number(rawLimit)
      if (length < 1 || length > 200 || !Number.isSafeInteger(limit) || limit < 1) {
        return { status: 400, body: { error: 'invalid_request' } }
      }
      if (!deps.db) return { status: 503, body: { error: 'terminal_search_not_wired' } }
      const start = performance.now()
      let hitCount = 0
      try {
        const owner = deps.resolveAdminChatId?.() || null
        const hits = searchTerminalSpeech(deps.db, owner, hostname(), q, Math.min(limit, TERMINAL_SEARCH_MAX_LIMIT))
        hitCount = hits.length
        return { status: 200, body: { ok: true, hits } }
      } catch {
        return { status: 500, body: { error: 'internal' } }
      } finally {
        const elapsedMs = Math.round(performance.now() - start)
        deps.log?.('TERMINAL_SEARCH', 'terminal search', { length, hitCount, elapsedMs })
      }
    },
  }
}
