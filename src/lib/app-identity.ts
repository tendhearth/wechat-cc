/**
 * app-identity.ts — 桌面包在盘上叫什么(2026-10-04,1.7.5 改名迁移)。
 *
 * 主人定:用户在系统里看到的任何「wechat-cc」都换成 Tendhearth CC —— .app 名、
 * 活动监视器里的两个进程名(app 主二进制、sidecar)。**只在 macOS 改**:Windows
 * 的 NSIS 安装目录和卸载注册表键都挂在 productName 上,改了会装成并排的第二份;
 * Linux 的 deb/rpm 包名同理。
 *
 * 永远不变的:bundle id `com.tendhearth.wechat-cc`(TCC 授权按 bundle id + 签名的
 * 指定要求记,不看路径和文件名)、CLI 命令名 `wechat-cc`、状态目录、URL scheme、
 * 钥匙串键、LaunchAgent label `com.wechat-cc.daemon`。
 *
 * 新旧名字**并存**是常态而不是过渡:老安装在原地更新后(tauri updater 把新包内容
 * 解进**正在运行的那个** .app 路径,见 docs/maintainer/app-rename-migration.md)
 * 路径还是 `wechat-cc.app`,直到 app 自己改名;回滚到 1.7.4 又会出现老文件名。
 * 所以每一处「认自己的二进制」的地方都要认整张表,新名字排前面。
 *
 * 纯常量 + 纯函数,lib 层(不许 import cli/daemon/core)。
 */

/** 永不改。TCC / 通知 / WebKit 存储 / 钥匙串都挂在它上面。 */
export const APP_BUNDLE_ID = 'com.tendhearth.wechat-cc'

/** macOS 新包的 .app 名(= tauri.macos.conf.json 的 productName + `.app`)。 */
export const APP_BUNDLE_NAME = 'Tendhearth CC.app'
/** 老安装的 .app 名。只有这张表里的名字会被 app 自己改成 APP_BUNDLE_NAME。 */
export const LEGACY_APP_BUNDLE_NAMES: readonly string[] = ['wechat-cc.app']

/**
 * app 主二进制(CFBundleExecutable)的历代名字,新的在前:
 *   `Tendhearth CC`(1.7.5 起,tauri.macos.conf.json 的 mainBinaryName)
 *   `wechat_cc_desktop`(2026-09-29 起,Cargo 包名)
 *   `wechat-cc`(更早,productName)
 */
export const APP_MAIN_BINARY_NAMES: readonly string[] = ['Tendhearth CC', 'wechat_cc_desktop', 'wechat-cc']

/**
 * sidecar(bun 编译的 CLI / daemon 本体)的历代名字,新的在前。新名字只在 macOS 用;
 * Windows / Linux 照旧 `wechat-cc-cli`(计划任务 / systemd unit 里写死的是它)。
 */
export const SIDECAR_NAMES: readonly string[] = ['tendhearth-cc-cli', 'wechat-cc-cli']
export const SIDECAR_NAME_DARWIN = 'tendhearth-cc-cli'
export const SIDECAR_NAME_OTHER = 'wechat-cc-cli'

/** 本平台新构建出来的 sidecar 叫什么(不带 .exe)。 */
export function sidecarNameFor(platform: NodeJS.Platform | string): string {
  return platform === 'darwin' ? SIDECAR_NAME_DARWIN : SIDECAR_NAME_OTHER
}

/** basename(可带 .exe)是不是我们的 sidecar —— 认新旧两代。 */
export function isSidecarBasename(name: string): boolean {
  const n = name.toLowerCase().replace(/\.exe$/, '')
  return SIDECAR_NAMES.includes(n)
}

/** 任意路径的最后一段(兼容 / 和 \)。 */
export function pathBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * `…/X.app/Contents/MacOS/<bin>` 或 `…/X.app/Contents/MacOS` → `…/X.app`;不是 bundle 里的路径 ⇒ null。
 * 只认 POSIX 斜杠:只在 macOS 有意义。
 */
export function appBundleRootOf(p: string): string | null {
  const parts = p.replace(/\/+$/, '').split('/')
  const i = parts.lastIndexOf('MacOS')
  if (i < 2 || parts[i - 1] !== 'Contents' || !parts[i - 2]!.endsWith('.app')) return null
  return parts.slice(0, i - 1).join('/') || null
}
