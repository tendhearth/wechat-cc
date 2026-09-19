import { chmodSync, lstatSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from './runtime/process'

/**
 * 写一个 POSIX `#!/bin/sh` 可执行夹具,并且**先自己空跑一次把它热起来**,
 * 再交给被测代码去探测。
 *
 * 为什么要空跑:2026-09-19 实测,macOS 上「刚写出来的可执行文件」第一次 exec
 * 要付一笔一次性的校验开销(XProtect / 代码签名评估),同一个文件从第二次起
 * 只要 4ms —— 三个新文件首跑 210ms / 329ms / 400ms、再跑都是 4ms,而
 * `/bin/echo` 这种早跑过的系统二进制一直是 4ms。**这笔开销是按文件算的,不是
 * 按进程算的**,所以「每条用例现写一个假 CLI 再立刻 exec」这个姿势每次都要付。
 *
 * 满载套件里(614 个文件抢 18 核)这笔首跑开销实测涨到 3002ms 和 4886ms,正好
 * 把产线那两个短 deadline 吃穿:`probeBinaryVersion` 硬顶 3s、`agyVersionOk`
 * 缺省 5s。于是 bootstrap / providers 里「装上假 CLI ⇒ provider 注册成功」那
 * 几条随机假红,而症状是 `expected false to be true`(探测超时 ⇒ 不注册),
 * **不是** `Test timed out`,从报错里根本看不出是这件事。
 *
 * 真机上被探测的是 claude / codex / cursor-agent / agy 这些早就跑过的稳定文件
 * (4ms),所以这是**夹具的毛病,不是产线的毛病**:正确的修法是把这笔一次性
 * 开销在断言之前付掉,而不是去放宽产线的 deadline,也不是把真 spawn 换成
 * mock —— 那几条用例要的恰恰是「真 spawn 一个真文件」这条边界。
 */
export function writeWarmExecFixture(path: string, script: string): void {
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  // win32 上这类 `#!/bin/sh` 夹具的用例本来就 runIf 掉了,不必也不能热身。
  if (process.platform === 'win32') return
  // 夹具都是「打印个版本号就退出」的一行脚本,空跑一次没有副作用。热身本身
  // 失败也不要紧(那就退回原来的行为,让被测代码自己去撞)。
  try { spawnSync([path, '--version'], {}) } catch { /* best effort */ }
}

/**
 * 测试夹具删临时目录用这个,别直接 rmSync。
 *
 * Windows CI(2026-09-16,466 条红里 831 处 EBUSY):bun:sqlite 的 `db.close()` 之后
 * 立刻 `rmSync` 目录,Windows 会报 `EBUSY: resource busy or locked` —— 连 db.test.ts
 * 里「开库、查 PRAGMA、close、删目录」这么干净的用例也红。macOS / Linux 允许删掉
 * 仍被打开的文件,所以本机永远看不见。这里在 win32 上退避重试;实在删不掉就留给
 * runner 的临时目录清理,打一行警告,不让**清理**把一条已经通过的测试判红。
 * 其他平台行为不变(照旧抛)。
 */
/**
 * 删一个链接(文件或目录链接)。bun 的 rmSync 在 Windows 上删目录链接会报 EFAULT;
 * 目录链接在 Windows 上要用 rmdir,文件链接用 unlink。只删链接本身,从不碰目标。
 */
export function removeLink(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isSymbolicLink()) throw new Error(`removeLink: not a link: ${path}`)
  if (process.platform === 'win32') { try { rmdirSync(path); return } catch { /* file link */ } }
  unlinkSync(path)
}

export function removeTempDir(path: string): void {
  const win32 = process.platform === 'win32'
  for (let attempt = 0; ; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return }
    catch (error) {
      if (!win32) throw error
      if (attempt >= 20) { console.warn(`[test-temp] leaving ${path}: ${String(error)}`); return }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}
