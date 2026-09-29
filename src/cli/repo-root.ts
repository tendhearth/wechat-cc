import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 源码模式下的仓库根与 CLI 入口(2026-09-27 cli 拆分)。
 *
 * self / hook / service / update 四族原来住在根 cli.ts 里,`dirname(fileURLToPath(import.meta.url))`
 * 就是仓库根、`fileURLToPath(import.meta.url)` 就是 cli.ts。搬进 src/cli/commands/ 之后同一表达式
 * 指向别的目录,所以四处统一从这里取。打包版(bun --compile)没有仓库树,那些地方用
 * `compiledRepoRoot()` / `compiledBinaryPath()` 先判,这里只管源码模式。
 * 守卫:repo-root.test.ts。
 */
export const SOURCE_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CLI_ENTRY = join(SOURCE_REPO_ROOT, 'cli.ts')
