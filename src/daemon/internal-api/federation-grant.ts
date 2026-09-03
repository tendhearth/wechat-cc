// Federation consent grant — the explicit, revocable record that the owner
// authorized hearth to obtain admin-tier tokens (design option B). The mint
// route (routes-federation.ts) requires this to exist; the CLI --authorize
// writes it. 0600, owner-only — same trust posture as the operator token.
import { existsSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'

const GRANT_FILE = 'federated-grant.json'

export interface FederationGrant { integration: string; ts: number }

export function grantPath(stateDir: string): string {
  return join(stateDir, GRANT_FILE)
}

export function writeGrant(stateDir: string, ts: number, integration = 'hearth'): FederationGrant {
  const grant: FederationGrant = { integration, ts }
  const p = grantPath(stateDir)
  writeFileSync(p, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600) // writeFileSync mode is create-only; force it on overwrite too
  return grant
}

export function readGrant(stateDir: string): FederationGrant | null {
  const p = grantPath(stateDir)
  if (!existsSync(p)) return null
  try {
    const g = readJsonFile(p) as Partial<FederationGrant>
    if (typeof g?.integration === 'string' && typeof g?.ts === 'number') {
      return { integration: g.integration, ts: g.ts }
    }
    return null
  } catch {
    return null
  }
}

export function revokeGrant(stateDir: string): boolean {
  const p = grantPath(stateDir)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}
