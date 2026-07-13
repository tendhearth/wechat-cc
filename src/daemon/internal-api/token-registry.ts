import { randomBytes } from 'node:crypto'
import type { UserTier } from '../../core/user-tier'

/**
 * token-registry — maps an internal-api bearer token to the tier and origin
 * it grants. Replaces the old single-token check so the route layer can
 * enforce the *caller's* tier (see route-tiers.ts).
 *
 * Security model (see docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md):
 *   - The daemon-wide FILE token is registered as `trusted` — a shell-readable
 *     credential can't be trusted above the least-trusted process that can read
 *     it (a `trusted` agent has shell access as the same OS user).
 *   - SESSION tokens are minted env-only per spawn and carry that session's
 *     actual tier; admin therefore only originates from a daemon-minted
 *     admin-session token, never a file.
 *   - OPERATOR token (option B, app-channel security fix): a SECOND,
 *     SEPARATE file, distinct from the daemon-wide trusted token, granting
 *     `admin`. This is a deliberate, narrow exception to "admin never from
 *     a file" — it exists solely so the desktop app's local companion-chat
 *     bridge (`agent_converse`) can call the admin-gated
 *     POST /v1/companion/converse route without upgrading the shared
 *     shell-readable trusted token to admin. The exception is safe because
 *     anyone who can read this file already has local filesystem access as
 *     the machine owner — the same person who could just read the WeChat
 *     data / memory files directly — so local-operator == owner == admin.
 *     Keeping it a distinct credential (rather than promoting the trusted
 *     file token) means a `trusted`-tier shell process still can't reach
 *     admin-only routes by reading the one file it's meant to have.
 *   - ROUTE-SCOPING (blast-radius fix on top of option B): the operator
 *     token is admin-tier, but admin-tier alone would let it reach every
 *     other admin route too (daemon-restart, /v1/locate, /v1/sessions,
 *     ...) — so a `trusted`-tier agent that manages to read this one file
 *     (same-OS-user shell access) would get full daemon control, not just
 *     converse. `routeAllow`, when present on a TokenInfo, restricts that
 *     token to ONLY the listed `"METHOD /path"` route keys regardless of
 *     its tier; the dispatcher enforces this as a second gate after the
 *     tier check (see index.ts). registerOperatorToken sets
 *     `routeAllow: {'POST /v1/companion/converse', 'POST /v1/companion/speak'}`
 *     so a leaked operator token can only impersonate the owner in converse
 *     (text turns) and speak (synthesized reply audio) — it cannot restart
 *     the daemon, list sessions, or locate files. That residual
 *     (converse/speak-impersonation) is accepted and documented: closing it
 *     fully needs real local-auth (peer-cred / agent-sandboxing) before
 *     this daemon supports trusted non-owner users alongside the desktop
 *     app. Session and file tokens leave routeAllow unset (unrestricted by
 *     route, tier gate only, as before).
 */
export type TokenInfo = {
  tier: UserTier
  origin: 'file' | 'session' | 'operator'
  sessionKey?: string
  /** When set, this token may ONLY call routes in this set — see the
   *  ROUTE-SCOPING note above. Absent ⇒ no route restriction (tier gate only). */
  routeAllow?: ReadonlySet<string>
}

export interface TokenRegistry {
  registerFileToken(tokenHex: string): void
  registerOperatorToken(tokenHex: string): void
  mint(tier: UserTier, sessionKey: string): string
  resolve(tokenHex: string): TokenInfo | null
  invalidateSession(sessionKey: string): void
}

export function makeTokenRegistry(randomHex: () => string = () => randomBytes(32).toString('hex')): TokenRegistry {
  // Keyed on the full high-entropy hex secret: a Map.get leaks no useful
  // timing oracle (an attacker must already hold a complete valid token to
  // get a hit). This replaces the old timingSafeEqual-against-one-token check,
  // which doesn't scale to N tokens.
  const map = new Map<string, TokenInfo>()
  return {
    registerFileToken(tokenHex) {
      map.set(tokenHex, { tier: 'trusted', origin: 'file' })
    },
    registerOperatorToken(tokenHex) {
      // See the "OPERATOR token" and "ROUTE-SCOPING" notes in the module
      // doc comment above — this is the one place a file-origin token is
      // allowed to grant `admin`, because it's a distinct credential from
      // the shared trusted file token and only the local machine owner can
      // read it. routeAllow narrows it to converse-only so that admin
      // grant doesn't reach every other admin route too.
      map.set(tokenHex, {
        tier: 'admin',
        origin: 'operator',
        routeAllow: new Set(['POST /v1/companion/converse', 'POST /v1/companion/speak', 'POST /v1/companion/transcribe']),
      })
    },
    mint(tier, sessionKey) {
      const tok = randomHex()
      map.set(tok, { tier, origin: 'session', sessionKey })
      return tok
    },
    resolve(tokenHex) {
      return map.get(tokenHex) ?? null
    },
    invalidateSession(sessionKey) {
      for (const [tok, info] of map) {
        if (info.origin === 'session' && info.sessionKey === sessionKey) map.delete(tok)
      }
    },
  }
}
