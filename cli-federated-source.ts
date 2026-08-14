// Verb logic for `wechat-cc federated-source` — extracted out of cli.ts so it's
// testable without spawning the stdio run mode. Lives at the repo root (not
// under src/cli/) because it imports src/daemon/internal-api/federation-grant;
// the depcruise layering rule "cli-must-not-depend-on-daemon" only restricts
// files under src/cli/, and cli.ts itself already sits at the root for the
// same reason.
import { dirname } from 'node:path'
import { writeGrant, readGrant, revokeGrant } from './src/daemon/internal-api/federation-grant'
import { readApiInfo } from './src/mcp-servers/wechat/federated-source'

type Print = (line: string) => void

/** Grant hearth consent to mint admin-tier tokens (writes federated-grant.json, 0600). */
export function federatedSourceAuthorize(infoPath: string, ts: number, print: Print): void {
  const stateDir = dirname(infoPath)
  const grant = writeGrant(stateDir, ts)
  print(`federated-source: authorized (granted ${new Date(grant.ts).toISOString()})`)
  print('Revoke anytime with: wechat-cc federated-source --deauthorize')
}

/** Revoke the federation grant (idempotent — no-op if none exists). */
export function federatedSourceDeauthorize(infoPath: string, print: Print): void {
  const stateDir = dirname(infoPath)
  const revoked = revokeGrant(stateDir)
  print(revoked ? 'federated-source: revoked (grant removed)' : 'federated-source: not authorized — no grant to revoke')
}

/**
 * Print grant state + the daemon's baseUrl (from info.json). Returns whether
 * a grant is currently present, so callers (and tests) don't have to scrape
 * printed output.
 */
export function federatedSourceStatus(infoPath: string, print: Print): boolean {
  const stateDir = dirname(infoPath)
  const grant = readGrant(stateDir)
  print(grant
    ? `federated-source: authorized (granted ${new Date(grant.ts).toISOString()})`
    : 'federated-source: not authorized — run `wechat-cc federated-source --authorize`')
  try {
    const info = readApiInfo(infoPath)
    print(`daemon baseUrl: ${info.baseUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    print(`daemon info: unavailable (${msg})`)
  }
  return grant !== null
}
