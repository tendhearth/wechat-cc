/**
 * Plugin registry — discovers plugins, decides which are enabled, and produces
 * the `Record<name, McpStdioSpec>` that bootstrap merges into every provider's
 * mcpServers (alongside the core `wechat` + `delegate` children).
 *
 * Trust model (see paths.ts): BUNDLED plugins default ENABLED, USER plugins
 * default DISABLED — discovery is not consent, because a manifest tells the
 * daemon to spawn a process. `plugins.json` records explicit operator choices.
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import type { McpStdioSpec } from '../bootstrap/mcp-specs'
import { MANIFEST_FILE, pluginsConfigPath } from './paths'
import { parseManifest, type PluginManifest } from './manifest'

export type PluginSource = 'bundled' | 'user'

export interface LoadedPlugin {
  name: string
  source: PluginSource
  dir: string
  manifest: PluginManifest
  enabled: boolean
  /** Healthcheck passed (or no healthcheck declared). Only ready plugins run. */
  ready: boolean
  /** Human explanation when ready === false (missing setup paths). */
  notReadyReason?: string
  /** Resolved stdio spec (templates expanded); only run when enabled && ready. */
  spec: McpStdioSpec
}

export interface LoadPluginsDeps {
  /** Per-user state home (`~/.claude/channels/wechat` by default). */
  stateDir: string
  /** First-party plugins dir; null in compiled bundles (nothing on disk). */
  bundledDir?: string | null
  /** Diagnostic sink; receives one line per skipped/loaded plugin. */
  log?: (msg: string) => void
}

interface EnabledConfig {
  enabled: Record<string, boolean>
}

function readEnabledMap(stateDir: string): Record<string, boolean> {
  const p = pluginsConfigPath(stateDir)
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && 'enabled' in parsed) {
      const e = (parsed as EnabledConfig).enabled
      if (e && typeof e === 'object') {
        const out: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(e)) if (typeof v === 'boolean') out[k] = v
        return out
      }
    }
  } catch { /* malformed config → treat as no explicit choices */ }
  return {}
}

const expandDir = (pluginDir: string) => (s: string): string =>
  s.split('${pluginDir}').join(pluginDir)

/**
 * Resolve a command to an absolute path against the DAEMON's PATH at load time.
 * MCP children are not guaranteed the daemon's PATH — the core wechat/delegate
 * specs sidestep this by always spawning an absolute `process.execPath`, so a
 * bare `python3` could ENOENT under launchd's minimal env. Resolving here makes
 * the spawned command absolute regardless of the child's env; null means "not
 * found" so the plugin is marked not-ready with an actionable reason instead of
 * failing silently at spawn. A command containing a slash (absolute, or a
 * `${pluginDir}/venv/bin/python` bundled interpreter) is used verbatim if it
 * exists on disk.
 */
function resolveCommand(command: string): string | null {
  if (command.includes('/') || command.includes(sep)) return existsSync(command) ? command : null
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d) continue
    const p = join(d, command)
    try { if (statSync(p).isFile()) return p } catch { /* not on this PATH entry */ }
    // NOTE: Windows PATHEXT (.exe/.cmd suffix search) not handled — a bare
    // Windows command should ship an explicit extension or absolute path.
  }
  return null
}

/**
 * Persist an explicit enable/disable choice into `plugins.json` (the dashboard
 * toggle + `wechat-cc plugin enable/disable` both land here). Atomic write.
 */
export function setPluginEnabled(stateDir: string, name: string, enabled: boolean): void {
  const p = pluginsConfigPath(stateDir)
  const map = readEnabledMap(stateDir)
  map[name] = enabled
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ enabled: map }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

/** Expand `${pluginDir}` in command/argv/env into a concrete stdio spec. */
function resolveSpec(manifest: PluginManifest, pluginDir: string): McpStdioSpec {
  const sub = expandDir(pluginDir)
  return {
    command: sub(manifest.spawn.command),
    args: (manifest.spawn.args ?? []).map(sub),
    env: Object.fromEntries(
      Object.entries(manifest.spawn.env ?? {}).map(([k, v]) => [k, sub(v)]),
    ),
  }
}

/**
 * Readiness = command resolves to an absolute path AND every `requiresPaths`
 * entry exists. `spec.command` is rewritten to the resolved absolute path.
 * Both failures return an actionable reason (with the `requires.setup` hint).
 */
function checkReady(manifest: PluginManifest, spec: McpStdioSpec, pluginDir: string): { ready: true } | { ready: false; reason: string } {
  const hint = manifest.requires?.setup ? ` — ${manifest.requires.setup}` : ''
  const abs = resolveCommand(spec.command)
  if (!abs) return { ready: false, reason: `command "${spec.command}" not found on PATH${hint}` }
  spec.command = abs
  const sub = expandDir(pluginDir)
  const missing = (manifest.healthcheck?.requiresPaths ?? []).map(sub).filter(p => !existsSync(p))
  if (missing.length > 0) return { ready: false, reason: `missing ${missing.join(', ')}${hint}` }
  return { ready: true }
}

/** One discovery root → parsed manifests (invalid ones logged + skipped). */
function scanDir(dir: string, source: PluginSource, log?: (m: string) => void): Array<{ name: string; dir: string; manifest: PluginManifest }> {
  if (!dir || !existsSync(dir)) return []
  const out: Array<{ name: string; dir: string; manifest: PluginManifest }> = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  for (const entry of entries) {
    const pluginDir = join(dir, entry)
    let isDir: boolean
    try { isDir = statSync(pluginDir).isDirectory() } catch { continue }
    if (!isDir) continue
    const manifestPath = join(pluginDir, MANIFEST_FILE)
    if (!existsSync(manifestPath)) continue
    let raw: unknown
    try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) {
      log?.(`skip ${source}/${entry}: unreadable ${MANIFEST_FILE} (${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    const res = parseManifest(raw)
    if (!res.ok) { log?.(`skip ${source}/${entry}: ${res.reason}`); continue }
    out.push({ name: res.manifest.name, dir: pluginDir, manifest: res.manifest })
  }
  return out
}

/**
 * Discover + resolve plugins from both roots. USER entries override BUNDLED of
 * the same name (local install wins). Enable-state: explicit config value if
 * present, else default-by-source (bundled on, user off).
 */
export function loadPlugins(deps: LoadPluginsDeps): LoadedPlugin[] {
  const log = deps.log
  const enabledMap = readEnabledMap(deps.stateDir)

  // bundled first, then user — user overwrites same-name key in the map.
  const bundled = scanDir(deps.bundledDir ?? '', 'bundled', log)
  const user = scanDir(join(deps.stateDir, 'plugins'), 'user', log)
  const byName = new Map<string, { name: string; dir: string; manifest: PluginManifest; source: PluginSource }>()
  for (const b of bundled) {
    if (byName.has(b.name)) log?.(`duplicate bundled plugin name "${b.name}" — "${b.dir}" shadows earlier one`)
    byName.set(b.name, { ...b, source: 'bundled' })
  }
  for (const u of user) {
    const prev = byName.get(u.name)
    if (prev) log?.(prev.source === 'user'
      ? `duplicate user plugin name "${u.name}" — "${u.dir}" shadows "${prev.dir}"`
      : `user plugin "${u.name}" overrides bundled one`)
    byName.set(u.name, { ...u, source: 'user' })
  }

  const loaded: LoadedPlugin[] = []
  for (const p of byName.values()) {
    const def = p.source === 'bundled'          // default enable-state by trust
    const enabled = p.name in enabledMap ? enabledMap[p.name]! : def
    const spec = resolveSpec(p.manifest, p.dir)
    const health = checkReady(p.manifest, spec, p.dir)   // may rewrite spec.command → absolute
    loaded.push({
      name: p.name,
      source: p.source,
      dir: p.dir,
      manifest: p.manifest,
      enabled,
      ready: health.ready,
      ...(health.ready ? {} : { notReadyReason: health.reason }),
      spec,
    })
    if (!enabled) log?.(`${p.source} plugin "${p.name}" disabled (enable in dashboard / plugins.json)`)
    else if (!health.ready) log?.(`plugin "${p.name}" enabled but NOT READY — withheld from agent: ${health.reason}`)
    else log?.(`${p.source} plugin "${p.name}" enabled + ready`)
  }
  return loaded
}

/** MCP specs for plugins that are enabled AND ready — safe to hand the agent. */
export function pluginMcpSpecs(loaded: LoadedPlugin[]): Record<string, McpStdioSpec> {
  const out: Record<string, McpStdioSpec> = {}
  for (const p of loaded) if (p.enabled && p.ready && p.manifest.kind === 'mcp') out[p.name] = p.spec
  return out
}
