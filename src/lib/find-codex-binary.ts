/**
 * find-codex-binary — locate the user's codex CLI on PATH.
 *
 * Design (post Task #18): pure PATH + nvm lookup. No bundled-shim probes.
 *
 * Why no bundle (re-confirmed 2026-09-09 with two live probes): our bundled
 * SDK 0.144.4 drove the user's CLI 0.153.4 fine (9 minors apart), while the
 * SDK's OWN bundled 0.144.4 binary was rejected by OpenAI's server with
 * "The 'gpt-6-astra' model requires a newer version of Codex". The server
 * gates new models by CLI version, so the user's newer CLI is the only one
 * that can run new models — a bundled binary would be a floor that only
 * reaches old models. Codex auth lives in `~/.codex/auth.json` regardless of
 * which binary spawns it. Version mismatch is therefore ADVISORY (logged,
 * shown in /mode), not a refusal; compatibility is settled by a real
 * first-use probe (src/core/first-use-probe.ts), and codex-autofix
 * (src/lib/codex-autofix.ts) still realigns the SDK in dev checkouts.
 *
 * If the user has never installed codex globally, this returns null and
 * the daemon refuses to register the codex provider with a clear error
 * pointing the user at `npm i -g @openai/codex@<X> && codex login`.
 *
 * The nvm fallback exists because `systemctl --user` services don't
 * source ~/.bashrc / ~/.zshrc — so NVM's PATH entries (which install
 * codex into the active node version's bin/) are missing from the
 * launched daemon's PATH. The fallback walks ~/.nvm/versions/node
 * newest-first.
 */

import { existsSync, readdirSync } from 'node:fs'
import { posix as posixPath, win32 as winPath } from 'node:path'
import { homedir } from 'node:os'

export interface FindCodexBinaryDeps {
  /** Defaults to `existsSync`. */
  exists?: (p: string) => boolean
  /** Defaults to `readdirSync`. Used only for nvm directory enumeration. */
  readdir?: (p: string) => string[]
  /** Defaults to `process.env.PATH ?? ''`. */
  pathEnv?: string
  /** Defaults to `os.homedir()`. */
  homeDir?: string
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

export function findCodexBinary(deps: FindCodexBinaryDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? readdirSync
  const pathEnv = deps.pathEnv ?? (process.env.PATH ?? '')
  const homeDir = deps.homeDir ?? homedir()
  const platform = deps.platform ?? process.platform
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  const sep = platform === 'win32' ? ';' : ':'
  // Drive `join` off the `platform` dep, not the host. Otherwise tests
  // that pass platform: 'linux' still get backslash-joined paths on a
  // Windows runner and never match their forward-slash fixtures.
  const platformPath = platform === 'win32' ? winPath : posixPath

  // 1. PATH lookup — the canonical place. Covers system-wide installs
  // (/usr/local/bin, /usr/bin, ~/.local/bin for npm-prefix-set-to-home),
  // and any shell that has nvm sourced before launching the daemon.
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = platformPath.join(dir, exe)
    if (exists(candidate)) return candidate
  }

  // 2. nvm fallback — `systemctl --user` services don't source
  // ~/.bashrc / ~/.zshrc, so NVM's PATH entries (which install codex
  // into the active node version's bin/) are missing. Walk
  // ~/.nvm/versions/node newest-first so the most recently installed
  // version wins. This covers 90% of users running codex from npm.
  if (platform !== 'win32') {
    const nvmRoot = platformPath.join(homeDir, '.nvm', 'versions', 'node')
    if (exists(nvmRoot)) {
      let versions: string[] = []
      try { versions = readdir(nvmRoot).slice().sort().reverse() } catch { /* ignore */ }
      for (const v of versions) {
        const candidate = platformPath.join(nvmRoot, v, 'bin', exe)
        if (exists(candidate)) return candidate
      }
    }
  }

  // 3. Service-PATH fallbacks (same rationale as nvm: a launchd/systemd daemon
  //    runs with a minimal PATH — e.g. /usr/bin:/bin — that omits the per-user
  //    bin, and codex's standalone installer lives outside PATH/nvm entirely).
  //    - ~/.local/bin: the npm-prefix-to-home target + where the standalone
  //      installer symlinks `codex`. On PATH in an interactive shell, absent
  //      from a launchd service's PATH.
  //    - ~/.codex/packages/standalone/current/bin: the standalone installer's
  //      real binary (current → the active version).
  if (platform !== 'win32') {
    const fallbacks = [
      platformPath.join(homeDir, '.local', 'bin', exe),
      platformPath.join(homeDir, '.codex', 'packages', 'standalone', 'current', 'bin', exe),
    ]
    // Homebrew is the default installer on modern macOS. launchd starts with
    // a minimal PATH, so neither Homebrew prefix is guaranteed to be present.
    // Keep these as service-only fallbacks: an explicit PATH entry still wins.
    if (platform === 'darwin') {
      fallbacks.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex')
    }
    for (const candidate of fallbacks) {
      if (exists(candidate)) return candidate
    }
  }

  return null
}
