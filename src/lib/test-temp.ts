import { lstatSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'

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
