/**
 * 手机 —— 一个功能一个目录(架构终态 A5)。手机这一面的 daemon 侧:浏览器 / PWA 的 `/m`、设置页 `/set`、原生 App 经中继
 * 走的同一套 `/m/api/*`,以及把它们送出家门的隧道、推送、订阅。页面源码在 apps/mobile、App 在 apps/app(都不在这里)。
 *
 *  - `settings-panel.ts`:面板本身(局域网 HTTP、令牌、`/m/api/*` 合表分发);`settings-panel-html.ts`:`/set` 页与几样静态资源;
 *  - `phone-route-table.ts`:处理器登记的写法(F2,`"METHOD /path"` 表、ownsMethod、合表、查表);
 *    `phone-routes.ts`:哪些路由给手机、哪些给链接令牌(PHONE_ROUTES / LINK_READ_OK / LINK_WRITE_OK 连理由)、LAN_ONLY_OPS、订阅主题;
 *  - `mobile-*.ts`:各块 `/m/api/*` 的处理器(一件事 / 工作台、对话、做过的事、读终端会话与会话、首屏、首屏焦点);
 *    `mobile-page*.ts` + 两份 json:手机页的生成物(apps/mobile 构建出来)与 presence 美术;
 *  - `phone-*.ts`:推送、在线设备、订阅事件与主题来源、批准说明 / 进展概括(便宜模型)、看改动、出码、手机对话、传输标记;
 *  - `tunnel-client.ts` / `tunnel-v2-stream.ts`:连中继的隧道(老中继 + v2);`remote-*` / `relay-identity.ts`:中继配置与身份;
 *    `device-store.ts`:已配对的设备;
 *  - `routes.ts`:桌面「连接手机」那两条 `/v1/phone/*`(路由表标了 module: 'phone');
 *  - 这个文件:模块清单 + 外面能用的那几样。
 *
 * 有意没搬的(下一步):手机那一簇的装配 —— `daemon/wiring/wire-phone.ts`(推送 / 对话 / App 主动通道 / 媒体镜像 / 隧道 /
 * notifier / 订阅)、`wire-settings-panel.ts`(把 daemon 各处的读写面收成面板要的那一份)、`phone-lifecycle.ts`(固定的关机顺序)。
 * 它们在 wired 里建(要 CC 开口那道门、主人对话入口、「一件事」活动时间,而 App 主动通道又是 wired 里记忆通知要的 —— 真环),
 * 还要伸进 tick-bodies / companion / bootstrap 一大片;搬进来就成环。等 wired 拆开再说。
 *
 * 别的功能的 `/m/api/*` 处理器归它们自己(信、定时已经是:各自 index.ts 导出表),经面板的 `featureRoutes` 交进来,
 * 面板不 import 别的功能。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { phoneRoutes, type PhoneRoutesDeps } from './routes'

export type { PhoneConnectDep, PhoneRoutesDeps } from './routes'
// 处理器登记的写法:别的功能交 `/m/api/*` 表时用(信、定时)
export { ownsMethod, type PhoneHandler, type PhoneRouteTable } from './phone-route-table'
export { framedTooLarge } from './mobile-matter-response'
export { fileChunkResponse, makePhoneChatId, makePhoneOwner } from './mobile-chat'
export type { MobileActivityDeps } from './mobile-activity'
export { makeSettingsPanel, phoneMayOpenMatter } from './settings-panel'
export { cacheSessions } from './mobile-reads'
export { makePhoneChat, type PhoneChat } from './phone-chat'
export { makePhoneInsight } from './phone-insight'
export { makeApprovalExplainer } from './phone-explain'
export { makeProgressSummarizer } from './phone-progress'
export { currentPhoneClient, surfaceOrigin } from './phone-client'
export { makeRemoteToggle, relayV2Configured } from './remote-toggle'
export { resolveRemoteRelays, mergeOnlineDevices } from './remote-relay-config'
export { makePhonePush, type PushPayload } from './phone-push'
export { fanoutPush, makePhoneNotifier } from './phone-notifier'
export { deviceIdOf } from './device-store'
export { makePhoneEventsWiring } from './phone-topic-sources'
export type { PhoneEvents } from './phone-events'
export type { TunnelClient } from './tunnel-client'
/** 隧道客户端只在开了远程时才加载(以前 wire-phone 里就是动态 import)。 */
export const loadTunnelClient = () => import('./tunnel-client')

/**
 * `phone` 模块:挂 `/v1/phone/*`(桌面「连接手机」)。紧跟 internal-api(以前这两条随 internal-api 一起就在);
 * 出码要的设置面板在 wired 里才建 ⇒ `deps.phoneConnect` 现取,没建好照旧 503 phone_not_wired。
 */
export function phoneFeature(o: { needs: readonly string[]; lazy?: readonly string[]; deps: (ctx: ModuleCtx) => PhoneRoutesDeps }): DaemonModule {
  return {
    name: 'phone',
    needs: ['internal-api', ...o.needs],
    ...(o.lazy ? { lazy: o.lazy } : {}),
    init(ctx) {
      ctx.get<InternalApiLifecycle>('internal-api').mount('phone', phoneRoutes(o.deps(ctx)))
    },
  }
}
