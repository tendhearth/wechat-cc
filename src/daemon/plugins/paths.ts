import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompiledBundle } from '../../lib/runtime-info'
import { dirHasPlugins, readPluginsSourcePointer } from '../../lib/plugins-source'

/**
 * Plugin discovery paths.
 *
 * Two roots, mirroring the VS Code / shell (/etc vs ~) split:
 *
 *   - USER dir  `{stateDir}/plugins/<name>/`     — drop-in, survives upgrades,
 *     third-party. Default DISABLED until explicitly enabled (they spawn
 *     processes = arbitrary code, so discovery ≠ trust).
 *   - BUNDLED   first-party, curated, default ENABLED. Found via
 *     `resolveBundledPluginsDir` below: env → owner pointer in the state dir →
 *     next to the binary (`.app` resources) / `<repo>/plugins` in source mode.
 *     The published installer ships NONE of them (WHY: src/lib/plugins-source.ts).
 *
 * Enable-state lives in `{stateDir}/plugins/plugins.json` so a dashboard
 * toggle survives restarts and upgrades.
 */
export { MANIFEST_FILE } from '../../lib/plugins-source'

export function userPluginsDir(stateDir: string): string {
  return join(stateDir, 'plugins')
}

/**
 * Per-plugin WRITABLE data dir `{stateDir}/plugin-data/<name>/`. A BUNDLED
 * plugin's own dir is read-only/ephemeral (inside a signed .app, wiped on
 * upgrade), so anything it must persist (decrypted output, captured keys) has
 * to live here instead. Exposed to manifests as the `${dataDir}` template.
 */
export function pluginDataDir(stateDir: string, name: string): string {
  return join(stateDir, 'plugin-data', name)
}

export function pluginsConfigPath(stateDir: string): string {
  return join(stateDir, 'plugins', 'plugins.json')
}

// Pointer + `dirHasPlugins` live in src/lib so `self deploy` (cli) can use them
// without importing the daemon. Re-exported here: this module stays the one
// place daemon code asks "where are the plugins".
export { dirHasPlugins, pluginsSourcePointerPath, readPluginsSourcePointer, writePluginsSourcePointer } from '../../lib/plugins-source'
export type BundledPluginsVia = 'env' | 'pointer' | 'app' | 'repo'
export interface BundledPluginsResolution { dir: string; via: BundledPluginsVia }

export interface ResolveBundledPluginsInput {
  /** `WECHAT_CC_BUNDLED_PLUGINS_DIR` (set by the desktop app / service unit). */
  env?: string
  /** State dir for the owner's pointer; omitted ⇒ pointer not consulted. */
  stateDir?: string
  /** Running as the compiled sidecar? */
  compiled: boolean
  /** process.execPath — the sidecar itself when compiled. */
  execPath: string
  /** Repo root in source mode. */
  sourceRepoRoot: string
}

/**
 * Pure-ish resolution (reads the fs, nothing else). First candidate that
 * actually contains plugins wins:
 *   1. env  — what the desktop app / service unit says;
 *   2. pointer — the owner's explicit choice in the state dir;
 *   3. app  — compiled: next to the sidecar (`<MacOS>/plugins`, legacy),
 *             `Contents/Resources/plugins`, and Tauri's `_up_/_up_/_up_/plugins`
 *             (`resources: ["../../../plugins/…"]` maps each `..` to `_up_`;
 *             on Windows/Linux the resource dir is next to the exe);
 *      repo — source mode: `<repo>/plugins`.
 */
export function resolveBundledPluginsDir(input: ResolveBundledPluginsInput): BundledPluginsResolution | null {
  if (input.env && dirHasPlugins(input.env)) return { dir: input.env, via: 'env' }
  if (input.stateDir) {
    const pointer = readPluginsSourcePointer(input.stateDir)
    if (pointer && dirHasPlugins(pointer)) return { dir: pointer, via: 'pointer' }
  }
  if (input.compiled) {
    const exeDir = dirname(input.execPath)
    const up = ['_up_', '_up_', '_up_', 'plugins'] as const
    const candidates = [
      join(exeDir, 'plugins'),
      join(exeDir, '..', 'Resources', 'plugins'),
      join(exeDir, '..', 'Resources', ...up),
      join(exeDir, ...up),
    ]
    const hit = candidates.find(dirHasPlugins)
    return hit ? { dir: hit, via: 'app' } : null
  }
  const dir = join(input.sourceRepoRoot, 'plugins')
  return dirHasPlugins(dir) ? { dir, via: 'repo' } : null
}

/** Live-process wrapper around `resolveBundledPluginsDir`. */
export function resolveBundledPlugins(stateDir?: string): BundledPluginsResolution | null {
  return resolveBundledPluginsDir({
    env: process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR || undefined,
    stateDir,
    compiled: isCompiledBundle(),
    execPath: process.execPath,
    sourceRepoRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), // src/daemon/plugins → repo
  })
}

/**
 * First-party bundled plugins dir, or null when none of the candidates holds
 * any plugin. Shared by the daemon bootstrap, internal API and the CLI so the
 * resolution lives in one place. Pass `stateDir` so the owner's pointer is
 * honoured — every daemon/CLI caller has one.
 */
export function bundledPluginsDir(stateDir?: string): string | null {
  return resolveBundledPlugins(stateDir)?.dir ?? null
}
