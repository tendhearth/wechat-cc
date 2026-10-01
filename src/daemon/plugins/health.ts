/**
 * Plugin health snapshot — what the daemon actually loaded at boot, exposed as
 * `GET /v1/health.plugins` and checked by `self deploy`'s gate.
 *
 * WHY (2026-09-30): from 2026-09-11 the packaged daemon loaded ZERO plugins
 * (no bundled dir found) and nothing said so — the only trace was customer
 * review logging "disabled". "Expected" is derived from the operator's own
 * explicit choices: a name switched ON in `plugins.json` that was not even
 * discovered is a regression, not a setup step. Readiness (healthcheck paths,
 * python on PATH) is reported per plugin but never fails the gate — that is
 * per-plugin setup, not "the daemon can't find its plugins".
 */
import type { BundledPluginsResolution, BundledPluginsVia } from './paths'
import { readEnabledMap, type LoadedPlugin, type PluginSource } from './registry'

export interface PluginsHealth {
  bundled_dir: string | null
  via: BundledPluginsVia | null
  plugins: Array<{ name: string; source: PluginSource; enabled: boolean; ready: boolean; reason?: string }>
  /** Names explicitly enabled in plugins.json that were not discovered at all. Sorted. */
  expected_missing: string[]
}

export function buildPluginsHealth(input: {
  stateDir: string
  resolution: BundledPluginsResolution | null
  loaded: LoadedPlugin[]
}): PluginsHealth {
  const found = new Set(input.loaded.map(p => p.name))
  const expected_missing = Object.entries(readEnabledMap(input.stateDir))
    .filter(([name, on]) => on && !found.has(name))
    .map(([name]) => name)
    .sort()
  return {
    bundled_dir: input.resolution?.dir ?? null,
    via: input.resolution?.via ?? null,
    plugins: input.loaded.map(p => ({
      name: p.name, source: p.source, enabled: p.enabled, ready: p.ready,
      ...(p.notReadyReason ? { reason: p.notReadyReason } : {}),
    })),
    expected_missing,
  }
}

/** One loud line when the operator's enabled plugins went missing; null when fine. */
export function pluginsHealthWarning(h: PluginsHealth): string | null {
  if (h.expected_missing.length === 0) return null
  const where = h.bundled_dir ? `bundled dir ${h.bundled_dir} (via ${h.via})` : 'no bundled plugins dir found'
  return `WARNING: enabled plugin(s) not found: ${h.expected_missing.join(', ')} — ${where}. ` +
    'Point the daemon at your plugins with `wechat-cc plugin source <dir>` (e.g. <checkout>/plugins) and restart.'
}
