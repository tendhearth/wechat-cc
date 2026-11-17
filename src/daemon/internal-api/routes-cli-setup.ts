import type { InternalApiDeps, RouteTable } from './types'

export function cliSetupRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/llm/setup': () => deps.cliSetup ? { status: 200, body: deps.cliSetup.snapshot() } : { status: 503, body: { error: 'cli_setup_not_wired' } },
    'POST /v1/llm/setup': async (_q, body, caller) => {
      if (caller?.tier !== 'admin' || caller.origin !== 'operator') return { status: 403, body: { error: 'desktop_only', hint: '到电脑上点一下接入' } }
      if (!deps.cliSetup) return { status: 503, body: { error: 'cli_setup_not_wired' } }
      try { return { status: 200, body: await deps.cliSetup.plan(body) } }
      catch (e) {
        const error = e instanceof Error ? e.message : 'cli_setup_failed'
        return { status: error === 'network_unprotected' ? 409 : 400, body: { error } }
      }
    },
  }
}
