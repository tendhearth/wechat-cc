/**
 * internal-api plugin routes — dashboard list + enable/disable toggle for
 * wechat-cc plugins (MCP tool providers). Read model comes from
 * loadPlugins(); the toggle persists via setPluginEnabled(). Both take effect
 * on the NEXT daemon spawn (provider mcpServers are a boot-time snapshot), so
 * the toggle response says so — the dashboard surfaces a "restart to apply"
 * hint rather than pretending it's live.
 */
import { type InternalApiDeps, type RouteTable } from './types'
import type { PluginToggleRequestT, PluginInstallRequestT } from './schema'
import { loadPlugins, setPluginEnabled } from '../plugins/registry'
import { bundledPluginsDir, pluginDataDir } from '../plugins/paths'
import { fetchCatalog, installPlugin, upgradePlugin, updateAvailable } from '../plugins/catalog'
import selfPkg from '../../../package.json' with { type: 'json' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function syncStatus(stateDir: string, name: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(pluginDataDir(stateDir, name), 'sync-status.json'), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const v = raw as Record<string, unknown>
    return {
      state: typeof v.state === 'string' ? v.state : 'unknown',
      running: v.running === true,
      last_success_at: typeof v.last_success_at === 'string' ? v.last_success_at : null,
      error: typeof v.error === 'string' ? v.error : null,
    }
  } catch { return null }
}

export function pluginRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/plugins/list': () => {
      const loaded = loadPlugins({ stateDir: deps.stateDir, bundledDir: bundledPluginsDir(), hostVersion: selfPkg.version })
      // Deliberately omit spec.env (could carry secrets a plugin declared) —
      // the dashboard only needs identity + state, not the spawn internals.
      // Hidden (infrastructure) plugins still load + run — just excluded
      // from this discovery surface. See hidden-plugins-design.md.
      return { status: 200, body: {
        host_version: selfPkg.version,
        plugins: loaded.filter(p => !p.manifest.hidden).map(p => ({
          name: p.name,
          source: p.source,
          version: p.manifest.version ?? null,
          enabled: p.enabled,
          ready: p.ready,
          not_ready_reason: p.notReadyReason ?? null,
          display_name: p.manifest.displayName ?? p.name,
          description: p.manifest.description ?? null,
          tools: p.manifest.tools ?? [],
          command: p.spec.command,
          has_setup: !!p.manifest.setup,   // GUI shows a "run setup" button when true + not ready
          has_sync: !!p.manifest.sync,
          sync_status: p.manifest.sync ? syncStatus(deps.stateDir, p.name) : null,
        })),
      } }
    },

    'POST /v1/plugins/toggle': (_q, body) => {
      const { name, enabled } = body as PluginToggleRequestT
      setPluginEnabled(deps.stateDir, name, enabled)
      return { status: 200, body: {
        ok: true, name, enabled,
        note: 'restart the daemon to apply (MCP servers are wired at spawn)',
      } }
    },

    // The "market": the curated registry, annotated with what's already
    // installed + whether an update is available. Registry-unavailable is a
    // 200 with an `error` field (not a 500) so the dashboard shows a message.
    'GET /v1/plugins/registry': async () => {
      const loaded = loadPlugins({ stateDir: deps.stateDir, bundledDir: bundledPluginsDir() })
      const installed = new Map(loaded.map(p => [p.name, p.manifest.version]))
      // Hidden (infrastructure) plugins are excluded from the marketplace
      // catalog too — the catalog entry itself carries no `hidden` (it's a
      // remote pointer), so key off the locally loaded manifest by name.
      const hiddenNames = new Set(loaded.filter(p => p.manifest.hidden).map(p => p.name))
      try {
        const catalog = await fetchCatalog()
        return { status: 200, body: {
          host_version: selfPkg.version,
          plugins: catalog.plugins.filter(e => !hiddenNames.has(e.name)).map(e => ({
            name: e.name,
            version: e.version,
            display_name: e.displayName ?? e.name,
            description: e.description ?? null,
            author: e.author ?? null,
            homepage: e.homepage ?? null,
            installed: installed.has(e.name),
            installed_version: installed.get(e.name) ?? null,
            update_available: updateAvailable(installed.get(e.name), e),
          })),
        } }
      } catch (e) {
        return { status: 200, body: { error: e instanceof Error ? e.message : String(e), plugins: [] } }
      }
    },

    // Install from the registry (git clone → user plugins dir, DISABLED).
    'POST /v1/plugins/install': async (_q, body) => {
      const { name } = body as PluginInstallRequestT
      let catalog
      try { catalog = await fetchCatalog() } catch (e) {
        return { status: 200, body: { ok: false, error: `registry unavailable: ${e instanceof Error ? e.message : String(e)}` } }
      }
      const entry = catalog.plugins.find(p => p.name === name)
      if (!entry) return { status: 200, body: { ok: false, error: `"${name}" not in registry` } }
      const r = installPlugin(entry, deps.stateDir)
      return { status: 200, body: r.ok
        ? { ok: true, name, version: entry.version, note: 'installed (disabled). Enable it, finish setup, then restart the daemon.' }
        : { ok: false, error: r.reason } }
    },

    // Upgrade an installed plugin to the registry version (git fetch+checkout,
    // preserving untracked plugin data). Restart-to-apply, like install/toggle.
    'POST /v1/plugins/upgrade': async (_q, body) => {
      const { name } = body as PluginInstallRequestT
      let catalog
      try { catalog = await fetchCatalog() } catch (e) {
        return { status: 200, body: { ok: false, error: `registry unavailable: ${e instanceof Error ? e.message : String(e)}` } }
      }
      const entry = catalog.plugins.find(p => p.name === name)
      if (!entry) return { status: 200, body: { ok: false, error: `"${name}" not in registry` } }
      const r = upgradePlugin(entry, deps.stateDir)
      if (!r.ok) return { status: 200, body: { ok: false, error: r.reason } }
      return { status: 200, body: {
        ok: true, name, upgraded: r.upgraded, from: r.from, to: r.to,
        note: r.upgraded ? 'upgraded — restart the daemon to load it' : 'already up to date',
      } }
    },
  }
}
