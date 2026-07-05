/**
 * internal-api plugin routes — dashboard list + enable/disable toggle for
 * wechat-cc plugins (MCP tool providers like wxvault). Read model comes from
 * loadPlugins(); the toggle persists via setPluginEnabled(). Both take effect
 * on the NEXT daemon spawn (provider mcpServers are a boot-time snapshot), so
 * the toggle response says so — the dashboard surfaces a "restart to apply"
 * hint rather than pretending it's live.
 */
import { type InternalApiDeps, type RouteTable } from './types'
import type { PluginToggleRequestT } from './schema'
import { loadPlugins, setPluginEnabled } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'

export function pluginRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/plugins/list': () => {
      const loaded = loadPlugins({ stateDir: deps.stateDir, bundledDir: bundledPluginsDir() })
      // Deliberately omit spec.env (could carry secrets a plugin declared) —
      // the dashboard only needs identity + state, not the spawn internals.
      return { status: 200, body: {
        plugins: loaded.map(p => ({
          name: p.name,
          source: p.source,
          enabled: p.enabled,
          ready: p.ready,
          not_ready_reason: p.notReadyReason ?? null,
          display_name: p.manifest.displayName ?? p.name,
          description: p.manifest.description ?? null,
          tools: p.manifest.tools ?? [],
          command: p.spec.command,
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
  }
}
