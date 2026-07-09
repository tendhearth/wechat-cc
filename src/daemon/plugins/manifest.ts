/**
 * Plugin manifest — the ONLY thing wechat-cc reads from a plugin. It never
 * imports plugin code; it spawns the declared process and speaks MCP to it
 * over stdio. That process boundary is the whole decoupling: a plugin can be
 * any language (e.g. Python, while the daemon is Bun), coupled only by the
 * MCP wire protocol + this schema.
 *
 * Today only `kind: "mcp"` (a passive tool provider → `mcp__<name>__*` tools).
 * Autonomous agent plugins will reuse this manifest with `kind: "a2a"` on a
 * separate lane — one plugin concept, two contracts.
 */
export interface PluginSpawn {
  /** Executable, e.g. "python3" or "node". Resolved via the daemon's PATH. */
  command: string
  /** Argv. `${pluginDir}` expands to the manifest's directory (absolute). */
  args?: string[]
  /** Extra env for the child. Values also get `${pluginDir}` expansion. */
  env?: Record<string, string>
}

export interface PluginHealthcheck {
  /**
   * Paths that must ALL exist for the plugin to be "ready". `${pluginDir}`
   * expands. Declarative (no command exec) on purpose — a not-ready plugin is
   * discovered + toggleable but withheld from the agent, so a broken tool is
   * never handed over (e.g. a plugin before its setup step has produced
   * `out/decrypted`).
   */
  requiresPaths?: string[]
}

export interface PluginManifest {
  /** Unique, becomes the MCP server key → tools appear as `mcp__<name>__*`. */
  name: string
  kind: 'mcp'
  /** Semver of the plugin. Compared against the registry to detect updates. */
  version?: string
  /**
   * Minimum wechat-cc (host) version this plugin supports, semver. If the
   * running host is older, the plugin is withheld as not-ready — same idea as
   * VS Code `engines.vscode` / Obsidian `minAppVersion`.
   */
  minWechatCcVersion?: string
  displayName?: string
  description?: string
  spawn: PluginSpawn
  /**
   * Optional runnable one-time setup (e.g. decrypt WeChat). `wechat-cc plugin
   * setup <name>` — and the desktop「连接微信」button — run this and stream its
   * output. Distinct from the free-form `requires.setup` hint string.
   */
  setup?: PluginSpawn
  /** Readiness gate — see PluginHealthcheck. */
  healthcheck?: PluginHealthcheck
  /** Free-form host/setup hints shown to the operator (not enforced). */
  requires?: Record<string, string>
  /** Advertised tool names (documentation only; MCP is the source of truth). */
  tools?: string[]
}

/** Names the daemon owns — a plugin may not shadow the core MCP children. */
export const RESERVED_NAMES = new Set(['wechat', 'delegate'])

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export type ParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every(x => typeof x === 'string')
}

/** Validate a spawn spec ({command, args?, env?}) → normalized PluginSpawn or null. */
function parseSpawn(v: unknown): PluginSpawn | null {
  if (!isObject(v) || typeof v.command !== 'string' || !v.command) return null
  if (v.args !== undefined && !isStringArray(v.args)) return null
  if (v.env !== undefined && !isStringRecord(v.env)) return null
  return { command: v.command, ...(v.args ? { args: v.args } : {}), ...(v.env ? { env: v.env } : {}) }
}

/** Validate an untrusted parsed manifest. Rejects with a human reason. */
export function parseManifest(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, reason: 'manifest is not a JSON object' }

  const { name, kind, spawn } = raw
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, reason: `invalid name ${JSON.stringify(name)} (want ^[A-Za-z0-9][A-Za-z0-9_-]*$)` }
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, reason: `name "${name}" is reserved by the daemon` }
  }
  if (kind !== 'mcp') {
    return { ok: false, reason: `unsupported kind ${JSON.stringify(kind)} (only "mcp" today)` }
  }
  if (!isObject(spawn) || typeof spawn.command !== 'string' || !spawn.command) {
    return { ok: false, reason: 'spawn.command missing or not a non-empty string' }
  }
  if (spawn.args !== undefined && !isStringArray(spawn.args)) {
    return { ok: false, reason: 'spawn.args must be an array of strings' }
  }
  if (spawn.env !== undefined && !isStringRecord(spawn.env)) {
    return { ok: false, reason: 'spawn.env must be a string→string map' }
  }
  if (raw.requires !== undefined && !isStringRecord(raw.requires)) {
    return { ok: false, reason: 'requires must be a string→string map' }
  }
  if (raw.tools !== undefined && !isStringArray(raw.tools)) {
    return { ok: false, reason: 'tools must be an array of strings' }
  }
  if (raw.healthcheck !== undefined) {
    if (!isObject(raw.healthcheck)) return { ok: false, reason: 'healthcheck must be an object' }
    if (raw.healthcheck.requiresPaths !== undefined && !isStringArray(raw.healthcheck.requiresPaths)) {
      return { ok: false, reason: 'healthcheck.requiresPaths must be an array of strings' }
    }
  }
  if (raw.version !== undefined && typeof raw.version !== 'string') {
    return { ok: false, reason: 'version must be a semver string' }
  }
  if (raw.minWechatCcVersion !== undefined && typeof raw.minWechatCcVersion !== 'string') {
    return { ok: false, reason: 'minWechatCcVersion must be a semver string' }
  }
  if (raw.setup !== undefined && parseSpawn(raw.setup) === null) {
    return { ok: false, reason: 'setup must be a spawn spec { command, args?, env? }' }
  }

  const setupSpawn = parseSpawn(raw.setup)
  const manifest: PluginManifest = {
    name,
    kind: 'mcp',
    spawn: {
      command: spawn.command,
      ...(spawn.args ? { args: spawn.args } : {}),
      ...(spawn.env ? { env: spawn.env } : {}),
    },
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(typeof raw.minWechatCcVersion === 'string' ? { minWechatCcVersion: raw.minWechatCcVersion } : {}),
    ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(isObject(raw.healthcheck) && isStringArray(raw.healthcheck.requiresPaths)
      ? { healthcheck: { requiresPaths: raw.healthcheck.requiresPaths } }
      : {}),
    ...(setupSpawn ? { setup: setupSpawn } : {}),
    ...(isStringRecord(raw.requires) ? { requires: raw.requires } : {}),
    ...(isStringArray(raw.tools) ? { tools: raw.tools } : {}),
  }
  return { ok: true, manifest }
}
