import { posix, win32 } from 'node:path'
/** Official desktop setup facts. Names live in executor-facts; WebViews never supply commands.
 * Verified 2026-11-16: code.claude.com/docs/en/setup, github.com/openai/codex,
 * cursor.com/docs/cli/installation, x.ai/build and xai-org/grok-build user guide.
 * agy installation intentionally remains a website handoff per owner ruling.
 */
import { EXECUTOR_FACTS } from './executor-facts'
import { grokHome, grokLoginCommand } from './grok-home'

export const CLI_SETUP_IDS = ['claude', 'codex', 'cursor', 'agy', 'grok'] as const
export type CliSetupId = typeof CLI_SETUP_IDS[number]
export type CliSetupAction = 'install' | 'login'
const FACTS = {
  claude: { install: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'irm https://claude.ai/install.ps1 | iex', login: 'claude auth login', website: 'https://claude.com/claude-code' },
  codex: { install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', windows: 'irm https://chatgpt.com/codex/install.ps1 | iex', login: 'codex login', website: 'https://developers.openai.com/codex/cli/' },
  cursor: { install: 'curl https://cursor.com/install -fsS | bash', windows: "irm 'https://cursor.com/install?win32=true' | iex", login: 'cursor-agent login', website: 'https://cursor.com/cli' },
  agy: { install: null, windows: null, login: 'agy', website: 'https://antigravity.google/' },
  grok: { install: 'curl -fsSL https://x.ai/cli/install.sh | bash', windows: 'irm https://x.ai/cli/install.ps1 | iex', login: null, website: 'https://x.ai/build' },
} as const

export function cliSetupId(id: unknown): CliSetupId {
  if (typeof id !== 'string' || !(CLI_SETUP_IDS as readonly string[]).includes(id)) throw new Error('invalid_provider')
  return id as CliSetupId
}
export function cliSetupAction(action: unknown): CliSetupAction {
  if (action !== 'install' && action !== 'login') throw new Error('invalid_action')
  return action
}
export function cliSetupInfo(id: CliSetupId, platform: string) {
  const f = FACTS[id]
  return { id, label: EXECUTOR_FACTS[id].names.settings, website: f.website,
    canInstall: !!(platform === 'win32' ? f.windows : platform === 'darwin' ? f.install : null), free: id === 'grok' }
}

export function cliSetupPlan(provider: unknown, actionInput: unknown, stateDir: string, platform: string, installed: boolean, binary?: string) {
  const id = cliSetupId(provider), action = cliSetupAction(actionInput), f = FACTS[id]
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('platform_unsupported')
  const installer = platform === 'win32' ? f.windows : f.install
  if (action === 'install' && !installer) throw new Error('installer_unavailable')
  if (action === 'login' && !installed) throw new Error('cli_not_installed')
  const quoted = binary ? (platform === 'win32' ? "& '" + binary.replaceAll("'", "''") + "'" : "'" + binary.replaceAll("'", "'\\''") + "'") : null
  const login = id === 'grok' ? grokLoginCommand(stateDir, platform === 'win32' ? 'powershell' : 'posix', binary)
    : quoted ? f.login!.replace(/^\S+/, () => quoted) : f.login!
  const installing = action === 'install' && !installed
  let installCommand: string = installer ?? ''
  if (id === 'grok' && installing) {
    const home = grokHome(stateDir)
    if (platform === 'win32') {
      const h = "'" + home.replaceAll("'", "''") + "'"
      installCommand = `$cc_original_profile = $env:USERPROFILE; Get-ChildItem Env:GROK_* | Remove-Item; Remove-Item Env:XAI_API_KEY,Env:CLAUDE_CONFIG_DIR,Env:CURSOR_CONFIG_DIR -ErrorAction SilentlyContinue; $env:GROK_BIN_DIR = Join-Path $cc_original_profile '.grok\\bin'; $env:HOME = ${h}; $env:USERPROFILE = ${h}; $env:XDG_CONFIG_HOME = Join-Path $env:HOME '.config'; ${installer}`
    } else {
      const h = "'" + home.replaceAll("'", "'\\''") + "'"
      // Keep the executable in the official discoverable root; isolate the installer's auth/config lookup.
      installCommand = installCommand.replace(/\| bash$/, () => `| GROK_BIN_DIR="$HOME/.grok/bin" XDG_CONFIG_HOME=${h}/.config HOME=${h} bash`)
    }
  }
  const commands: string[] = [...(installing ? [installCommand] : []), login]
  // No credential values or daemon environment are serialized. Terminal inherits its own login environment.
  const refreshWindowsPath = "$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path"
  const binaryDir = binary ? (platform === 'win32' ? win32 : posix).dirname(binary) : null
  const posixPath = binaryDir ? "export PATH='" + binaryDir.replaceAll("'", "'\\''") + "':\"$PATH\"" : null
  const windowsPath = binaryDir ? "$env:Path = '" + binaryDir.replaceAll("'", "''") + "' + ';' + $env:Path" : null
  const script = platform === 'win32'
    ? ["$ErrorActionPreference = 'Stop'", "$global:LASTEXITCODE = 0", refreshWindowsPath, ...(windowsPath ? [windowsPath] : []), ...commands.flatMap((c, i) => [installing && i === 0 ? "& (Join-Path $PSHOME 'powershell.exe') -NoProfile -Command '" + ("$ErrorActionPreference = 'Stop'; " + c).replaceAll("'", "''") + "'" : c, "if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'CLI setup failed' }", refreshWindowsPath]), "Write-Host '请回到 CC 查看接入状态。'"].join('\r\n')
    : ['#!/bin/bash', 'set -e', 'set -o pipefail', 'umask 077', 'trap \'rm -f -- "$0"; rmdir -- "$(dirname -- "$0")" 2>/dev/null || true\' EXIT', 'export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"', ...(posixPath ? [posixPath] : []), 'cd "$HOME"', ...(id === 'grok' ? ['for cc_setup_var in ${!GROK_@}; do unset "$cc_setup_var"; done', 'unset XAI_API_KEY CLAUDE_CONFIG_DIR CURSOR_CONFIG_DIR'] : []), ...commands, "printf '\\n请回到 CC 查看接入状态。\\n'"].join('\n') + '\n'
  return { provider: id, action, commands, script, extension: platform === 'win32' ? 'ps1' as const : 'command' as const }
}
