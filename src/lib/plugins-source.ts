/**
 * plugins-source — the owner's first-party plugins location, shared by the
 * daemon (src/daemon/plugins/paths.ts re-exports it) and `self deploy` (cli).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const MANIFEST_FILE = 'wechat-cc.plugin.json'

/**
 * Where the owner's first-party plugins live when they are NOT inside the
 * running binary's own tree: `{stateDir}/plugins/bundled-source.json` =
 * `{ "dir": "/abs/path/to/plugins" }`. Written by `wechat-cc plugin source <dir>`
 * and by `self deploy` (which knows the source checkout). Lives in the state
 * dir, so swapping the sidecar or rebuilding the .app never loses it.
 *
 * WHY it exists (2026-09-30): first-party plugins are deliberately NOT shipped
 * inside the desktop installer (1747de09 — the `plugins/` glob once swept a
 * resolved wxvault symlink with 105MB of decrypted private WeChat data into an
 * installer; the decryption code is also legally sensitive). So a packaged
 * daemon has nothing to find next to itself, and from 2026-09-11 — when the
 * LaunchAgent moved from `bun cli.ts` in the main checkout to the .app — it
 * silently ran with zero plugins.
 */
export function pluginsSourcePointerPath(stateDir: string): string {
  return join(stateDir, 'plugins', 'bundled-source.json')
}

export function readPluginsSourcePointer(stateDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pluginsSourcePointerPath(stateDir), 'utf8')) as unknown
    const dir = parsed && typeof parsed === 'object' ? (parsed as { dir?: unknown }).dir : undefined
    return typeof dir === 'string' && dir ? dir : null
  } catch { return null }
}

export function writePluginsSourcePointer(stateDir: string, dir: string): void {
  const p = pluginsSourcePointerPath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ dir }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

/**
 * True when `dir` holds at least one `<name>/wechat-cc.plugin.json` (symlinked
 * plugin dirs count — that is how the owner's checkout wires them). A dir with
 * only the README (what the installer ships) is NOT a plugins dir: treating it
 * as one is exactly what hid the other candidates in the 09-11 regression.
 */
export function dirHasPlugins(dir: string): boolean {
  return pluginNamesIn(dir).length > 0
}


/** Names of the plugin subdirs in `dir` (those with a manifest), sorted. */
export function pluginNamesIn(dir: string): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  return entries.filter(e => {
    try { return statSync(join(dir, e)).isDirectory() && existsSync(join(dir, e, MANIFEST_FILE)) } catch { return false }
  }).sort()
}

/** `wechat-cc plugin source <dir>`: validate (must hold plugins) then persist as an absolute path. */
export function registerPluginsSource(stateDir: string, dir: string): { ok: true; dir: string; plugins: string[] } | { ok: false; error: string } {
  const abs = resolve(dir)
  const plugins = pluginNamesIn(abs)
  if (plugins.length === 0) return { ok: false, error: `no plugins in ${abs} (expected <name>/${MANIFEST_FILE} subdirs)` }
  writePluginsSourcePointer(stateDir, abs)
  return { ok: true, dir: abs, plugins }
}
