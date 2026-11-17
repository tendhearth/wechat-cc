/**
 * util.ts — shared helpers used by both cli.ts and docs.ts.
 *
 * Keep this file small and dependency-free. It's imported by multiple
 * entry points and should not pull in MCP, ilink, or any heavy module.
 */

import { spawnSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter } from 'node:path'
import { homedir, platform } from 'os'
import { join, win32 as winPath, posix as posixPath } from 'node:path'

/**
 * Cross-platform PATH lookup: uses `where` on Windows, `which` elsewhere.
 * Returns the first matching absolute path, or null. `where` on Windows
 * may print multiple matches on separate lines; we take the first.
 *
 * Falls back to scanning a list of common per-user binary roots when
 * `which/where` returns nothing. This matters when the wechat-cc-cli
 * sidecar is spawned from a desktop GUI (Tauri, .desktop launcher, etc.)
 * — the PATH inherited from the GUI session is typically only
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, missing
 * `~/.bun/bin`, `~/.cargo/bin`, `~/.nvm/versions/node/<v>/bin`, and the
 * homebrew prefix on macOS. So `bun` and `codex` appear "missing" in the
 * doctor output even though they're a re-login away in the user's shell.
 */
export function findOnPath(cmd: string): string | null {
  if (!cmd) return null
  const finder = platform() === 'win32' ? 'where' : 'which'
  try {
    // windowsHide: doctor calls findOnPath × 4-5 every 5s (bun, git, claude,
    // codex, wsl) — without this flag and with a subsystem=2 daemon parent,
    // each call flashes a console window. See docs/releases/2026-05-05-v0.5.4.md.
    const r = spawnSync(finder, [cmd], { stdio: 'pipe', windowsHide: true })
    if (r.status === 0) {
      const out = r.stdout?.toString() ?? ''
      const first = out.split(/\r?\n/)[0]?.trim()
      if (first) return first
    }
  } catch {}
  // Fallback: scan common per-user binary roots that desktop GUI sessions
  // tend not to inherit. Keep this list short and deterministic — we want
  // a fast no-op when the binary genuinely isn't installed, not a
  // filesystem walk into ~/.
  return findInUserBinaryRoots(cmd)
}

function findInUserBinaryRoots(cmd: string): string | null {
  const home = homedir(), windows = platform() === 'win32'
  const paths = windows ? winPath : posixPath
  const names = windows ? [`${cmd}.exe`, `${cmd}.cmd`] : [cmd]
  for (const root of [...userBinaryRoots(home), ...nvmBinaryRoots(home)]) {
    for (const name of names) {
      const candidate = paths.join(root, name)
      if (safeExecutable(candidate)) return candidate
    }
  }
  return null
}

function userBinaryRoots(home = homedir()): string[] {
  const windows = platform() === 'win32', paths = windows ? winPath : posixPath
  const roots: string[] = [
    paths.join(home, '.bun', 'bin'), paths.join(home, '.local', 'bin'),
    paths.join(home, '.grok', 'bin'), paths.join(home, '.cargo', 'bin'),
    paths.join(home, '.deno', 'bin'), paths.join(home, '.nami', 'bin'),
    paths.join(home, '.local', 'share', 'pnpm'), paths.join(home, 'go', 'bin'),
    paths.join(home, 'miniconda3', 'bin'),
  ]
  if (windows) {
    const local = process.env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local')
    roots.push(paths.join(local, 'cursor-agent'), paths.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'))
  } else if (platform() === 'darwin') roots.push('/opt/homebrew/bin', '/usr/local/bin')
  return roots
}

export function augmentedPathEnv(): string {
  const home = homedir()
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const seen = new Set(parts)
  for (const root of [...userBinaryRoots(home), ...nvmBinaryRoots(home)]) {
    if (!seen.has(root)) {
      seen.add(root)
      parts.push(root)
    }
  }
  return parts.join(delimiter)
}

function nvmBinaryRoots(home = homedir()): string[] {
  const roots: string[] = []
  // nvm fan-out: ~/.nvm/versions/node/<version>/bin/<cmd>. nvm doesn't
  // symlink to a stable path, so we scan the versions dir and prefer the
  // most-recent (lexicographically last — nvm versions are all v-prefixed
  // semver-ish strings, so string sort = approximate version sort).
  const nvmVersions = join(home, '.nvm', 'versions', 'node')
  if (existsSync(nvmVersions)) {
    try {
      const versions = readdirSync(nvmVersions).sort().reverse()
      for (const v of versions) {
        roots.push(join(nvmVersions, v, 'bin'))
      }
    } catch {}
  }
  return roots
}

function safeExecutable(path: string): boolean {
  try {
    const s = statSync(path)
    if (!s.isFile()) return false
    if (platform() === 'win32') return true
    return (s.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Spawn `<path> --version`, return the first non-empty stdout line, or
 * null on non-zero exit, timeout, or no usable output. Hard 3 s cap.
 *
 * Used by doctor (display) and bootstrap (codex SDK ↔ CLI version
 * matching). Sync because both callers are at startup/admin path — no
 * hot-path concern, and async would force an unwanted refactor through
 * the doctor sync surface.
 */
export function probeBinaryVersion(path: string): string | null {
  try {
    const r = spawnSync(path, ['--version'], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 3000,
      env: { ...process.env, PATH: augmentedPathEnv() },
    })
    if (r.status !== 0) return null
    const out = (r.stdout?.toString() ?? '').split(/\r?\n/).find(l => l.trim().length > 0)
    return out ? out.trim() : null
  } catch {
    return null
  }
}
