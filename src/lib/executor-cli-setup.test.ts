import { describe, expect, it } from 'vitest'
import * as setup from './executor-cli-setup'

const plan = (id: unknown, action: unknown, platform = 'darwin', installed = false) => setup.cliSetupPlan(id, action, '/tmp/CC state', platform, installed)

describe('CLI setup whitelist', () => {
  it('installs with the official native installer then logs in; login never reinstalls', () => {
    expect(plan('claude', 'install').commands).toEqual(['curl -fsSL https://claude.ai/install.sh | bash', 'claude auth login'])
    expect(plan('codex', 'install').commands).toEqual(['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'codex login'])
    expect(plan('cursor', 'install').commands).toEqual(['curl https://cursor.com/install -fsS | bash', 'cursor-agent login'])
    expect(plan('claude', 'login', 'darwin', true).commands).toEqual(['claude auth login'])
    expect(plan('codex', 'install', 'darwin', true).commands).toEqual(['codex login'])
  })
  it('keeps Grok login in the dedicated HOME, including shell metacharacters', () => {
    const p = setup.cliSetupPlan('grok', 'login', "/tmp/CC's $(touch nope)", 'darwin', true)
    expect(p.commands).toEqual(["umask 077 && mkdir -p '/tmp/CC'\\''s $(touch nope)/executors/grok/home' && (unset GROK_HOME GROK_AUTH_PATH GROK_AUTH GROK_CONFIG GROK_API_KEY XAI_API_KEY CLAUDE_CONFIG_DIR; HOME='/tmp/CC'\\''s $(touch nope)/executors/grok/home' grok login)"])
    expect(p.script).toContain('set -e')
    expect(p.script).toContain('pipefail')
  })
  it('never invents an agy installer and refuses uninstalled login', () => {
    expect(() => plan('agy', 'install')).toThrow('installer_unavailable')
    expect(() => plan('agy', 'login')).toThrow('cli_not_installed')
    expect(plan('agy', 'login', 'darwin', true).commands).toEqual(['agy'])
  })
  it.each(['', 'openai', 'gemini', 'Grok', '__proto__', 'claude; touch /tmp/pwn', null])('rejects provider %s', id => {
    expect(() => plan(id, 'install')).toThrow('invalid_provider')
  })
  it.each(['', 'open', 'install;whoami', null])('rejects action %s', action => {
    expect(() => plan('claude', action)).toThrow('invalid_action')
  })
  it('only offers verified free availability on Grok', () => {
    expect(setup.CLI_SETUP_IDS.filter(id => setup.cliSetupInfo(id, 'darwin').free)).toEqual(['grok'])
    expect(setup.cliSetupInfo('agy', 'darwin').canInstall).toBe(false)
  })
  it('uses only official PowerShell installers on Windows with fail-stop sequencing', () => {
    for (const [id, url] of [['claude', 'https://claude.ai/install.ps1'], ['codex', 'https://chatgpt.com/codex/install.ps1'], ['cursor', 'https://cursor.com/install?win32=true'], ['grok', 'https://x.ai/cli/install.ps1']]) {
      const p = plan(id, 'install', 'win32')
      expect(p.commands[0]).toContain(url)
      expect(p.script).toContain("$ErrorActionPreference = 'Stop'")
      expect(p.script).not.toContain('curl -fsSL')
    }
    const grok = plan('grok', 'login', 'win32', true)
    expect(grok.commands[0]).toContain("$env:HOME = '/tmp/CC state/executors/grok/home'")
    expect(grok.commands[0]).toContain('grok login')
    expect(() => plan('agy', 'install', 'win32')).toThrow('installer_unavailable')
  })
})

it('refreshes Windows PATH after installation and before login in the same window', () => {
  const p = plan('grok', 'install', 'win32')
  const installAt = p.script.indexOf('irm https://x.ai/cli/install.ps1')
  const refreshAt = p.script.indexOf("GetEnvironmentVariable('Path','User')", installAt)
  expect(refreshAt).toBeGreaterThan(installAt)
  expect(refreshAt).toBeLessThan(p.script.indexOf('grok login'))
})

it('uses daemon-detected binary paths safely instead of losing nvm/custom installs', () => {
  expect(setup.cliSetupPlan('codex', 'login', '/s', 'darwin', true, "/opt/Owner's Codex/codex").commands).toEqual(["'/opt/Owner'\\''s Codex/codex' login"])
  expect(setup.cliSetupPlan('cursor', 'login', '/s', 'win32', true, "C:\\Owner's apps\\cursor-agent.cmd").commands).toEqual(["& 'C:\\Owner''s apps\\cursor-agent.cmd' login"])
})
it('contains PowerShell installer exits in a child process so the visible parent can report failure', () => {
  const install = plan('claude', 'install', 'win32').script
  expect(install).toContain("& (Join-Path $PSHOME 'powershell.exe') -NoProfile -Command")
  expect(plan('claude', 'login', 'win32', true).script).not.toContain("Join-Path $PSHOME 'powershell.exe'")
})
it('isolates Grok installer credential discovery as well as its login on Windows', () => {
  const command = plan('grok', 'install', 'win32').commands[0]!
  expect(command).toContain("$env:USERPROFILE = '/tmp/CC state/executors/grok/home'")
  expect(command).toContain('$env:GROK_BIN_DIR')
  expect(command).toContain('Env:GROK_*')
})
it('preserves JS replacement metacharacters literally in the isolated Grok installer HOME', () => {
  const p = setup.cliSetupPlan('grok', 'install', "/s/$&/$'/$`", 'darwin', false)
  expect(p.commands[0]).toContain("HOME='/s/$&/$'\\''/$`/executors/grok/home' bash")
})
