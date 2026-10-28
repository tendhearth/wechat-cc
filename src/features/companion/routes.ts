/**
 * 陪伴的路由(A5 · 陪伴,从 internal-api/routes.ts 的总表原样搬来):
 *   GET  /v1/companion/status        —— 开没开、默认对话、免打扰到几点、本地导入开没开
 *   POST /v1/companion/enable|disable —— 主动找主人那几拍的总开关
 *   POST /v1/companion/snooze        —— 先别找我 N 分钟
 *   POST /v1/companion/import-local  —— 本地聊天记录导入的开关
 *   GET  /v1/companion/thoughts      —— 日程判断留下的想法(routes-thoughts.ts)
 * 由 companion 模块自己挂(路由表标 module: 'companion')。模块没起来 ⇒ 路由层回 module_*,
 * 处理器里不再写 companion_not_wired。开关的实现还是 ilink 适配器那一份(`ilink/companion.ts`,改的是 companion
 * 配置、顺带起停定时);这里只拿它交出的窄口 `wechat.companion`(A6)。
 */
import { errMsg, type RouteTable } from '../../daemon/internal-api/types'
import type { CompanionSnoozeRequestT, CompanionImportLocalRequestT } from '../../daemon/internal-api/schema'
import type { WechatCompanionControls } from '../../ports/wechat'
import { thoughtRoutes } from './routes-thoughts'

export interface CompanionRoutesDeps {
  stateDir: string
  /** 开关那一口(ilink 适配器造的,容器里叫 `wechat.companion`)。 */
  companion: WechatCompanionControls
}

export function companionRoutes(d: CompanionRoutesDeps): RouteTable {
  return {
    // ── companion proactive tick (RFC 03 P1.B B6) ───────────────────────
    'GET /v1/companion/status': () => {
      return { status: 200, body: d.companion.status() }
    },
    'POST /v1/companion/enable': async () => {
      try {
        const r = await d.companion.enable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/disable': async () => {
      try {
        const r = await d.companion.disable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/snooze': async (_q, body) => {
      // Body is pre-validated by index.ts via CompanionSnoozeRequest schema.
      const { minutes } = body as CompanionSnoozeRequestT
      try {
        const r = await d.companion.snooze(minutes)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/import-local': async (_q, body) => {
      // Body is pre-validated by index.ts via CompanionImportLocalRequest schema.
      const { enabled } = body as CompanionImportLocalRequestT
      try {
        const r = await d.companion.setImportLocal(enabled)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    ...thoughtRoutes(d),
  }
}
