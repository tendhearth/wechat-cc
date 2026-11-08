import { ROUTES, type ModuleName, type RouteSpec } from '@wechat-cc/protocol/routes'
import type { UserTier } from '../../domain/user-tier'

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

/**
 * 手机设置面板那一口能走的 `/v1` 路由(P3b,设计稿 2026-11-05-p3-one-route-family「令牌范围从路由表推」):
 * 路由表里同时带 `desktop` 与 `phone` 块的 `/v1` 行。`device` = 全部这样的行;`link` = 其中 `phone.link` 是
 * read / write 的。没有 `phone` 块的 `/v1` 路由,设备 / 链接令牌一律 403 route_not_allowed(内部 API 的 dispatch
 * 在 `panel` 入口上查它,和令牌自己的 routeAllow 两道都要过)。P3b 时表里还没有这样的行(P3c 起一条一条加)。
 */
export const PANEL_V1_ROUTES: { readonly device: ReadonlySet<string>; readonly link: ReadonlySet<string> } = panelV1RoutesOf(ROUTES)

/** 从一张路由表推面板那一口的 `/v1` 名单(拆出来好拿假表测推法)。 */
export function panelV1RoutesOf(table: Readonly<Record<string, RouteSpec>>): { device: ReadonlySet<string>; link: ReadonlySet<string> } {
  const rows = Object.entries(table).filter(([key, r]) => r.desktop && r.phone && /^(GET|POST) \/v1\//.test(key))
  return {
    device: new Set(rows.map(([key]) => key)),
    link: new Set(rows.filter(([, r]) => r.phone!.link === 'read' || r.phone!.link === 'write').map(([key]) => key)),
  }
}
