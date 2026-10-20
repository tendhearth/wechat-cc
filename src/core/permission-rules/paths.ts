/**
 * paths.ts — 放行规则里所有路径比对的唯一归一(Windows CI 10-20 抓到:大小写、`\` 与 `/`、盘符都会让红线和 glob 对不上)。
 * win32:按 path.win32 解析,分隔符统一成 `/`,整串小写(NTFS 默认不分大小写);其它平台:posix 解析,原样大小写。
 * 8.3 短名 / 软链不在这里展开 —— 那要碰盘,由 daemon 侧 realpathSync.native 先做(permission-gate.normalizePaths)。
 */
import { posix, win32 } from 'node:path'

export type Platform = NodeJS.Platform

export function canonPath(p: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? win32.resolve(p).replace(/\\/g, '/').toLowerCase() : posix.resolve(p)
}

/** 相对路径按 base 解析后再归一。 */
export function canonUnder(p: string, base: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? canonPath(win32.resolve(base, p), platform) : posix.resolve(base, p)
}

/** child 是 root 本身或在它下面(按分隔符边界)。两边都先归一。 */
export function isUnder(child: string, root: string, platform: Platform = process.platform): boolean {
  const c = canonPath(child, platform), r = canonPath(root, platform)
  return c === r || c.startsWith(r.endsWith('/') ? r : r + '/')
}

/** 每一条都在 root 下(相对路径按 root 解析)。空 ⇒ false。 */
export function pathsUnder(paths: readonly string[], root: string, platform: Platform = process.platform): boolean {
  if (!paths.length) return false
  const r = canonPath(root, platform)
  return paths.every(p => isUnder(canonUnder(p, r, platform), r, platform))
}

/** 拿来做子串比对的文本:win32 上分隔符统一、小写;其它平台原样。 */
export function canonText(s: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s
}
