import { join } from 'node:path'

/**
 * The license cache — the last-known-good activation/validation result from
 * Lemon Squeezy, kept locally so Pro works offline (we don't phone home every
 * launch). Lives next to the other per-user state.
 */
export function licensePath(stateDir: string): string {
  return join(stateDir, 'license.json')
}
