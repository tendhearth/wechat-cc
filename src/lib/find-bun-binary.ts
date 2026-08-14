/**
 * find-bun-binary — locate the user's bun install for codex-autofix.
 *
 * Why this exists: codex-autofix realigns the bundled codex SDK to the
 * user's CLI version by spawning `bun add`. It spawned a bare `bun` and
 * relied on PATH — but the daemon runs under launchd/systemd with a
 * minimal PATH (`/usr/bin:/bin`), which does not contain `~/.bun/bin`
 * where bun's own installer puts it. Result: every boot logged
 * `bun not found on PATH` and the SDK never realigned. Observed on the
 * maintainer's machine on every boot from 2026-07-17 onward.
 *
 * This is the same failure `find-codex-binary.ts` documents and already
 * works around for the codex binary; the fallback list here mirrors it,
 * with bun's own install locations substituted.
 *
 * Kept deliberately dependency-injectable (exists/readdir/pathEnv/homeDir/
 * platform) so the search order is testable without touching a real disk.
 */

import { existsSync, readdirSync } from 'node:fs'
import { posix as posixPath, win32 as winPath } from 'node:path'
import { homedir } from 'node:os'

export interface FindBunBinaryDeps {
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

export function findBunBinary(deps: FindBunBinaryDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? readdirSync
  const pathEnv = deps.pathEnv ?? (process.env.PATH ?? '')
  const homeDir = deps.homeDir ?? homedir()
  const platform = deps.platform ?? process.platform
  const exe = platform === 'win32' ? 'bun.exe' : 'bun'
  const sep = platform === 'win32' ? ';' : ':'
  // Drive `join` off the `platform` dep, not the host — otherwise a test
  // passing platform:'linux' gets backslash-joined paths on a Windows
  // runner and never matches its forward-slash fixtures (same reasoning
  // as find-codex-binary.ts).
  const platformPath = platform === 'win32' ? winPath : posixPath

  // 1. PATH — canonical, and what an interactive shell or a daemon started
  //    from one will already have. An explicit entry always wins over the
  //    fallbacks below.
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = platformPath.join(dir, exe)
    if (exists(candidate)) return candidate
  }

  // 2. ~/.bun/bin — where bun's official installer (`curl -fsSL bun.sh/install`)
  //    puts it on every platform, Windows included. This is the entry a
  //    minimal service PATH is missing, i.e. the case this module exists for.
  const bunHome = platformPath.join(homeDir, '.bun', 'bin', exe)
  if (exists(bunHome)) return bunHome

  if (platform !== 'win32') {
    // 3. nvm — bun can also arrive via `npm i -g bun`, which lands in the
    //    active node version's bin/. Walk newest-first so the most recently
    //    installed version wins, and tolerate an unreadable dir.
    const nvmRoot = platformPath.join(homeDir, '.nvm', 'versions', 'node')
    if (exists(nvmRoot)) {
      let versions: string[] = []
      try { versions = readdir(nvmRoot).slice().sort().reverse() } catch { /* ignore */ }
      for (const v of versions) {
        const candidate = platformPath.join(nvmRoot, v, 'bin', exe)
        if (exists(candidate)) return candidate
      }
    }

    // 4. Homebrew — `brew install oven-sh/bun/bun`. Both prefixes, since a
    //    launchd service's PATH is not guaranteed to carry either. darwin
    //    only: these paths are not where linuxbrew puts things, and probing
    //    them there would just be noise.
    if (platform === 'darwin') {
      for (const candidate of ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
        if (exists(candidate)) return candidate
      }
    }
  }

  return null
}
