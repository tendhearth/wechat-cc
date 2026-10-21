import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Lifecycle } from '../../lib/lifecycle'
import { createInternalApi } from './index'
import type { InternalApiDeps, LateDeps } from './types'

export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  provide(patch: LateDeps): void
  getPresence(): Promise<import('../../core/companion-presence').Presence | null>
  mintSessionToken(tier: import('../../core/user-tier').UserTier, sessionKey: string, opts?: import('./token-registry').MintTokenOpts): string
  invalidateSession(sessionKey: string): void
  panelTokens: import('./token-registry').PanelTokens
}

/**
 * Async because HTTP server bind is async; bootstrap needs the actual port
 * before constructing the wechat-mcp stdio MCP spec.
 */
export async function registerInternalApi(deps: InternalApiDeps): Promise<InternalApiLifecycle> {
  const api = createInternalApi(deps)
  const { port, tokenFilePath, operatorTokenFilePath } = await api.start()
  const infoPath = join(deps.stateDir, 'internal-api-info.json')
  // Write discovery file so CLI (`wechat-cc mode set`) can find the running
  // daemon's baseUrl + token without hardcoding a port. Mode 0o600: token
  // path is sensitive (any holder can POST set-mode / broadcast / etc.).
  // operatorTokenFilePath (option B security fix) is included so the
  // desktop app's agent_converse can discover the admin-tier operator
  // token path without hardcoding it — see token-registry.ts's module doc
  // comment for why a file-origin admin token is safe here.
  try {
    writeFileSync(
      infoPath,
      JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath, operatorTokenFilePath, pid: process.pid, ts: Date.now() }, null, 2),
      { mode: 0o600 },
    )
  } catch { /* non-fatal: CLI will just error clearly if it can't find the file */ }
  return {
    name: 'internal-api',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFilePath,
    provide: (patch) => api.provide(patch),
    getPresence: () => api.getPresence(),
    mintSessionToken: (tier, sessionKey, opts) => api.mintSessionToken(tier, sessionKey, opts),
    invalidateSession: (sessionKey) => api.invalidateSession(sessionKey),
    panelTokens: api.panelTokens,
    stop: async () => {
      // Remove the discovery file on clean stop so stale info doesn't
      // mislead a subsequent CLI invocation after the daemon exits.
      try { unlinkSync(infoPath) } catch { /* best-effort */ }
      return api.stop()
    },
  }
}
