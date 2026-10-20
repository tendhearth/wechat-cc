/**
 * 审阅写盘的两样共用件(整文件撤销 / 按块撤回):严格读、原子换。
 * 一律原始字节:读出来按 UTF-8 严格解(不吃 BOM),写回去 Buffer.from(next,'utf8') —— 字符串 ⇄ 字节一一对应。
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { openAnchored, verifyChain } from '../anchored-fs'
import { readAnchoredRegular } from '../artifacts'

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** 不是合法 UTF-8 ⇒ 抛(调用方当 review_file_changed:快照里有 diff 的文件本来都是合法 UTF-8)。BOM 原样留着。 */
export const decodeStrict = (bytes: Uint8Array): string => strict.decode(bytes)

/**
 * 读盘上现在的内容:先 lstat(只认普通文件,不跟链接)、再锚定读、严格解码。
 * 不存在 ⇒ null;不是普通文件 ⇒ `fail`;别的(读不了、不是 UTF-8、读的时候变了)⇒ review_file_changed。
 */
export function readCurrentText(root: string, path: string, fail: string): { text: string | null; mode: number } {
  let mode = 0o644
  try {
    const st = lstatSync(join(root, path))
    if (!st.isFile()) throw new Error(fail)
    mode = st.mode & 0o777
    return { text: decodeStrict(readAnchoredRegular(root, path)), mode }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode }
    throw new Error(error instanceof Error && error.message === fail ? fail : 'review_file_changed')
  }
}

/**
 * 原子换掉一个文件:同目录临时文件(O_EXCL、不跟链接)→ 写全 → fchmod(umask 不吃掉权限位)→ fsync →
 * 再验一遍目录链 → rename。中途失败删掉临时文件。目录不在 / 被换成链接 ⇒ `fail`。
 */
export function atomicReplace(root: string, path: string, bytes: Buffer, mode: number, fail: string): void {
  const parts = path.split('/')
  verifyChain(root, parts.slice(0, -1), fail, { leafDirectory: true })
  const tmpParts = [...parts.slice(0, -1), `.${parts.at(-1)}.cc-revert-${randomUUID().slice(0, 8)}`]
  const fd = openAnchored(root, tmpParts, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode, fail)
  try {
    let at = 0
    while (at < bytes.length) at += writeSync(fd, bytes, at)
    try { fchmodSync(fd, mode) } catch { /* Windows 没有权限位 */ }
    fsyncSync(fd)
  } catch (error) { closeSync(fd); try { unlinkSync(join(root, ...tmpParts)) } catch { /* best-effort */ }; throw error }
  closeSync(fd)
  try { verifyChain(root, parts.slice(0, -1), fail, { leafDirectory: true }); renameSync(join(root, ...tmpParts), join(root, ...parts)) }
  catch (error) { try { unlinkSync(join(root, ...tmpParts)) } catch { /* best-effort */ }; throw error }
}
