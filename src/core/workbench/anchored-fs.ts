import {closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, type BigIntStats, type Dirent} from 'node:fs'
import {isAbsolute, join, parse} from 'node:path'

/**
 * anchored-fs.ts — 成果 / 附件 / API 文件三处共用的"锚定"文件访问,纯 JS。
 *
 * 之前这三处靠 bun:ffi 的 openat / mkdirat / unlinkat(每一级都从上一级的目录描述符打开,
 * 路径检查与打开之间没有缝)。代价是:Windows 整个没有、macOS 上 TinyCC 要 Xcode CLT 许可、
 * 出了问题只能靠人查 Bun 的怪癖(2026-09-16 定案换掉,见 docs/cc-workbench.md 修订记录)。
 *
 * 这里的做法是 **先开再核**,而不是"先查再开":
 *   1. 开之前按路径逐级 lstat,任何一级是链接就拒(拦住明摆着的越界)。
 *   2. 用 O_NOFOLLOW(有的平台)打开叶子,拿到描述符。
 *   3. **拿到描述符之后**再逐级 lstat 一遍,并核对 fstat(fd) 与 lstat(叶子) 的 (dev, ino) 一致。
 * 第 3 步是关键:我们读写的是那个描述符;核对证明"此刻这条不含链接的路径指向的就是这个文件"。
 * 攻击者要骗过它,得让一条不含链接的路径解析到项目之外的文件 —— 只剩硬链接和挂载点这两条
 * 老路,而 openat 方案对它们同样无能为力(API 文件那边另外用 nlink === 1 拦硬链接)。
 *
 * 每个平台差异都写在用到的地方;win32 没有 O_NOFOLLOW / O_NONBLOCK,靠 lstat 前后核对。
 */

const FLAGS = constants as unknown as Record<string, number | undefined>
export const O_NOFOLLOW = FLAGS.O_NOFOLLOW ?? 0
export const O_NONBLOCK = FLAGS.O_NONBLOCK ?? 0
const O_CLOEXEC = FLAGS.O_CLOEXEC ?? 0

export interface FileIdentity { dev: bigint; ino: bigint }
export const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino

/** lstat,且不许是链接;任何失败都归到调用方的错误码,不泄漏系统路径。 */
export function lstatNoLink(path: string, error: string): BigIntStats {
  let stat: BigIntStats
  try { stat = lstatSync(path, {bigint: true}) } catch { throw new Error(error) }
  if (stat.isSymbolicLink()) throw new Error(error)
  return stat
}

/**
 * 从 base 起逐级核对 parts:base 与每一级中间目录都得是"真目录"(非链接),叶子不许是链接。
 * 返回叶子的路径与 lstat。`leafDirectory` 要求叶子也是目录。
 */
export function verifyChain(base: string, parts: readonly string[], error: string, opts: {leafDirectory?: boolean} = {}): {path: string; stat: BigIntStats} {
  if (!isAbsolute(base)) throw new Error(error)
  let cursor = base
  let stat = lstatNoLink(cursor, error)
  if (!stat.isDirectory()) throw new Error(error)
  parts.forEach((part, index) => {
    if (!part || part === '.' || part === '..' || /[\\/\0]/.test(part)) throw new Error(error)
    cursor = join(cursor, part)
    stat = lstatNoLink(cursor, error)
    const last = index === parts.length - 1
    if ((!last || opts.leafDirectory) && !stat.isDirectory()) throw new Error(error)
  })
  return {path: cursor, stat}
}

/** 从文件系统根开始核对:项目目录的每一个祖先都不能是链接(API 文件那边的要求)。 */
export function verifyFromFilesystemRoot(directory: string, error: string): {path: string; stat: BigIntStats} {
  if (!isAbsolute(directory)) throw new Error(error)
  const {root} = parse(directory)
  const parts = directory.slice(root.length).split(/[\\/]/).filter(Boolean)
  return verifyChain(root, parts, error, {leafDirectory: true})
}

/** 拿到描述符之后再核一遍链路,并证明描述符就是这条路径此刻指向的文件。 */
export function verifyOpened(fd: number, base: string, parts: readonly string[], error: string): BigIntStats {
  const {stat} = verifyChain(base, parts, error)
  const opened = fstatSync(fd, {bigint: true})
  if (!sameFile(opened, stat)) throw new Error(error)
  return opened
}

/**
 * 锚定地打开 base 下 parts 指向的文件。带 O_CREAT 时叶子可以尚不存在(只核对目录链);
 * 否则整条链先核一遍。打开后一律再核(见文件头)。失败统一抛 error。
 */
export function openAnchored(base: string, parts: readonly string[], flags: number, mode: number, error: string): number {
  if (parts.length === 0) throw new Error(error)
  const creating = (flags & constants.O_CREAT) !== 0
  const {path: directory} = verifyChain(base, parts.slice(0, -1), error, {leafDirectory: true})
  if (!creating) verifyChain(base, parts, error)
  let fd: number
  try { fd = openSync(join(directory, parts.at(-1)!), flags | O_NOFOLLOW | O_CLOEXEC, mode) } catch { throw new Error(error) }
  try { verifyOpened(fd, base, parts, error) } catch (verifyError) { closeSync(fd); throw verifyError }
  return fd
}

/** 逐级建目录:每一级建完(或已存在)都要 lstat 证明它是真目录,不是链接。返回叶子路径。 */
export function mkdirAnchored(base: string, parts: readonly string[], error: string): string {
  let cursor = verifyChain(base, [], error).path
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\/\0]/.test(part)) throw new Error(error)
    cursor = join(cursor, part)
    try { mkdirSync(cursor, {mode: 0o700}) } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(error)
    }
    if (!lstatNoLink(cursor, error).isDirectory()) throw new Error(error)
  }
  return cursor
}

/** 列目录:名字来自 readdir,从不解析任何一项的路径。列完再核一遍链路,防目录被换。 */
export function readdirAnchored(base: string, parts: readonly string[], error: string): Dirent[] {
  const {path} = verifyChain(base, parts, error, {leafDirectory: true})
  let entries: Dirent[]
  try { entries = readdirSync(path, {withFileTypes: true}) } catch { throw new Error(error) }
  verifyChain(base, parts, error, {leafDirectory: true})
  return entries
}

/**
 * 读满一个已打开的普通文件,读前读后 fstat 必须一致(大小 / mtime / ctime),超过 maxBytes 拒。
 * 不是普通文件(目录、FIFO)算 sizeError —— 和之前 openat 版本一致。
 */
export function readBounded(fd: number, maxBytes: number, sizeError: string, changedError: string): {bytes: Buffer; before: BigIntStats} {
  const before = fstatSync(fd, {bigint: true})
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(sizeError)
  const bytes = Buffer.allocUnsafe(maxBytes + 1)
  let length = 0
  while (length < bytes.length) {
    const n = readSync(fd, bytes, length, bytes.length - length, null)
    if (n === 0) break
    length += n
  }
  if (length > maxBytes) throw new Error(sizeError)
  const after = fstatSync(fd, {bigint: true})
  if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error(changedError)
  return {bytes: bytes.subarray(0, length), before}
}
