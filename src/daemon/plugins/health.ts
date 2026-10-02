/**
 * Plugin health snapshot — what the daemon actually loaded at boot, exposed as
 * `GET /v1/health.plugins` and checked by `self deploy`'s gate.
 *
 * WHY (2026-09-30): from 2026-09-11 the packaged daemon loaded ZERO plugins
 * (no bundled dir found) and nothing said so — the only trace was customer
 * review logging "disabled".
 *
 * "Expected" = names recorded when the plugins source was registered
 * (bundled-source.json) ∪ names explicitly ON in plugins.json − names
 * explicitly OFF. The registered names matter most: bundled plugins are
 * default-on, so wxvault never appears in plugins.json and an
 * explicit-enables-only rule stayed green when it vanished (review, fix
 * round 1). A registered pointer that no longer resolves to any real plugin is
 * its own red flag (`pointer_broken`), even if names happen to turn up
 * elsewhere. Readiness (healthcheck paths, python on PATH) is reported per
 * plugin but never fails the gate — that is per-plugin setup.
 *
 * Names: registered ones are folder names, loaded ones manifest names; first-
 * party plugins keep the two equal.
 */
import { dirHasPlugins, readPluginsSourceRecord } from '../../lib/plugins-source'
import type { BundledPluginsResolution, BundledPluginsVia } from './paths'
import { readEnabledMap, type LoadedPlugin, type PluginSource } from './registry'

export interface PluginsHealth {
  bundled_dir: string | null
  via: BundledPluginsVia | null
  plugins: Array<{ name: string; source: PluginSource; enabled: boolean; ready: boolean; reason?: string }>
  /** Expected (see header) but not discovered at all. Sorted. */
  expected_missing: string[]
  /** Registered source dir (bundled-source.json), or null when none registered. */
  pointer_dir: string | null
  /** A source is registered but holds no real plugin any more. */
  pointer_broken: boolean
}

/** Wire shape of `GET /v1/health.plugins`. Detail fields only for admin callers. */
export interface PluginsHealthWire {
  via: BundledPluginsVia | null
  count: number
  ready_count: number
  expected_missing: string[]
  pointer_broken: boolean
  bundled_dir?: string | null
  pointer_dir?: string | null
  plugins?: PluginsHealth['plugins']
}

export function buildPluginsHealth(input: {
  stateDir: string
  resolution: BundledPluginsResolution | null
  loaded: LoadedPlugin[]
}): PluginsHealth {
  const found = new Set(input.loaded.map(p => p.name))
  const choices = readEnabledMap(input.stateDir)
  const record = readPluginsSourceRecord(input.stateDir)
  const expected = new Set([...(record?.plugins ?? []), ...Object.keys(choices).filter(k => choices[k] === true)])
  for (const [k, on] of Object.entries(choices)) if (on === false) expected.delete(k)
  return {
    bundled_dir: input.resolution?.dir ?? null,
    via: input.resolution?.via ?? null,
    plugins: input.loaded.map(p => ({
      name: p.name, source: p.source, enabled: p.enabled, ready: p.ready,
      ...(p.notReadyReason ? { reason: p.notReadyReason } : {}),
    })),
    expected_missing: [...expected].filter(n => !found.has(n)).sort(),
    pointer_dir: record?.dir ?? null,
    pointer_broken: record !== null && !dirHasPlugins(record.dir),
  }
}

/**
 * /v1/health is guest tier: below admin, only counts + the missing names
 * (what the deploy gate needs) — no absolute paths, no not-ready reasons
 * (those embed paths too).
 */
export function pluginsHealthForTier(h: PluginsHealth, admin: boolean): PluginsHealthWire {
  const summary: PluginsHealthWire = {
    via: h.via,
    count: h.plugins.length,
    ready_count: h.plugins.filter(p => p.enabled && p.ready).length,
    expected_missing: h.expected_missing,
    pointer_broken: h.pointer_broken,
  }
  return admin ? { ...summary, bundled_dir: h.bundled_dir, pointer_dir: h.pointer_dir, plugins: h.plugins } : summary
}

/** One loud line when expected plugins went missing or the registered source broke; null when fine. */
export function pluginsHealthWarning(h: PluginsHealth): string | null {
  const parts: string[] = []
  if (h.pointer_broken) parts.push(`registered plugins source ${h.pointer_dir} holds no plugins any more`)
  if (h.expected_missing.length > 0) {
    const where = h.bundled_dir ? `bundled dir ${h.bundled_dir} (via ${h.via})` : 'no bundled plugins dir found'
    parts.push(`expected plugin(s) not found: ${h.expected_missing.join(', ')} — ${where}`)
  }
  if (parts.length === 0) return null
  return `WARNING: ${parts.join('; ')}. Point the daemon at your plugins with \`wechat-cc plugin source <dir>\` (e.g. <checkout>/plugins) and restart.`
}
