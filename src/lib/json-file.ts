/**
 * JSON 状态文件只有一种写法(第三批 3e,2026-10-22 盘点)。
 *
 * 以前约 40 处各写一份「tmp + renameSync」,其中二十几处用固定的 `<file>.tmp` 名(两个写者会撞同一个 tmp),
 * 另有约 20 处直接覆盖原文件(写到一半崩了就是半个文件),都没有 fsync。最危险的是 agent-config.json:
 * 五个写者里有三条「读-改-写」在读不出来时 `catch { raw = {} }` 然后写回 —— daemon 和 CLI 同时写、一次读到半个
 * 文件,主人整份配置就剩一个键。
 *
 * 这里给两件事:
 *  - `writeJsonAtomic` / `writeFileAtomic`:独一无二的 tmp 名(pid + 随机,`wx` 打开)→ 写完 fsync → rename。
 *    权限:调用方给了 `mode` ⇒ 每次都按它写(存密钥的文件要这样:以前每次写都收回 0o600);没给 ⇒ 已有文件保留原来的
 *    mode、新建默认 0o600(Windows 上 mode 无意义,忽略)。Windows 上目标文件被杀毒 /
 *    索引器占着时 rename 会偶发 EPERM / EBUSY / EACCES:短重试 3 次、间隔 50ms,再不行照实抛。
 *  - `updateJsonFile`:读-改-写。**旧文件存在但读不出来(不是合法 JSON、或不是对象)⇒ 拒写,抛 `UnreadableJsonError`**,
 *    绝不拿 `{}` 顶上去覆盖。读走 readJsonFile(容忍 BOM —— Windows 上 PowerShell 写的文件带 BOM,出过真 bug)。
 *
 * **不解决丢更新**:独立 tmp 名只解决「撞 tmp」;daemon 和 CLI 同时读-改-写,仍是后写的赢(没有锁)。
 * `updateJsonFile` 做了一步乐观检查:写之前看一眼 mtime / size,读完以后被人改过就重读、重算一次;
 * 两次都被抢就照实抛 `ConcurrentJsonUpdateError`,不悄悄覆盖。真要强一致,要上锁,不在这一步。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { readJsonFile } from './read-json-file'

export class UnreadableJsonError extends Error {
  readonly code = 'config_unreadable'
  constructor(readonly path: string, detail: string) {
    super(`${basename(path)} 读不出来(${detail}),没有改它 —— 先看看这个文件是不是被写坏了`)
    this.name = 'UnreadableJsonError'
  }
}

export class ConcurrentJsonUpdateError extends Error {
  readonly code = 'config_busy'
  constructor(readonly path: string) {
    super(`${basename(path)} 刚被别处改过两次,这次没写,稍后再试`)
    this.name = 'ConcurrentJsonUpdateError'
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 同步睡一小会儿(只给 Windows 上 rename 被占用的短重试用;不在热路径上)。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface AtomicWriteOptions {
  /** 给了 ⇒ 每次都按它写(存密钥的文件:令牌、daemon.env、agent-config 里的 a2a key…);没给 ⇒ 已有文件保留原 mode、新建 0o600。 */
  mode?: number
  /** 只给测试:rename 实现与重试间隔。 */
  rename?: (from: string, to: string) => void
  retryDelayMs?: number
  platform?: NodeJS.Platform
}

function existingMode(path: string): number | null {
  try { return statSync(path).mode & 0o777 } catch { return null }
}

export function writeFileAtomic(path: string, data: string, opts: AtomicWriteOptions = {}): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const mode = opts.mode ?? existingMode(path) ?? 0o600
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw err
  }
  closeSync(fd)
  const rename = opts.rename ?? renameSync
  const attempts = (opts.platform ?? process.platform) === 'win32' ? 4 : 1
  for (let i = 0; ; i++) {
    try { rename(tmp, path); return }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i + 1 < attempts && code && RENAME_RETRY_CODES.has(code)) { sleepSync(opts.retryDelayMs ?? 50); continue }
      rmSync(tmp, { force: true })
      throw err
    }
  }
}

export function writeJsonAtomic(path: string, value: unknown, opts: AtomicWriteOptions = {}): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', opts)
}

function stamp(path: string): string | null {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}` } catch { return null }
}

/** 读一个 JSON 对象文件:不存在 ⇒ `{}`;存在但读不出来 / 不是对象 ⇒ 抛 UnreadableJsonError(容忍 BOM)。 */
export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try { parsed = readJsonFile(path) }
  catch (err) { throw new UnreadableJsonError(path, err instanceof Error ? err.message : String(err)) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UnreadableJsonError(path, '不是一个 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 读-改-写一个 JSON 对象文件。`mutate` 就地改(会被调用最多两次,要可重复)。
 * 文件不存在 ⇒ 从 `{}` 开始;存在但读不出来 ⇒ 抛 UnreadableJsonError、不写。
 */
export function updateJsonFile(path: string, mutate: (raw: Record<string, unknown>) => void, opts: AtomicWriteOptions = {}): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = stamp(path)
    const raw = readJsonObject(path)
    mutate(raw)
    if (stamp(path) !== before) continue
    writeJsonAtomic(path, raw, opts)
    return
  }
  throw new ConcurrentJsonUpdateError(path)
}
