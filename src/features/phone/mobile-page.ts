/**
 * 手机页(/m)的 daemon 侧:只吃 apps/mobile 的生成物,按请求填运行时键。
 * 源码在 apps/mobile/src,改完跑 `bun run build:mobile`。这里不许 import apps/mobile(depcheck 管)——
 * 编译后的 sidecar 没有源码树,生成物与冻结图一样随 JSON 编进二进制。
 */
import page from './mobile-page.generated.json'
import { MOBILE_BRAND_ICON_VERSION } from './mobile-brand-icon'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

/**
 * 随身 CC 手机页 —— 此刻 / 一起做 / 回忆,自包含无 CDN,PWA 可加主屏。
 * 「此刻」形象画不再内联(手机协议包 v2 Task 4 fix round 1,2026-09-29):两张
 * PNG base64 加起来 ~257KB,是页面撑爆中继 512KB 帧预算的大头。手机页 JS
 * (apps/mobile/src/presence.js 的 loadPresenceArt)按需从
 * GET /m/api/art/presence(settings-panel.ts,同一份 mobile-presence-art.json)
 * 拉,不再走这里的运行时键填充。
 */
export function mobilePhoneHtml(token: string, remote: { relay: string; id: string } | null): string {
  return fillMobileTemplate(page.phone, {
    TOKEN_JSON: inlineScriptJson(token),
    REMOTE_JSON: inlineScriptJson(remote),
  })
}

// 下面几份不带运行时键;照样过一遍 fill,将来有人加了键却忘了给值,模块加载时就炸,不会把 {{…}} 送上手机。
export const MOBILE_SW_JS = fillMobileTemplate(page.sw, { BRAND_ICON_VERSION: MOBILE_BRAND_ICON_VERSION })
/** 单一色板(apps/mobile/src/tokens.css):/set 页与过期页内联它,和 /m 同一套颜色、圆角、字体。 */
export const MOBILE_TOKENS_CSS = fillMobileTemplate(page.tokens, {})
export const MOBILE_BOOTSTRAP_HTML = fillMobileTemplate(page.bootstrap, {})
/** /set 与 /m 共用的传输层:同 Wi-Fi 直连,失败走端到端加密隧道。 */
export const TUNNEL_CLIENT_JS = fillMobileTemplate(page.transport, {})
export const MOBILE_WORKBENCH_JS = fillMobileTemplate(page.scripts.workbench, {})
export const MOBILE_PRESENCE_JS = fillMobileTemplate(page.scripts.presence, {})
