/**
 * fs-access.ts — daemon 自己能不能读主人的文件夹(macOS TCC)。
 *
 * WHY(2026-09-04):权限缺失的失败方式是**静默的**。daemon 读 ~/Documents 拿到
 * EPERM,记一行日志,主人在微信里看到的是「读不到那个文件」或者干脆一句
 * 编出来的回答 —— 没有任何地方说「系统没给我权限」。今晚 owner 和我都撞了
 * 同一堵墙。
 *
 * 这个探针**在 daemon 进程里**跑:权限记在责任进程上,CLI(终端里)能读不
 * 代表 daemon 能读。结果进 /v1/health、doctor、桌面「此刻」页。
 *
 * 顺带:LaunchAgent 起的 daemon 第一次读受保护目录会触发系统弹框(如果它的
 * 责任进程有 Info.plist 用途说明,见 apps/desktop/src-tauri/Info.plist)——
 * 所以这个探针也是引导页「授权文件访问」按钮背后的动作。
 */
import { closeSync, openSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type FolderKey = 'documents' | 'desktop' | 'downloads'

export interface FolderAccess {
  folder: FolderKey
  path: string
  /** 'ok' 能列目录;'denied' EPERM(TCC);'missing' 目录不存在;'unknown' 别的错。 */
  state: 'ok' | 'denied' | 'missing' | 'unknown'
  error?: string
}

export interface FsAccessReport {
  platform: NodeJS.Platform
  /** 非 macOS 上没有 TCC,一律 ok —— 但仍然真的去列一次目录,别假装。 */
  folders: FolderAccess[]
  /** 任一受保护目录 denied ⇒ true。 */
  anyDenied: boolean
  /** 系统设置里对应的面板(macOS 13+ 的 deep link)。 */
  settingsUrl: string
}

const FOLDERS: Record<FolderKey, string> = { documents: 'Documents', desktop: 'Desktop', downloads: 'Downloads' }

/** 一条 readdir 的结果分类。EPERM 是 TCC 的签名;ENOENT 是目录不在。 */
export function classifyFsError(err: unknown): FolderAccess['state'] {
  const code = (err as { code?: string } | null)?.code
  if (code === 'EPERM' || code === 'EACCES') return 'denied'
  if (code === 'ENOENT') return 'missing'
  return 'unknown'
}

export function probeFsAccess(opts: { home?: string; platform?: NodeJS.Platform; readdir?: (p: string) => unknown } = {}): FsAccessReport {
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const readdir = opts.readdir ?? ((p: string) => readdirSync(p))
  const folders: FolderAccess[] = (Object.keys(FOLDERS) as FolderKey[]).map(folder => {
    const path = join(home, FOLDERS[folder])
    try { readdir(path); return { folder, path, state: 'ok' as const } }
    catch (err) { return { folder, path, state: classifyFsError(err), error: err instanceof Error ? err.message : String(err) } }
  })
  return {
    platform,
    folders,
    anyDenied: folders.some(f => f.state === 'denied'),
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  }
}

/** 给人看的一句。 */
export function describeFsAccess(r: FsAccessReport): string {
  const denied = r.folders.filter(f => f.state === 'denied').map(f => FOLDERS[f.folder])
  if (denied.length === 0) return '文件访问正常'
  return `系统没给 Tendhearth CC 读「${denied.join('」「')}」的权限 —— 去 系统设置 › 隐私与安全性 › 完全磁盘访问 勾上 Tendhearth CC,然后重启 daemon`
}

/**
 * 完全磁盘访问(FDA)探针 —— **不会弹框**。
 *
 * WHY(2026-10-04 真机):主人两天里被弹了 18 次「"wechat-cc" 想访问其他 App 的数据」
 * (kTCCServiceSystemPolicyAppData)。统一日志里的证据链:
 *   - 访问者是 daemon 每 5 分钟(以及开机第 1 秒)跑的 wxvault `sync.py --changed-only`
 *     (Xcode 的 python3,责任进程记在 com.tendhearth.wechat-cc 头上),读的是微信的
 *     容器 ~/Library/Containers/com.tencent.xinWeChat/。
 *   - tccd 先查 FDA:「Failed to match existing code requirement for subject
 *     com.tendhearth.wechat-cc and service kTCCServiceSystemPolicyAllFiles」——
 *     系统设置里那个 FDA 勾是 09-28 换 Developer ID 签名**之前**(ad-hoc,cdhash 当指定
 *     要求)勾的,对现在的签名不算数。
 *   - 于是落到「访问其他 App 的数据」这一档,它的「允许」是**按进程会话**记的
 *     (「Session scoped auth is invalid for client」):daemon 一重启就作废,再弹。
 *
 * 所以后台(无人值守)碰别的 App 的容器之前,先用这个探针问一句「有没有 FDA」:
 * 打开 TCC 自己的数据库只受 FDA 管,没有 FDA 时是**静默**的 EPERM,不弹任何框
 * (macOS 上探测 FDA 的通用做法;真机上 sqlite3 打开它被拒时 tccd 没有 PROMPTING)。
 * 没有 FDA ⇒ 后台不去碰,改在 health / doctor 里告诉主人去重新勾一次。
 *
 * 返回 null:非 macOS,或者结果说明不了问题(文件不在等)—— 调用方当「不知道」处理。
 */
export function hasFullDiskAccess(opts: { home?: string; platform?: NodeJS.Platform; open?: (p: string) => void } = {}): boolean | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') return null
  const path = join(opts.home ?? homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
  const open = opts.open ?? ((p: string) => { closeSync(openSync(p, 'r')) })
  try { open(path); return true }
  catch (err) { return classifyFsError(err) === 'denied' ? false : null }
}

/** 没有 FDA 时给主人的一句话(health / doctor / 日志共用)。 */
export const FDA_MISSING_HINT =
  '微信聊天记录的后台同步暂停了:系统没给 Tendhearth CC「完全磁盘访问」(或者那个勾是旧签名时勾的,对现在的版本不算数)。' +
  '去 系统设置 › 隐私与安全性 › 完全磁盘访问,把 Tendhearth CC 先用「−」删掉、再用「+」重新加入 /Applications/wechat-cc.app 并打开,然后重启 daemon。' +
  '只需做一次;之后不会再弹「想访问其他 App 的数据」。'
