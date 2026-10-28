import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Lifecycle } from '../../lib/lifecycle'
import { createInternalApi } from './index'
import type { InternalApiDeps, LateDeps } from './types'
import { writeJsonAtomic } from '../../lib/json-file'

export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  /** 功能模块挂上自己的路由(表里标了 module 的那几条,架构终态 A3)。key 没标这个模块 / 重复 ⇒ 抛。 */
  mount(module: import('@wechat-cc/protocol/routes').ModuleName, routes: import('./types').RouteTable): void
  provide(patch: LateDeps): void
  getPresence(): Promise<import('../../domain/companion-presence').Presence | null>
  mintSessionToken(tier: import('../../domain/user-tier').UserTier, sessionKey: string, opts?: import('./token-registry').MintTokenOpts): string
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
    // CLI 随时会读这个文件:写到一半被读到就是半个 JSON —— 一样走独立 tmp + rename(3e 第 2 步)。
    writeJsonAtomic(infoPath, { baseUrl: `http://127.0.0.1:${port}`, tokenFilePath, operatorTokenFilePath, pid: process.pid, ts: Date.now() }, { mode: 0o600 })
  } catch { /* non-fatal: CLI will just error clearly if it can't find the file */ }
  return {
    name: 'internal-api',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFilePath,
    mount: (module, routes) => api.mount(module, routes),
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
