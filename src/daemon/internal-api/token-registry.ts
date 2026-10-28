import { randomBytes } from 'node:crypto'
import type { UserTier } from '../../domain/user-tier'
import { routesForToken } from './route-tiers'

/** operator 令牌的 routeAllow(重构第二批 5a 起从路由表推出来)。 */
const OPERATOR_ROUTE_ALLOW: ReadonlySet<string> = routesForToken('operator')

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
 *   - AGY-STATIC token (agy provider, spec
 *     docs/superpowers/specs/2026-08-17-agy-provider-design.md §3): a
 *     deliberate, narrow exception to "session tokens are env-only per
 *     spawn". agy's only MCP config surface is the global, on-disk
 *     `~/.gemini/config/mcp_config.json` (no per-session config dir, no
 *     workspace override — spike-confirmed negative on both, see the
 *     spec) — so bootstrap mints ONE long-lived 'trusted' session token
 *     (`sessionKey='agy-static'`) via this same `mint()` and
 *     agy-mcp-config.ts writes it into that file at boot, not into any
 *     process env. It is a `trusted`-tier token exactly like any other
 *     session mint (nothing here upgrades it to admin the way the
 *     OPERATOR token below does) — the exception is the ON-DISK, SHARED-
 *     ACROSS-CONVERSATIONS residency, not the tier. Compensating
 *     controls live in mode-commands.ts (`/agy` refuses guest chats) and
 *     conversation-coordinator.ts (dispatch-time refuses solo+agy for a
 *     chat that resolves to guest, closing the flip-time-only gap a
 *     trusted-tier POST /v1/conversation/set-mode or a later tier
 *     demotion would otherwise leave open) — see the CRITICAL/Important
 *     findings in the 2026-08-17 agy final-review fix wave. `invalidateSession('agy-static')`
 *     still revokes it like any session token; it is simply never rotated
 *     per-spawn the way a normal session token is.
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
 *     to the desktop application's owner-only surfaces: companion converse /
 *     voice, Customer Review, 待办, Workbench, plus the pet window's permission
 *     resolve. It still cannot restart the daemon, list
 *     sessions, or locate arbitrary files. That residual owner-surface access
 *     is accepted and documented: closing it
 *     fully needs real local-auth (peer-cred / agent-sandboxing) before
 *     this daemon supports trusted non-owner users alongside the desktop
 *     app. Session and file tokens leave routeAllow unset (unrestricted by
 *     route, tier gate only, as before).
 */
/** agy 全部对话共用的那一枚 trusted session 令牌的 sessionKey(见上方 AGY-STATIC 说明)。 */
export const AGY_STATIC_SESSION_KEY = 'agy-static'

/** `device` / `link`:手机设置面板的长期设备令牌与 10 分钟链接令牌(梳理第 6 步,2026-09-29)。 */
export type TokenOrigin = 'file' | 'session' | 'operator' | 'device' | 'link'

export type TokenInfo = {
  tier: UserTier
  origin: TokenOrigin
  sessionKey?: string
  /** When set, this token may ONLY call routes in this set — see the
   *  ROUTE-SCOPING note above. Absent ⇒ no route restriction (tier gate only). */
  routeAllow?: ReadonlySet<string>
  /**
   * Epoch ms after which this token is treated as invalid. Set only via
   * `mint`'s `opts.ttlMs` (security review fix round 1, federation mint) —
   * every other mint path (session tokens minted without opts, file token,
   * operator token) leaves this unset, so they keep their existing
   * unlimited lifetime unchanged. `resolve()` checks this and evicts the
   * entry from the map once it's past — expiry is enforced at the one
   * chokepoint every caller already goes through, not scattered per-route.
   */
  expiresAt?: number
}

/**
 * Optional narrowing for a minted session token (security review fix round
 * 1, federation mint) — lets a caller mint a token that grants LESS than
 * its raw tier would otherwise reach on its own. Both fields are opt-in;
 * omitting `opts` entirely (the pre-existing 2-arg `mint` call shape)
 * reproduces the old unrestricted, unlimited-lifetime session token exactly.
 */
export interface MintTokenOpts {
  /** Same ROUTE-SCOPING mechanism `registerOperatorToken` uses — restricts
   *  the minted token to ONLY these `"METHOD /path"` route keys regardless
   *  of its tier. Absent ⇒ unrestricted by route (tier gate only). */
  routeAllow?: ReadonlySet<string>
  /** Time-to-live in ms from the moment of minting. Absent ⇒ unlimited
   *  lifetime (today's behavior, unchanged for callers that don't pass it). */
  ttlMs?: number
}

/**
 * 手机令牌的登记参数。秘钥由面板在外面生成(手机页按首字母认种类:`d…` 设备、
 * `t…` 链接),所以不能走 `mint` 的 randomHex。
 */
export interface RegisterInfo {
  tier: UserTier
  origin: 'device' | 'link'
  sessionKey: string
  routeAllow: ReadonlySet<string>
  /** 链接令牌 10 分钟;设备令牌不传(永不过期,导图 [定])。 */
  ttlMs?: number
}

/**
 * 设置面板拿到的窄接口:只能登记 device / link 两种、查、撤、列,
 * 碰不到 `mint` 与 file / operator 令牌的登记。
 */
export interface PanelTokens {
  register(tokenHex: string, info: RegisterInfo): void
  resolve(tokenHex: string): TokenInfo | null
  invalidateSession(sessionKey: string): void
  /** 当前仍有效的某一种手机令牌(过期的顺手驱逐)。 */
  listSessions(origin: 'device' | 'link'): Array<{ token: string; sessionKey: string }>
}

export interface TokenRegistry extends PanelTokens {
  registerFileToken(tokenHex: string): void
  registerOperatorToken(tokenHex: string): void
  mint(tier: UserTier, sessionKey: string, opts?: MintTokenOpts): string
}

export function makeTokenRegistry(
  randomHex: () => string = () => randomBytes(32).toString('hex'),
  /** 可注入时钟(面板测试要拨表);缺省 `Date.now`。 */
  now: () => number = () => Date.now(),
): TokenRegistry {
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
      // read it. routeAllow narrows it to explicit desktop owner surfaces so
      // that admin grant doesn't reach every other admin route too.
      map.set(tokenHex, {
        tier: 'admin',
        origin: 'operator',
        // 名单在路由表(packages/protocol/src/routes.ts)里:`desktop.tokens` 含 'operator' 的行。
        // 每一条为什么给 operator 的说明见本文件顶上的 OPERATOR / ROUTE-SCOPING 两段与表里各行的注释。
        routeAllow: OPERATOR_ROUTE_ALLOW,
      })
    },
    mint(tier, sessionKey, opts) {
      const tok = randomHex()
      const info: TokenInfo = { tier, origin: 'session', sessionKey }
      if (opts?.routeAllow) info.routeAllow = opts.routeAllow
      if (opts?.ttlMs !== undefined) info.expiresAt = now() + opts.ttlMs
      map.set(tok, info)
      return tok
    },
    resolve(tokenHex) {
      const info = map.get(tokenHex)
      if (!info) return null
      // Expired ⇒ invalid AND evicted right here, so a revoked/expired
      // federation token doesn't linger in the map forever (fix round 1,
      // MEDIUM: "revoke doesn't cut existing tokens" — eviction bounds the
      // staleness window to ttlMs after --deauthorize, instead of "until
      // daemon restart"). Every resolve() call already goes through this
      // one function, so this is the single chokepoint for expiry — no
      // separate sweep/timer needed.
      if (info.expiresAt !== undefined && now() >= info.expiresAt) {
        map.delete(tokenHex)
        return null
      }
      return info
    },
    register(tokenHex, reg) {
      const info: TokenInfo = { tier: reg.tier, origin: reg.origin, sessionKey: reg.sessionKey, routeAllow: reg.routeAllow }
      if (reg.ttlMs !== undefined) info.expiresAt = now() + reg.ttlMs
      map.set(tokenHex, info)
    },
    invalidateSession(sessionKey) {
      // 按 sessionKey 撤,不再限 origin === 'session':设备(`device:<id>`)与
      // 链接(`link`)也走这一条。file / operator 令牌没有 sessionKey,碰不到。
      for (const [tok, info] of map) {
        if (info.sessionKey !== undefined && info.sessionKey === sessionKey) map.delete(tok)
      }
    },
    listSessions(origin) {
      const out: Array<{ token: string; sessionKey: string }> = []
      for (const [tok, info] of map) {
        if (info.origin !== origin) continue
        if (info.expiresAt !== undefined && now() >= info.expiresAt) { map.delete(tok); continue }
        out.push({ token: tok, sessionKey: info.sessionKey! })
      }
      return out
    },
  }
}
