/**
 * 记忆 / 联系人事实第一次进主库时留的 `*.imported-<日期>` 副本(架构终态 G3 / G7)。
 *
 * 1.7.8 之前它们和原文件放在一起(`memory/<chat>/memory.md.imported-…`、`knowledge/facts.db.imported-…`);
 * 主人 10-26 定「留到下一个小版本发版,再挪进 memory-archive/,不删」。1.7.8 发了:新留的副本直接写进 memory-archive/,
 * 开机时把还留在原处的挪过去。只挪(同一个状态目录里 rename),从不删;目的地已经有同名文件 ⇒ 两边都不动,记一行。
 */
import { mkdirSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** `<原文件名>.imported-YYYY-MM-DD` —— 只认这个形状,别的文件一概不碰。 */
export function importedCopyName(file: string, day: string): string {
  return `${file}.imported-${day}`
}

function isImportedCopyOf(name: string, files: readonly string[]): boolean {
  const m = /^(.+)\.imported-\d{4}-\d{2}-\d{2}$/.exec(name)
  return m !== null && files.includes(m[1]!)
}

/** 建好存档目录(0700,和 memory-archive 别处一样)并返回它。 */
export function ensureArchiveDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 把 `fromDir` 里 `files` 的 `*.imported-<日期>` 副本挪进 `toDir`。返回挪了几个。
 * 目的地已有同名 ⇒ 不覆盖、原处那份也不删,记一行;读不了目录 ⇒ 什么都不做。
 */
export function moveImportedCopies(fromDir: string, toDir: string, files: readonly string[], log: (line: string) => void): number {
  let names: string[]
  try { names = readdirSync(fromDir) } catch { return 0 }
  const copies = names.filter(n => isImportedCopyOf(n, files))
  if (!copies.length) return 0
  ensureArchiveDir(toDir)
  let moved = 0
  for (const n of copies) {
    const dst = join(toDir, n)
    if (existsSync(dst)) { log(`${n}: memory-archive already has one with this name — left both as they are`); continue }
    try { renameSync(join(fromDir, n), dst); moved++ } catch (e) { log(`${n}: could not move into memory-archive (left in place): ${e instanceof Error ? e.message : String(e)}`) }
  }
  return moved
}
