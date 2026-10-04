/**
 * app-relocation.ts — app 在盘上换了位置 / 换了二进制名之后,把指向旧路径的东西改过来。
 *
 * 为什么需要(2026-10-04,1.7.5 改名迁移,docs/maintainer/app-rename-migration.md):
 * LaunchAgent 的 ProgramArguments[0]、WorkingDirectory、终端 hook 的命令行,都是**安装那一刻**
 * 写进去的绝对路径。以下任一件事发生后它们就指向不存在的文件:
 *   - 原地更新把主二进制从 `wechat_cc_desktop` 换成 `Tendhearth CC`、sidecar 从
 *     `wechat-cc-cli` 换成 `tendhearth-cc-cli`(tauri updater 整包替换,旧文件不留);
 *   - app 把自己从 `wechat-cc.app` 改名成 `Tendhearth CC.app`;
 *   - 主人自己把 app 拖到别处。
 * 指向不存在的文件意味着:daemon 下一次退出后 launchd 拉不起来(KeepAlive 照着已加载的旧
 * 定义去 spawn,ENOENT),终端 claude / codex 每个回合都报 hook 失败。
 *
 * 判定只有一条:**旧目标不存在才改**。旧目标还在 ⇒ 那是另一份合法安装(比如主人在 worktree 里
 * 打的开发包正指着它),绝不抢。另外,自己跑在「不该被 LaunchAgent 指着」的位置时一律不改:
 * App Translocation(隔离运行的随机路径)、挂载的 dmg(/Volumes/)、cargo 的 target/…/bundle/。
 *
 * 全是纯函数:读文件 / 判断存在 / 写文件都由调用方(commands/service.ts)注入。
 */
import { appBundleRootOf, isSidecarBasename, pathBasename } from '../lib/app-identity'

export interface SelfLocation {
  /** 本包主二进制(…/Contents/MacOS/Tendhearth CC),非打包版 / 非 macOS ⇒ null。 */
  mainBinary: string | null
  /** 本包 sidecar(process.execPath),非打包版 ⇒ null。 */
  sidecar: string | null
}

export type LaunchAgentRepairPlan =
  | { action: 'none'; reason: 'no_launchagent' | 'not_app_bundle' | 'not_packaged' | 'self_location_unsafe' | 'ok' | 'points_elsewhere' }
  | { action: 'rewrite'; reason: 'stale'; fromProgram: string; toProgram: string; fromApp: string; toApp: string; xml: string }

/** 自己在这些地方跑时,不把 LaunchAgent 指过来:路径随机 / 会被弹出 / 是开发构建。 */
export function unsafeSelfLocation(p: string): string | null {
  if (p.includes('/AppTranslocation/')) return 'translocated'
  if (p.startsWith('/Volumes/')) return 'mounted_volume'
  // tauri 的产物永远在 `<target>/<profile>/bundle/macos/X.app`;target 目录可能叫别的(CARGO_TARGET_DIR)。
  if (/\/bundle\/macos\//.test(p) || /\/target\/(release|debug)\//.test(p)) return 'dev_build'
  return null
}

export function planLaunchAgentRepair(input: {
  plistXml: string | null
  self: SelfLocation
  exists: (p: string) => boolean
}): LaunchAgentRepairPlan {
  if (!input.plistXml) return { action: 'none', reason: 'no_launchagent' }
  const arr = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(input.plistXml)
  const first = arr ? /<string>([\s\S]*?)<\/string>/i.exec(arr[1]!) : null
  const program = first ? unescapeXml(first[1]!.trim()) : ''
  const fromApp = program ? appBundleRootOf(program) : null
  // 开发模式的 plist(bun + cli.ts)不归这里管。
  if (!fromApp) return { action: 'none', reason: 'not_app_bundle' }
  if (!input.self.mainBinary || !input.self.sidecar) return { action: 'none', reason: 'not_packaged' }
  const toApp = appBundleRootOf(input.self.mainBinary)
  if (!toApp || unsafeSelfLocation(toApp)) return { action: 'none', reason: 'self_location_unsafe' }
  // 老形状(09-04 之前)的 plist 直接指 sidecar;保持形状,只换路径。
  const toProgram = isSidecarBasename(pathBasename(program)) ? input.self.sidecar : input.self.mainBinary
  if (program === toProgram) return { action: 'none', reason: 'ok' }
  if (input.exists(program)) return { action: 'none', reason: 'points_elsewhere' }

  const prefix = `${fromApp}/`
  const xml = input.plistXml.replace(/<string>([\s\S]*?)<\/string>/g, (whole, raw: string) => {
    const v = unescapeXml(raw.trim())
    if (v === program) return `<string>${escapeXml(toProgram)}</string>`
    if (v === fromApp) return `<string>${escapeXml(toApp)}</string>`
    if (v.startsWith(prefix)) return `<string>${escapeXml(toApp + v.slice(fromApp.length))}</string>`
    return whole
  })
  return { action: 'rewrite', reason: 'stale', fromProgram: program, toProgram, fromApp, toApp, xml }
}

/**
 * 终端 hook 的命令行(`"<sidecar>" hook claude`)指向一个不存在的 sidecar ⇒ 该换成自己。
 * 只认引号里第一段是我们 sidecar 名字的那种;源码模式(`"bun" "cli.ts" hook …`)、
 * 路径还在的(另一份安装)都不动。返回 null = 不用改。
 */
export function staleHookProgram(command: string | null, selfSidecar: string | null, exists: (p: string) => boolean): string | null {
  if (!command || !selfSidecar) return null
  const m = /^\s*"([^"]+)"/.exec(command)
  const program = m?.[1]
  if (!program || program === selfSidecar) return null
  if (!isSidecarBasename(pathBasename(program))) return null
  if (exists(program)) return null
  return program
}

/** `wechat-cc` 转发脚本的内容。第二行是自家标记:只覆盖带标记的文件,别人的同名文件不碰。 */
export const FORWARDER_MARKER = '# wechat-cc forwarder — managed by Tendhearth CC (`wechat-cc service repair`)'

export function forwarderScript(sidecar: string): string {
  return `#!/bin/sh\n${FORWARDER_MARKER}\nexec ${shQuote(sidecar)} "$@"\n`
}

/** 要不要(重)写转发脚本:不存在 ⇒ 写;带标记但目标不同 ⇒ 写;不带标记(别人的)⇒ 不碰。 */
export function forwarderAction(existing: string | null, sidecar: string): 'write' | 'ok' | 'foreign' {
  if (existing === null) return 'write'
  if (!existing.includes(FORWARDER_MARKER)) return 'foreign'
  return existing === forwarderScript(sidecar) ? 'ok' : 'write'
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
