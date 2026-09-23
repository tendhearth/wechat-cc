/**
 * runtime-info.ts — single source of truth for "are we running as a
 * `bun build --compile`d desktop sidecar, or as the source-mode CLI?".
 *
 * Bun packs the entry script under `/$bunfs/root/...` in compiled binaries.
 * Three modules need to know this and previously each duplicated the
 * detection inline:
 *   - cli.ts         (service install path picks binaryPath vs bunPath+cli.ts)
 *   - cli.ts         (update command short-circuits when no .git available)
 *   - doctor.ts      (defaultServiceSnapshot resolves the service plan)
 *
 * The detection is brittle (literal `/$bunfs/` is a Bun internal that could
 * change). Centralizing here means one place to update if Bun ever rev's
 * the prefix, and one place to add a more durable check (e.g. probing
 * import.meta.dir existence) without touching downstream callers.
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Internals exposed for tests (real process.argv / process.execPath aren't
// easy to spoof in vitest, so we factor pure decisions out and let the
// public API thread real values through them).
export const __testInternals = {
  // Two-stage detection:
  //   1. Primary — argv[1] starts with `/$bunfs/`. This is the documented
  //      Bun virtual-fs prefix in compiled binaries today and works
  //      reliably across all Bun launch modes we've tested.
  //   2. Fallback — module dir doesn't exist on disk. If Bun ever changes
  //      the virtual-fs prefix, the primary signal goes silent; the
  //      fallback catches it because import.meta.dir is still a virtual
  //      path that fails existsSync(). Source mode always has a real
  //      on-disk repo root, so the fallback returns false there.
  // Pass `moduleDir` as undefined to skip the fallback (used by tests and
  // when we know argv[1] is reliable for the call site).
  detectCompiledBundle(argv1: string | undefined, moduleDir?: string): boolean {
    if (typeof argv1 === 'string' && argv1.startsWith('/$bunfs/')) return true
    if (moduleDir && !existsSync(moduleDir)) return true
    return false
  },
  resolveCompiledBinaryPath(isCompiled: boolean, execPath: string): string | null {
    return isCompiled ? execPath : null
  },
  resolveCompiledRepoRoot(isCompiled: boolean, execPath: string): string | null {
    return isCompiled ? dirname(execPath) : null
  },
}

/** True when this process is the `wechat-cc-cli` sidecar inside a desktop bundle. */
export function isCompiledBundle(): boolean {
  // Pass import.meta.url's dirname so the fallback can probe whether the
  // module's source dir actually exists. Wrapped in try/catch for the
  // pathological case where fileURLToPath itself fails (non-file URL).
  let moduleDir: string | undefined
  try { moduleDir = dirname(fileURLToPath(import.meta.url)) } catch {}
  return __testInternals.detectCompiledBundle(process.argv[1], moduleDir)
}

/**
 * Path to the compiled wechat-cc-cli binary, or null in source mode. When
 * non-null, this is what the service unit's ExecStart should point at —
 * one self-contained binary, no external `bun` runtime needed.
 */
export function compiledBinaryPath(): string | null {
  return __testInternals.resolveCompiledBinaryPath(isCompiledBundle(), process.execPath)
}

/**
 * 打包版里 app 的主二进制(`…/Contents/MacOS/wechat-cc`),和 sidecar 并排。
 *
 * WHY(2026-09-04):LaunchAgent 该指向**它**而不是 sidecar —— macOS 把隐私
 * 权限(TCC)记在「责任进程」上:主二进制在签了名的 bundle 里、带 Info.plist
 * 的用途说明,系统设置里显示的是「wechat-cc」;sidecar 是个裸二进制,显示
 * 「wechat-cc-cli」、没有说明,而且 ad-hoc 签名每次构建都变、授权跟着失效。
 * 主二进制 `--daemon` 只做一件事:把 sidecar 拉起来(apps/desktop/src-tauri/
 * src/daemon_mode.rs)。claude / codex / agy / wxvault 都是它的后代,继承授权。
 *
 * 只在 macOS 打包模式下有意义;别的情况返回 null,规划器回落到 sidecar / bun。
 */
export function appMainBinaryPath(): string | null {
  const side = compiledBinaryPath()
  if (!side || process.platform !== 'darwin') return null
  const main = join(dirname(side), 'wechat-cc')
  try { return statSync(main).isFile() ? main : null } catch { return null }
}

/**
 * Best-guess "where would the binary expect to find its repo siblings".
 * In compiled mode this is the bundle's MacOS/ directory (no real git
 * repo present — `update` should short-circuit). In source mode, callers
 * should fall back to dirname(fileURLToPath(import.meta.url)) themselves
 * since that's a build-time concern.
 */
export function compiledRepoRoot(): string | null {
  return __testInternals.resolveCompiledRepoRoot(isCompiledBundle(), process.execPath)
}
