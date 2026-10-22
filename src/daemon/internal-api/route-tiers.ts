import { ROUTES, type ModuleName } from '@wechat-cc/protocol/routes'
import type { UserTier } from '../../core/user-tier'

/**
 * route-tiers — the minimum tier each internal-api route requires. The
 * dispatcher resolves the caller's tier from its token (token-registry.ts) and
 * rejects anything below the route's minimum. Anything NOT listed defaults to
 * `admin` via minTierFor (fail-closed: a new route can't ship world-open).
 *
 * Tiers track the corresponding ToolKind's policy in user-tier.ts where one
 * exists; operator/infra routes are assigned explicitly. See
 * docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md §5.
 */
export const TIER_RANK: Record<UserTier, number> = { guest: 0, trusted: 1, admin: 2 }

export function tierMeets(have: UserTier, need: UserTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need]
}

const KNOWN_TIERS: ReadonlySet<string> = new Set(Object.keys(TIER_RANK))

/**
 * 每条 `/v1` 路由的最低档位 —— 从路由表(`packages/protocol/src/routes.ts`)的 `desktop.tier` 推出来
 * (重构第二批 5a)。**加路由 / 改档位改那张表,不改这里。** 每一条为什么是这个档位的注释也搬到了表里。
 * 表里写了不认识的档位 ⇒ 按 admin(fail-closed;`scripts/routes-snapshot.guard.test.ts` 会红)。
 */
export const ROUTE_MIN_TIER: Record<string, UserTier> = Object.fromEntries(
  Object.entries(ROUTES).flatMap(([key, r]) => r.desktop ? [[key, KNOWN_TIERS.has(r.desktop.tier) ? r.desktop.tier as UserTier : 'admin']] : []),
)

/**
 * 某种令牌按路由逐条放行的名单(表里 `desktop.tokens` 含 `kind` 的那些行):`operator`(token-registry.ts)、
 * `federation`(routes-federation.ts)、`selftest`(selftest.ts)。每次调用给一份新的 Set。
 */
export function routesForToken(kind: string): ReadonlySet<string> {
  return new Set(Object.entries(ROUTES).filter(([, r]) => r.desktop?.tokens?.includes(kind)).map(([key]) => key))
}

export function minTierFor(routeKey: string): UserTier {
  return ROUTE_MIN_TIER[routeKey] ?? 'admin'
}

/** 这条路由属于哪个模块(表里的 `module`);没标 ⇒ undefined,不受模块门管。 */
export function moduleFor(routeKey: string): ModuleName | undefined {
  return (ROUTES as Readonly<Record<string, { module?: ModuleName }>>)[routeKey]?.module
}
