/**
 * runtime/ — 运行时(Bun / Node)差异只允许出现在这个目录里。
 * 业务代码 import 这里的函数,不直接碰 `bun:*` 与 `Bun.*`(depcruise 规则把门)。
 * sqlite 见 ./sqlite.ts。
 */
export { isBun } from './sqlite'

/** 同步睡眠:两种运行时都用 Atomics.wait,不依赖 Bun.sleepSync。 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}
