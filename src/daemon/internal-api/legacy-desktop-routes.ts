/**
 * legacy-desktop-routes.ts — 桌面装着的 .app 还在调的 `/v1/workbench/*` 旧路径(P3e,设计稿
 * docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3e」):一件事上的动作收进 `/v1/matter/*` 以后,
 * 旧键是 `packages/protocol/src/wire-compat.ts` 的 WIRE_ROUTE_ALIASES 里读的人 = desktop 的那几行。
 *
 * 那几行都是纯改名(`transform: null`):新键的处理器在 operator 范围下认的就是旧键的参数、回的就是旧键的回包,所以旧键上挂的
 * **就是新键那一个处理器函数** —— 不另写一份、不翻译。旧键的路由表那一行照旧(档位、operator、tauri 白名单编在 .app 里,
 * 模块门、正文上限、响应契约都按旧键走),所以旧路径的回包一个字节不变。桌面改调新键的那一版普及了,按退休条件删行。
 * daemon 里认这几行的只有这个文件(手机那半是 src/features/phone/legacy-routes.ts)。
 */
import { WIRE_ROUTE_ALIASES } from '@wechat-cc/protocol'
import type { RouteTable } from './types'

/** 读的人 = desktop 的别名行(旧键 `/v1/…`)。 */
export const DESKTOP_ROUTE_ALIASES = WIRE_ROUTE_ALIASES.filter(r => r.from.includes(' /v1/'))

/** 把旧键挂到新键那一个处理器上(就地改 table 并返回它)。新键没在表里 ⇒ 起不来(别名指向不存在的处理器是写错了)。 */
export function withDesktopAliases(table: RouteTable): RouteTable {
  for (const r of DESKTOP_ROUTE_ALIASES) {
    const handler = table[r.to]
    if (!handler) throw new Error(`legacy-desktop-routes: ${r.from} → ${r.to}:新键没有处理器`)
    if (r.transform !== null) throw new Error(`legacy-desktop-routes: ${r.from} 不是纯改名(transform 应为 null)`)
    table[r.from] = handler
  }
  return table
}
