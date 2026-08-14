// Verb logic for `wechat-cc federated-source` — extracted out of cli.ts so it's
// testable without spawning the stdio run mode. Lives at the repo root (not
// under src/cli/) because it imports src/daemon/internal-api/federation-grant;
// the depcruise layering rule "cli-must-not-depend-on-daemon" only restricts
// files under src/cli/, and cli.ts itself already sits at the root for the
// same reason.
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeGrant, readGrant, revokeGrant } from './src/daemon/internal-api/federation-grant'
import { readApiInfo } from './src/mcp-servers/wechat/federated-source'

type Print = (line: string) => void

/**
 * Grant hearth consent to mint admin-tier tokens (writes federated-grant.json,
 * 0600). Ensures the state dir exists first — the owner may authorize before
 * the daemon has ever run (e.g. ~/.claude/channels/wechat/ not created yet),
 * so the grant sits ready for when it does; without this, writeGrant's
 * writeFileSync throws a raw ENOENT.
 */
export function federatedSourceAuthorize(infoPath: string, ts: number, print: Print): void {
  const stateDir = dirname(infoPath)
  // 0700 to match the daemon's own state-dir perms (index.ts) — this dir holds
  // the 0600 grant + trusted/operator token files; don't leave it world-listable.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
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

export type FederatedSourceVerb = 'authorize' | 'deauthorize' | 'status' | 'run'

/**
 * Pure decision logic for which verb `wechat-cc federated-source` should run,
 * given the parsed boolean flags. At most one of authorize/deauthorize/status
 * may be set — passing two silently dropped the second one before this guard
 * (e.g. `--authorize --deauthorize` just authorized; `--status --deauthorize`
 * skipped the status print). No flags set → 'run' (the stdio run mode hearth
 * spawns).
 */
export function resolveFederatedSourceVerb(
  flags: { authorize?: boolean; deauthorize?: boolean; status?: boolean },
): FederatedSourceVerb | { error: string } {
  const set = [flags.authorize, flags.deauthorize, flags.status].filter(Boolean).length
  if (set > 1) {
    return { error: 'federated-source: use at most one of --authorize / --deauthorize / --status' }
  }
  if (flags.authorize) return 'authorize'
  if (flags.deauthorize) return 'deauthorize'
  if (flags.status) return 'status'
  return 'run'
}
