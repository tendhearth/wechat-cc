/**
 * Plugin catalog (the "market") — a static JSON registry you curate, hosted in
 * a git repo (Obsidian community-plugins.json / Homebrew tap style). The index
 * only holds POINTERS: each entry names a git source; the plugin's actual files
 * live in its own repo, versioned by tags. `plugin search/install` and the
 * dashboard market read this.
 *
 * Trust unchanged: installing clones third-party code, so a freshly installed
 * plugin lands DISABLED (the registry loader's default for user-dir plugins).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVersion } from './registry'
import { userPluginsDir } from './paths'

export interface CatalogEntry {
  name: string
  version: string
  source: { type: 'git'; url: string; ref?: string }
  displayName?: string
  description?: string
  author?: string
  homepage?: string
  minWechatCcVersion?: string
}
export interface Catalog { plugins: CatalogEntry[] }

/** Placeholder — replace with your real curated registry repo (or set the env var). */
export const PLACEHOLDER_REGISTRY_URL =
  'https://raw.githubusercontent.com/YOUR-ORG/wechat-cc-plugins/main/registry.json'

/**
 * Resolve the registry URL at call time (not module load) so WECHAT_CC_PLUGIN_REGISTRY
 * — an https URL or a local file path, handy for a private/test registry — is
 * honored without a restart.
 */
export function registryUrl(): string {
  return process.env.WECHAT_CC_PLUGIN_REGISTRY || PLACEHOLDER_REGISTRY_URL
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Validate an untrusted registry document. Rejects the whole thing on any bad entry. */
export function parseCatalog(raw: unknown): { ok: true; catalog: Catalog } | { ok: false; reason: string } {
  if (!isObject(raw) || !Array.isArray(raw.plugins)) {
    return { ok: false, reason: 'registry must be an object with a "plugins" array' }
  }
  const plugins: CatalogEntry[] = []
  for (const e of raw.plugins) {
    if (!isObject(e)) return { ok: false, reason: 'each plugin entry must be an object' }
    const { name, version, source } = e
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, reason: `bad entry name ${JSON.stringify(name)}` }
    if (typeof version !== 'string' || !version) return { ok: false, reason: `"${name}": version required` }
    if (!isObject(source) || source.type !== 'git' || typeof source.url !== 'string') {
      return { ok: false, reason: `"${name}": source must be { type:"git", url }` }
    }
    if (source.ref !== undefined && typeof source.ref !== 'string') return { ok: false, reason: `"${name}": source.ref must be a string` }
    plugins.push({
      name, version,
      source: { type: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}) },
      ...(typeof e.displayName === 'string' ? { displayName: e.displayName } : {}),
      ...(typeof e.description === 'string' ? { description: e.description } : {}),
      ...(typeof e.author === 'string' ? { author: e.author } : {}),
      ...(typeof e.homepage === 'string' ? { homepage: e.homepage } : {}),
      ...(typeof e.minWechatCcVersion === 'string' ? { minWechatCcVersion: e.minWechatCcVersion } : {}),
    })
  }
  return { ok: true, catalog: { plugins } }
}

/** Fetch + parse the catalog. `url` may be an http(s) URL or a local file path. */
export async function fetchCatalog(url = registryUrl()): Promise<Catalog> {
  let text: string
  if (/^https?:\/\//.test(url)) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`registry fetch failed: HTTP ${resp.status} ${url}`)
    text = await resp.text()
  } else {
    text = readFileSync(url.replace(/^file:\/\//, ''), 'utf8')
  }
  let json: unknown
  try { json = JSON.parse(text) } catch (e) { throw new Error(`registry is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  const parsed = parseCatalog(json)
  if (!parsed.ok) throw new Error(`registry invalid: ${parsed.reason}`)
  return parsed.catalog
}

/** True when the catalog offers a strictly newer version than what's installed. */
export function updateAvailable(installedVersion: string | undefined, entry: CatalogEntry): boolean {
  if (!installedVersion) return false
  return cmpVersion(entry.version, installedVersion) === 1
}

/**
 * Install a catalog entry: git clone (shallow, at its ref) into the user
 * plugins dir. Refuses if already present (that's an upgrade) or the source
 * isn't an https git URL. Verifies the clone actually contains a plugin
 * manifest. Never enables it — trust gate stays with the operator.
 */
export function installPlugin(entry: CatalogEntry, stateDir: string): { ok: true; dir: string } | { ok: false; reason: string } {
  if (entry.source.type !== 'git' || !entry.source.url.startsWith('https://')) {
    return { ok: false, reason: 'only https git sources are supported' }
  }
  if (!NAME_RE.test(entry.name)) return { ok: false, reason: `unsafe plugin name ${JSON.stringify(entry.name)}` }
  const dir = join(userPluginsDir(stateDir), entry.name)
  if (existsSync(dir)) return { ok: false, reason: `"${entry.name}" already installed — use \`plugin upgrade\`` }
  const args = ['clone', '--depth', '1']
  if (entry.source.ref) args.push('--branch', entry.source.ref)
  args.push('--', entry.source.url, dir)          // -- so a URL can't be read as a flag
  try {
    execFileSync('git', args, { stdio: 'pipe' })
  } catch (e) {
    return { ok: false, reason: `git clone failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
  if (!existsSync(join(dir, 'wechat-cc.plugin.json'))) {
    return { ok: false, reason: 'cloned repo has no wechat-cc.plugin.json — not a plugin' }
  }
  return { ok: true, dir }
}

/** Read the installed plugin's manifest version (or null). */
function installedVersion(dir: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'wechat-cc.plugin.json'), 'utf8'))
    return typeof m?.version === 'string' ? m.version : null
  } catch { return null }
}

export type UpgradeResult =
  | { ok: true; upgraded: boolean; from: string | null; to: string }
  | { ok: false; reason: string }

/**
 * Upgrade an installed plugin to the catalog's version by fetching its ref and
 * checking it out over the existing checkout. Uses `fetch + checkout --force
 * FETCH_HEAD` (NOT re-clone) so tracked code is updated while UNTRACKED data
 * the plugin generated (e.g. wxvault's out/decrypted) is preserved. Only works
 * on registry-installed (git) plugins — a symlinked/manual dir is left to the
 * operator. No-ops (upgraded:false) when already at/above the catalog version.
 */
export function upgradePlugin(entry: CatalogEntry, stateDir: string): UpgradeResult {
  const dir = join(userPluginsDir(stateDir), entry.name)
  if (!existsSync(dir)) return { ok: false, reason: `"${entry.name}" is not installed` }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, reason: 'not a git checkout (installed manually / symlinked) — update it yourself' }
  }
  if (entry.source.type !== 'git' || !entry.source.url.startsWith('https://')) {
    return { ok: false, reason: 'only https git sources are supported' }
  }
  const from = installedVersion(dir)
  if (from && cmpVersion(entry.version, from) !== 1) {
    return { ok: true, upgraded: false, from, to: entry.version }   // already current
  }
  const ref = entry.source.ref ?? 'HEAD'
  try {
    execFileSync('git', ['-C', dir, 'fetch', '--depth', '1', '--', entry.source.url, ref], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'checkout', '--force', 'FETCH_HEAD'], { stdio: 'pipe' })
  } catch (e) {
    return { ok: false, reason: `git upgrade failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
  return { ok: true, upgraded: true, from, to: entry.version }
}
