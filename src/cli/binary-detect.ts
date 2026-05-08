/**
 * binary-detect.ts — figure out whether the installed wechat-cc service
 * runs a self-contained `wechat-cc-cli` binary or a bun + cli.ts source
 * checkout. Used by `wechat-cc update` to decide whether to recompile +
 * replace the binary after pulling new code.
 *
 * Pure parser: caller injects readFile (filesystem) + readSchTask (Windows
 * PowerShell shell-out) so the helper itself stays sync, side-effect-free,
 * and trivially unit-testable across platforms.
 *
 * Returns the absolute path to wechat-cc-cli if the service points at it;
 * null otherwise (dev mode, service missing, or basename mismatch).
 */
import { posix } from 'node:path'

const BINARY_BASENAMES = new Set(['wechat-cc-cli', 'wechat-cc-cli.exe'])

export interface DetectDeps {
  homeDir: string
  platform: NodeJS.Platform
  /** Returns the file contents, or null when the file is missing / unreadable. */
  readFile: (path: string) => string | null
  /** Windows-only probe: returns the scheduled task's Execute value (full path) or null. */
  readSchTask?: () => string | null
}

export function detectServiceBinaryPath(deps: DetectDeps): string | null {
  const candidate = (() => {
    if (deps.platform === 'linux') return parseSystemdExecStart(deps)
    if (deps.platform === 'darwin') return parseLaunchdProgramArgument(deps)
    if (deps.platform === 'win32') return deps.readSchTask?.() ?? null
    return null
  })()

  if (!candidate) return null
  return matchesBinary(candidate) ? candidate : null
}

function matchesBinary(absPath: string): boolean {
  // Use posix basename for forward slashes; check raw split for backslashes
  // so we don't need to know which platform produced the path.
  const tail = absPath.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return BINARY_BASENAMES.has(tail)
}

function parseSystemdExecStart(deps: DetectDeps): string | null {
  const unitPath = posix.join(deps.homeDir, '.config', 'systemd', 'user', 'wechat-cc.service')
  const content = deps.readFile(unitPath)
  if (!content) return null

  // ExecStart=<token0> <args...>; token0 may be quoted to allow whitespace
  // inside the path. Strip leading whitespace after `=` so a "ExecStart= /x"
  // with a stray space still parses.
  const m = /^ExecStart=\s*(.+)$/m.exec(content)
  if (!m) return null
  return firstShellToken(m[1]!.trim())
}

function parseLaunchdProgramArgument(deps: DetectDeps): string | null {
  const plistPath = posix.join(deps.homeDir, 'Library', 'LaunchAgents', 'com.wechat-cc.daemon.plist')
  const content = deps.readFile(plistPath)
  if (!content) return null

  // Find <key>ProgramArguments</key> followed by an <array> and pluck the
  // first <string> child. Tolerant of arbitrary whitespace + comments since
  // launchd plists are user-readable XML rather than canonical form.
  const arrayMatch = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(content)
  if (!arrayMatch) return null
  const firstString = /<string>([\s\S]*?)<\/string>/i.exec(arrayMatch[1]!)
  if (!firstString) return null
  return firstString[1]!.trim() || null
}

// Extract the first whitespace-separated token, honoring single OR double
// quoted spans so paths like `"/opt/wechat tools/wechat-cc-cli"` survive.
function firstShellToken(line: string): string | null {
  if (!line) return null
  const trimmed = line.trimStart()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    return end === -1 ? null : trimmed.slice(1, end)
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1)
    return end === -1 ? null : trimmed.slice(1, end)
  }
  const sp = trimmed.search(/\s/)
  return sp === -1 ? trimmed : trimmed.slice(0, sp)
}
