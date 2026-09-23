/**
 * app-version.ts — 版本号的唯一入口。
 *
 * 2026-09-22:此前版本号有四份各说各话(根 package.json 0.6.4、tauri.conf 1.6.6、
 * apps/desktop/package.json 0.5.18、acp-agent-provider 里硬编码的 '0.6.4'),
 * 而发版只认 tauri.conf。现在四处对齐,并由 scripts/version-consistency.guard.test.ts 钉住。
 *
 * `APP_VERSION` 必须是**纯 semver**:插件闸门用它做版本比较(registry.ts 的
 * `requires wechat-cc >= X`),掺了别的字符串就比不了。带构建标识的那份叫
 * `VERSION_LINE`,只给人看(`wechat-cc --version`)。
 */
import pkg from '../../package.json' with { type: 'json' }

/** 纯 semver,给机器比较用。 */
export const APP_VERSION: string = pkg.version

/** 编译期由 apps/desktop/scripts/build-sidecar.ts 用 `--define` 注入;源码跑时不存在。 */
declare const __BUILD_SHA__: string | undefined

/**
 * 构建标识:打包产物里是 git 短 sha,直接跑源码时是 `dev`。
 *
 * 为什么要它:`self deploy` 的健康门打印的就是 `--version` 的输出,而版本号在两次
 * 发版之间从不变——部署完打出同一个数字,看不出新构建到底起没起来。
 */
export const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' && __BUILD_SHA__ ? __BUILD_SHA__ : 'dev'

/** 给人看的一行:`1.7.0 (a1b2c3d)`,源码跑时是 `1.7.0 (dev)`。 */
export const VERSION_LINE: string = `${APP_VERSION} (${BUILD_SHA})`
