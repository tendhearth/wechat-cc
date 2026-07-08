import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compiledRepoRoot, isCompiledBundle } from '../../lib/runtime-info'

/**
 * Plugin discovery paths.
 *
 * Two roots, mirroring the VS Code / shell (/etc vs ~) split:
 *
 *   - USER dir  `{stateDir}/plugins/<name>/`     — drop-in, survives upgrades,
 *     third-party. Default DISABLED until explicitly enabled (they spawn
 *     processes = arbitrary code, so discovery ≠ trust).
 *   - BUNDLED   `{repoRoot}/plugins/<name>/`      — first-party, ships & versions
 *     with wechat-cc, curated. Default ENABLED. Absent in compiled bundles
 *     (nothing writable inside a signed .app), hence optional.
 *
 * Enable-state lives in `{stateDir}/plugins/plugins.json` so a dashboard
 * toggle survives restarts and upgrades.
 */
export const MANIFEST_FILE = 'wechat-cc.plugin.json'

export function userPluginsDir(stateDir: string): string {
  return join(stateDir, 'plugins')
}

export function pluginsConfigPath(stateDir: string): string {
  return join(stateDir, 'plugins', 'plugins.json')
}

/**
 * First-party bundled plugins dir `<repo>/plugins`, or null when it doesn't
 * exist (e.g. a compiled bundle ships no writable source tree). Shared by the
 * daemon bootstrap and the CLI so repo-root resolution lives in one place.
 */
export function bundledPluginsDir(): string | null {
  // Desktop app: Tauri knows where it bundled resources (platform-specific:
  // Contents/Resources on macOS, next to the exe on Windows, usr/lib on Linux)
  // and passes the resolved plugins dir via this env when spawning the sidecar.
  // Trusted first because the daemon can't portably derive it from execPath.
  const fromEnv = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const root = isCompiledBundle()
    ? compiledRepoRoot()                                                // compiled: plugins ride next to the binary
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')  // src/daemon/plugins → repo
  if (!root) return null
  const dir = join(root, 'plugins')
  return existsSync(dir) ? dir : null
}
