/**
 * 手机页(/m)的 daemon 侧:只吃 apps/mobile 的生成物,按请求填运行时键。
 * 源码在 apps/mobile/src,改完跑 `bun run build:mobile`。这里不许 import apps/mobile(depcheck 管)——
 * 编译后的 sidecar 没有源码树,生成物与冻结图一样随 JSON 编进二进制。
 */
import page from './mobile-page.generated.json'
import art from './mobile-presence-art.json'
import { MOBILE_BRAND_ICON_VERSION } from './mobile-brand-icon'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

/** 随身 CC 手机页 —— 此刻 / 一起做 / 回忆,自包含无 CDN,PWA 可加主屏。 */
export function mobilePhoneHtml(token: string, remote: { relay: string; id: string } | null): string {
  return fillMobileTemplate(page.phone, {
    TOKEN_JSON: inlineScriptJson(token),
    REMOTE_JSON: inlineScriptJson(remote),
    ART_UNLIT_B64: art.unlit.base64,
    ART_LIT_B64: art.lit.base64,
  })
}

// 下面几份不带运行时键;照样过一遍 fill,将来有人加了键却忘了给值,模块加载时就炸,不会把 {{…}} 送上手机。
export const MOBILE_SW_JS = fillMobileTemplate(page.sw, { BRAND_ICON_VERSION: MOBILE_BRAND_ICON_VERSION })
export const MOBILE_BOOTSTRAP_HTML = fillMobileTemplate(page.bootstrap, {})
/** /set 与 /m 共用的传输层:同 Wi-Fi 直连,失败走端到端加密隧道。 */
export const TUNNEL_CLIENT_JS = fillMobileTemplate(page.transport, {})
export const MOBILE_WORKBENCH_JS = fillMobileTemplate(page.scripts.workbench, {})
export const MOBILE_PRESENCE_JS = fillMobileTemplate(page.scripts.presence, {})
