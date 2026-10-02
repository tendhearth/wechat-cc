import { join } from 'node:path'
import { resolveBundledPlugins } from '../../lib/plugins-source'

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

// The resolution itself lives in src/lib/plugins-source.ts so the CLI
// (`self deploy`, `plugin source`) can use it without linking the daemon
// (scripts/cli-ratchet.guard.test.ts). Re-exported here: daemon code keeps
// asking this module "where are the plugins".
export {
  dirHasPlugins, pluginsSourcePointerPath, readPluginsSourcePointer, writePluginsSourcePointer,
  resolveBundledPluginsDir, resolveBundledPlugins,
  type BundledPluginsVia, type BundledPluginsResolution, type ResolveBundledPluginsInput,
} from '../../lib/plugins-source'
/**
 * First-party bundled plugins dir, or null when none of the candidates holds
 * any plugin. Shared by the daemon bootstrap, internal API and the CLI so the
 * resolution lives in one place. Pass `stateDir` so the owner's pointer is
 * honoured — every daemon/CLI caller has one.
 */
export function bundledPluginsDir(stateDir?: string): string | null {
  return resolveBundledPlugins(stateDir)?.dir ?? null
}
