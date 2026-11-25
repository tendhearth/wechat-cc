/**
 * claude-env.ts — 找 Claude Code 二进制、把 ~/.claude/settings.json 里的认证
 * 环境变量灌进 process.env。从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap
 * 拆分,spec 2026-09-27-bootstrap-split-design);只加了 export。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { findOnPath } from '../../lib/util'
import { readJsonFile } from '../../lib/read-json-file'
import type { BootstrapDeps } from './types'

/**
 * Locate a working Claude Code binary. The SDK's own native-binary detection
 * mis-picks the musl variant under bun on glibc Ubuntu (bug in libc probing);
 * passing pathToClaudeCodeExecutable bypasses that. Preference order:
 *   1. env var override
 *   2. system claude on PATH (works in any CC-installed env)
 *   3. bundled glibc variant shipped with the SDK itself
 */
export function resolveClaudeBinary(): string | undefined {
  if (process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  const fromPath = findOnPath('claude')
  if (fromPath && existsSync(fromPath)) return fromPath
  const here = dirname(fileURLToPath(import.meta.url))
  // src/daemon/bootstrap/index.ts → ../../../node_modules/...
  const bundled = join(here, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
  if (existsSync(bundled)) return bundled
  return undefined
}

/** Resolve the optional native CLI that the SDK uses without an explicit path. */
export function resolveSdkClaudeBinary(): string | undefined {
  try {
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
    const { platform, arch } = process
    const packages = platform === 'linux' ? [`linux-${arch}-musl`, `linux-${arch}`] : [`${platform}-${arch}`]
    for (const name of packages) {
      try { return sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${platform === 'win32' ? '.exe' : ''}`) }
      catch { /* Try the next platform package. */ }
    }
  } catch { /* The compiled SDK may not have an on-disk package. */ }
}

const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

export function hydrateClaudeAuthEnvFromUserSettings(log: BootstrapDeps['log']): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  try {
    const parsed = readJsonFile(settingsPath) as { env?: Record<string, unknown> }
    const env = parsed.env
    if (!env || typeof env !== 'object') return

    const copied: string[] = []
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (process.env[key]) continue
      const value = env[key]
      if (typeof value !== 'string' || value.length === 0) continue
      process.env[key] = value
      copied.push(key)
    }
    if (copied.length > 0) {
      log('BOOT', `claude auth env loaded from ~/.claude/settings.json: ${copied.join(', ')}`)
    }
  } catch {
    log('BOOT', 'claude auth env not loaded: failed to parse ~/.claude/settings.json')
  }
}
