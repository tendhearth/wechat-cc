/**
 * 手机面板(`/m/*`、`/set/*`)的处理器登记(架构终局 F2):与内部 API 同一种写法 ——
 * `Record<"METHOD /path", handler>`,键与路由表 `packages/protocol/src/routes.ts` 一一对应
 * (`scripts/phone-routes.guard.test.ts` 双向核对)。以 `/` 结尾的键是前缀(贴纸一族),同 phoneRouteAllowed。
 *
 * 方法不对怎么办:门(phoneRouteAllowed)只挡不在册的路径,在册但方法不对的照样放进来(计划裁决 2)。
 * 以前按路径匹配、自己回 405 的处理器用 `ownsMethod` 标出来 —— 方法没命中时仍交给它,由它照旧回 405;
 * 没标的(以前写成 `pathname === … && req.method === …` 的)方法不对就是查不到,落到面板的 404。
 */

/** `ctx`:面板自己那几条要的调用者信息;各 mobile-*.ts 的处理器不看它。 */
export type PhoneHandler<C = unknown> = (url: URL, req: Request, ctx: C) => Promise<Response> | Response
export type PhoneRouteTable<C = unknown> = Readonly<Record<string, PhoneHandler<C>>>

const OWNS_METHOD = new WeakSet<object>()
/** 这条处理器自己判方法(方法不对回它自己的 405 / 503):路径对上、方法没登记时也交给它。 */
export function ownsMethod<H extends PhoneHandler<never>>(h: H): H {
  OWNS_METHOD.add(h)
  return h
}

/** 合成一张表;两张表登记了同一个键 ⇒ 抛(后来的会悄悄盖掉前面的,另一条处理器永远不被调)。 */
export function combinePhoneRoutes<C>(...tables: ReadonlyArray<PhoneRouteTable<C>>): PhoneRouteTable<C> {
  const out: Record<string, PhoneHandler<C>> = {}
  for (const t of tables) {
    for (const [k, h] of Object.entries(t)) {
      if (k in out) throw new Error(`phone route registered twice: ${k}`)
      out[k] = h
    }
  }
  return out
}

const pathOf = (key: string) => key.slice(key.indexOf(' ') + 1)

/** 精确键 → 同方法的前缀键 → 路径对上且 ownsMethod 的处理器;都没有 ⇒ null。 */
export function lookupPhoneRoute<C>(table: PhoneRouteTable<C>, method: string, path: string): PhoneHandler<C> | null {
  const exact = table[`${method} ${path}`]
  if (exact) return exact
  for (const [k, h] of Object.entries(table)) {
    const p = pathOf(k)
    if (p.endsWith('/') && k.startsWith(`${method} `) && path.startsWith(p) && path.length > p.length) return h
  }
  for (const [k, h] of Object.entries(table)) if (pathOf(k) === path && OWNS_METHOD.has(h)) return h
  return null
}

/** 查表并调用;查不到 ⇒ null(面板回 404)。 */
export async function routePhone<C>(table: PhoneRouteTable<C>, url: URL, req: Request, ctx: C = undefined as C): Promise<Response | null> {
  const h = lookupPhoneRoute(table, req.method, url.pathname)
  return h ? await h(url, req, ctx) : null
}

/** 一条路径登记在几个方法下、同一个处理器(它自己按 req.method 分支)。 */
export function sharedRoute<C>(methods: readonly string[], path: string, h: PhoneHandler<C>): PhoneRouteTable<C> {
  return Object.fromEntries(methods.map(m => [`${m} ${path}`, h]))
}
