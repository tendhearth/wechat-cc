/**
 * exec-identity — 本进程的可执行文件在盘上还是启动时那一个吗。
 *
 * WHY: 打包版 daemon 从 .app 里跑,桌面更新器(tauri-plugin-updater,macOS)把整个
 * .app rename 到备份目录再换入新包 —— 旧进程不会被杀,继续跑旧的 sidecar;之后只
 * 重启 app,不重启 daemon;而 stale-code 只认 git HEAD,bundle 里不是仓库,读到 null
 * 就"不动"。结果:主人更新完桌面版,后台悄悄停在上一版(2026-09-16 实测)。
 *
 * 这里给 stale-code 补第二个信号:启动时记下 process.execPath 的 inode/size/mtime,
 * 之后任何一项变了就是"盘上的代码动过"。rename 换入(新 inode)、原地改写(mtime/size)
 * 都能看见。纯函数、零副作用;stat 失败一律 null,由调用方按"读不到就不动"兜底。
 */
import { statSync } from 'node:fs'

export interface ExecIdentity { ino: number; size: number; mtimeMs: number }

export function readExecIdentity(path: string): ExecIdentity | null {
  try {
    const s = statSync(path)
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** 任一侧读不到 ⇒ false:宁可永远不重启,也不能因为一次 stat 抖动把主人的 bot 踢下线。 */
export function execIdentityChanged(boot: ExecIdentity | null, now: ExecIdentity | null): boolean {
  if (!boot || !now) return false
  return boot.ino !== now.ino || boot.size !== now.size || boot.mtimeMs !== now.mtimeMs
}
