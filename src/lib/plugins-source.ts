/**
 * plugins-source — the owner's first-party plugins location, shared by the
 * daemon (src/daemon/plugins/paths.ts re-exports it) and `self deploy` (cli).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from './read-json-file'
import { isCompiledBundle } from './runtime-info'

export const MANIFEST_FILE = 'wechat-cc.plugin.json'

/**
 * Where the owner's first-party plugins live when they are NOT inside the
 * running binary's own tree: `{stateDir}/plugins/bundled-source.json` =
 * `{ "dir": "/abs/path/to/plugins", "plugins": ["wxvault", …] }` — `plugins` is
 * what the dir held when it was registered (folder names), so health can tell
 * "this one vanished" apart from "never had it" (bundled plugins are
 * default-on and never appear in plugins.json). Written by `wechat-cc plugin source <dir>`
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

export interface PluginsSourceRecord { dir: string; plugins: string[] }

export function readPluginsSourceRecord(stateDir: string): PluginsSourceRecord | null {
  try {
    const parsed = readJsonFile(pluginsSourcePointerPath(stateDir)) as { dir?: unknown; plugins?: unknown } | null
    const dir = parsed && typeof parsed === 'object' ? parsed.dir : undefined
    if (typeof dir !== 'string' || !dir) return null
    const plugins = Array.isArray(parsed!.plugins) ? parsed!.plugins.filter((x): x is string => typeof x === 'string') : []
    return { dir, plugins }
  } catch { return null }
}

export function readPluginsSourcePointer(stateDir: string): string | null {
  return readPluginsSourceRecord(stateDir)?.dir ?? null
}

/** Persist the pointer; `plugins` defaults to what `dir` holds right now. */
export function writePluginsSourcePointer(stateDir: string, dir: string, plugins: string[] = pluginNamesIn(dir)): void {
  const p = pluginsSourcePointerPath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ dir, plugins }, null, 2) + '\n', { mode: 0o600 })
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
  writePluginsSourcePointer(stateDir, abs, plugins)
  return { ok: true, dir: abs, plugins }
}

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
    sourceRepoRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..'), // src/lib → repo
  })
}

