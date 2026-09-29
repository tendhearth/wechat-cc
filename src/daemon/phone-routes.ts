/**
 * 手机设置面板(`/set`、`/m`)令牌能走的路由,与经隧道不许做的操作(梳理第 6 步,2026-09-29)。
 *
 * 面板的令牌登记在内部 API 同一个 token-registry 里,带 routeAllow = 这里的集合。
 * 形状与内部 API 的 routeAllow 一致:`"METHOD /path"` 精确键;以 `/` 结尾的键是前缀
 * (贴纸一族)。新加手机路由要登记在这里,`scripts/phone-routes.guard.test.ts` 会对着
 * `settings-panel.ts` 的 routeRequest 与 `mobile-workbench.ts` 双向核对。
 *
 * 设计稿:docs/superpowers/specs/2026-09-27-device-token-registry-design.md;与之不同的
 * 两条裁决见 docs/superpowers/plans/2026-09-29-device-token-registry.md。
 */

export const PHONE_ROUTES: ReadonlySet<string> = new Set([
  // 设置页
  'GET /set',
  'GET /set/api/state',
  'POST /set/api/apply',
  'POST /set/api/pair',
  // 随身 CC
  'GET /m',
  'GET /m/api/state',
  'GET /m/api/art/blink',
  'GET /m/api/memory',
  'GET /m/api/home',
  'GET /m/api/feed',
  'POST /m/api/seen',
  'GET /m/api/matters',
  'GET /m/api/matter',
  'POST /m/api/matter/say',
  'POST /m/api/todo',
  'GET /m/api/sticker/',
  // 交办与材料(mobile-workbench.ts,#129)
  'POST /m/api/attachment/chunk',
  'GET /m/api/attachment/upload',
  'POST /m/api/attachment/discard',
  'GET /m/api/entry/options',
  'POST /m/api/matter/create',
  'GET /m/api/matter/create-receipt',
  'POST /m/api/matter/permission',
  'POST /m/api/matter/answer',
  'GET /m/api/matter/artifact',
])

/**
 * 链接令牌与设备令牌同一套(计划裁决 1):设置页链到 `/m`,`/m` 在配对之前就用链接令牌读
 * `/m/api/*`;收窄会让「从设置链接打开随身 CC」在配对前坏掉。10 分钟内同权,与改造前相同。
 */
export const LINK_ROUTES: ReadonlySet<string> = PHONE_ROUTES

/**
 * 经隧道(`_via=tunnel`)一律拒的 `/set/api/apply` 操作:开关远程访问会重启 daemon,
 * 撤销 / 全忘设备会把人锁在门外 —— 只在家(同一局域网)做。泄露的设备令牌在外面够不着这些。
 */
export const LAN_ONLY_OPS: ReadonlySet<string> = new Set(['set_remote', 'revoke_device', 'forget_devices'])

/**
 * 这条请求在不在令牌的 routeAllow 里。路径在册但方法不对也放行 —— 交给处理器照旧回 405
 * (计划裁决 2),门只挡「根本不在册的路径」。
 */
export function phoneRouteAllowed(allow: ReadonlySet<string>, method: string, path: string): boolean {
  const key = `${method} ${path}`
  if (allow.has(key)) return true
  for (const k of allow) {
    const p = k.slice(k.indexOf(' ') + 1)
    if (p.endsWith('/') ? path.startsWith(p) && path.length > p.length && k.startsWith(`${method} `) : p === path) return true
  }
  return false
}
