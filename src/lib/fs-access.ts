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
import { readdirSync } from 'node:fs'
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
  return `系统没给 wechat-cc 读「${denied.join('」「')}」的权限 —— 去 系统设置 › 隐私与安全性 › 完全磁盘访问 勾上 wechat-cc,然后重启 daemon`
}
