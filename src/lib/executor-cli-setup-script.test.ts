import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { cliSetupPlan } from './executor-cli-setup'

// The official installers/CLIs are replaced by tiny fixtures; never open Terminal or call a real CLI.
it.runIf(process.platform !== 'win32').each([false, true])('runs only fake installer/login, stopping on installer failure=%s', fail => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-setup-script-'))
  try {
    const bin = join(dir, '.local/bin'), scriptDir = join(dir, 'script')
    mkdirSync(bin, { recursive: true }); mkdirSync(scriptDir)
    const executable = (name: string, body: string) => writeFileSync(join(bin, name), '#!/bin/sh\n' + body, { mode: 0o700 })
    executable('curl', fail ? 'exit 23\n' : "printf 'fixture installer'\n")
    executable('bash', 'cat >/dev/null\nexit 0\n')
    executable('claude', 'printf "%s\\n" "$@" > "$CC_SETUP_RECORD"\n')
    const script = join(scriptDir, 'setup.command'), record = join(dir, 'login-args')
    writeFileSync(script, cliSetupPlan('claude', 'install', dir, 'darwin', false).script, { mode: 0o700 })
    const r = spawnSync('/bin/bash', [script], { env: { HOME: dir, PATH: '/usr/bin:/bin', CC_SETUP_RECORD: record }, encoding: 'utf8' })
    expect(r.status === 0).toBe(!fail)
    expect(existsSync(record)).toBe(!fail)
    if (!fail) expect(readFileSync(record, 'utf8')).toBe('auth\nlogin\n')
    expect(existsSync(script)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it.runIf(process.platform !== 'win32')('Grok script drops inherited credential overrides before the fake login', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-grok-script-'))
  try {
    const bin = join(dir, '.local/bin'), scripts = join(dir, 'scripts')
    mkdirSync(bin, { recursive: true }); mkdirSync(scripts)
    writeFileSync(join(bin, 'grok'), '#!/bin/sh\n[ -z "$GROK_AUTH_SENTINEL" ] || exit 42\n[ "$HOME" = "$CC_EXPECTED_HOME" ] || exit 43\n', { mode: 0o700 })
    const script = join(scripts, 'login.command')
    writeFileSync(script, cliSetupPlan('grok', 'login', dir, 'darwin', true).script, { mode: 0o700 })
    const result = spawnSync('/bin/bash', [script], { env: { HOME: dir, PATH: '/usr/bin:/bin', GROK_AUTH_SENTINEL: 'never-use-owner', CC_EXPECTED_HOME: join(dir, 'executors/grok/home') } })
    expect(result.status).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it.runIf(process.platform !== 'win32')('keeps a detected nvm/custom binary directory on PATH for its interpreter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-nvm-script-'))
  try {
    const bin = join(dir, 'fake node/bin'), scripts = join(dir, 'scripts')
    mkdirSync(bin, { recursive: true }); mkdirSync(scripts)
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf fixture > "$CC_SETUP_RECORD"\n', { mode: 0o700 })
    const binary = join(bin, 'codex')
    writeFileSync(binary, '#!/usr/bin/env node\nfixture only\n', { mode: 0o700 })
    const script = join(scripts, 'login.command'), record = join(dir, 'record')
    writeFileSync(script, cliSetupPlan('codex', 'login', dir, 'darwin', true, binary).script, { mode: 0o700 })
    const result = spawnSync('/bin/bash', [script], { env: { HOME: dir, PATH: '/usr/bin:/bin', CC_SETUP_RECORD: record } })
    expect(result.status).toBe(0)
    expect(readFileSync(record, 'utf8')).toBe('fixture')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it.runIf(process.platform !== 'win32')('Grok installer cannot discover owner credentials; binary remains in its standard discoverable root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-grok-install-isolation-'))
  try {
    const bin = join(dir, '.local/bin'), scripts = join(dir, 'scripts')
    mkdirSync(bin, { recursive: true }); mkdirSync(scripts)
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf fixture\n', { mode: 0o700 })
    writeFileSync(join(bin, 'bash'), '#!/bin/sh\n[ "$HOME" = "$CC_EXPECTED_HOME" ] || exit 41\n[ "$GROK_BIN_DIR" = "$CC_EXPECTED_BIN" ] || exit 42\ncat >/dev/null\n', { mode: 0o700 })
    writeFileSync(join(bin, 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const script = join(scripts, 'install.command')
    writeFileSync(script, cliSetupPlan('grok', 'install', dir, 'darwin', false).script, { mode: 0o700 })
    const result = spawnSync('/bin/bash', [script], { env: { HOME: dir, PATH: '/usr/bin:/bin', CC_EXPECTED_HOME: join(dir, 'executors/grok/home'), CC_EXPECTED_BIN: join(dir, '.grok/bin') } })
    expect(result.status).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
