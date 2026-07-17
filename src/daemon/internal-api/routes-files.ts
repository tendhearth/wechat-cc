/**
 * internal-api file-locate route — admin-only on-demand file search over the
 * owner's computer. Stateless: wraps the pure lib/locate-files core. Searches
 * caller-supplied roots only (the agent passes dirs explicitly supplied by the
 * owner or learned in locations.md). Returns metadata only — never file bodies.
 * Admin-tier per route-tiers.ts.
 */
import { isAbsolute } from 'node:path'
import { type RouteTable } from './types'
import { locateFiles } from '../../lib/locate-files'

export function fileRoutes(): RouteTable {
  return {
    'GET /v1/locate': (q) => {
      const query = q.get('q') ?? undefined
      const raw = q.get('mode') ?? (query ? 'name' : 'browse')
      const VALID_MODES = new Set(['name', 'content', 'browse'])
      const mode = VALID_MODES.has(raw) ? (raw as 'name' | 'content' | 'browse') : 'name'
      // absolute only — isAbsolute() understands both POSIX ('/...') and
      // Windows ('C:\...', '\\server\...') forms; a bare '/' check dropped
      // every Windows root, so caller-supplied dirs never made it into the
      // search on Windows.
      const roots = q.getAll('root').filter(r => isAbsolute(r))
      const { candidates, truncated } = locateFiles({ roots, query, mode })
      return { status: 200, body: { candidates, truncated } }
    },
  }
}
