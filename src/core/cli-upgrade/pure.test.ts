import { describe, it, expect } from 'vitest'
import { CLI_SPECS } from './specs'
import { compareVersions, isNewer, parseVersion } from './version'
import { outdatedClientSignal } from './outdated-signal'
import { resolveCliUpgradeConfig } from './config'
import { backoffMs } from './engine'
import { claudeUpdateChannel, latestVersion } from './detect'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'

describe('version', () => {
  it('parses each CLI --version line', () => {
    expect(parseVersion(CLI_SPECS.claude, '2.1.289 (Claude Code)')).toBe('2.1.289')
    expect(parseVersion(CLI_SPECS.codex, 'codex-cli 0.160.0')).toBe('0.160.0')
    expect(parseVersion(CLI_SPECS.cursor, '2026.09.02-c22c1a3')).toBe('2026.09.02-c22c1a3')
    expect(parseVersion(CLI_SPECS.agy, '1.2.16')).toBe('1.2.16')
    expect(parseVersion(CLI_SPECS.codex, 'no version here')).toBeNull()
  })
  it('compares semver numerically, prerelease below release', () => {
    expect(isNewer(CLI_SPECS.codex, '0.160.0', '0.99.9')).toBe(true)
    expect(isNewer(CLI_SPECS.codex, '0.160.0', '0.160.0')).toBe(false)
    expect(compareVersions(CLI_SPECS.codex, '1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })
  it('compares cursor build ids by date', () => {
    expect(isNewer(CLI_SPECS.cursor, '2026.10.01-e373342', '2026.09.02-c22c1a3')).toBe(true)
    expect(isNewer(CLI_SPECS.cursor, '2026.09.02-c22c1a3', '2026.10.01-e373342')).toBe(false)
  })
})

describe('outdatedClientSignal (error channel only)', () => {
  // 真机采集的 codex 原文(provider-error-shapes fixtures)
  const tooNew = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-terra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'
  const unsupported = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}'
  it('codex: both harvested shapes and the workbench code', () => {
    expect(outdatedClientSignal('codex', tooNew)).toBe(true)
    expect(outdatedClientSignal('codex', unsupported)).toBe(true)
    expect(outdatedClientSignal('codex', null, 'execution_model_unsupported')).toBe(true)
    expect(outdatedClientSignal('codex', "You've hit your usage limit. Upgrade to Pro")).toBe(false)
  })
  it('cursor: only the whole fixed sentence', () => {
    expect(outdatedClientSignal('cursor', '\n\nCheck your settings to continue')).toBe(true)
    expect(outdatedClientSignal('cursor', 'Upgrade your plan to continue')).toBe(false)
    expect(outdatedClientSignal('cursor', 'Please check your settings to continue editing the file')).toBe(false)
  })
  it('claude / agy: guessed phrasings only; ordinary errors never match', () => {
    expect(outdatedClientSignal('claude', 'This model requires a newer version of Claude Code')).toBe(true)
    expect(outdatedClientSignal('claude', 'API Error: 529 overloaded')).toBe(false)
    expect(outdatedClientSignal('agy', 'Please update agy to continue')).toBe(true)
    expect(outdatedClientSignal('agy', 'authentication failed or timed out')).toBe(false)
  })
})

describe('config', () => {
  it('defaults: enabled, 4am, every CLI on', () => {
    expect(resolveCliUpgradeConfig(undefined)).toEqual({ enabled: true, checkHour: 4, cli: { claude: true, codex: true, cursor: true, agy: true } })
  })
  it('per-CLI overrides and bad values', () => {
    const c = resolveCliUpgradeConfig({ enabled: true, check_hour: 25, per_cli: { agy: { enabled: false }, codex: 'nope' } })
    expect(c.checkHour).toBe(4)
    expect(c.cli.agy).toBe(false)
    expect(c.cli.codex).toBe(true)
    expect(resolveCliUpgradeConfig({ enabled: false }).enabled).toBe(false)
  })
})

describe('backoff', () => {
  it('doubles from 1h, caps at 24h', () => {
    expect(backoffMs(1)).toBe(3_600_000)
    expect(backoffMs(2)).toBe(7_200_000)
    expect(backoffMs(10)).toBe(24 * 3_600_000)
  })
})

describe('latestVersion (injected fetch, never the network)', () => {
  const ok = (body: unknown, text = false) => (async () => new Response(text ? String(body) : JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  it('npm dist-tags; claude follows its update channel', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-upgrade-home-'))
    try {
      const tags = { latest: '2.1.289', stable: '2.1.285' }
      expect((await latestVersion(CLI_SPECS.codex, { fetch: ok({ latest: '0.160.0' }), homeDir: home })).version).toBe('0.160.0')
      expect((await latestVersion(CLI_SPECS.claude, { fetch: ok(tags), homeDir: home })).version).toBe('2.1.289')
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
      expect(claudeUpdateChannel(home)).toBe('stable')
      expect((await latestVersion(CLI_SPECS.claude, { fetch: ok(tags), homeDir: home })).version).toBe('2.1.285')
    } finally { removeTempDir(home) }
  })
  it('cursor: version pinned in the official install script', async () => {
    const script = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.01-e373342/${OS}/${ARCH}/agent-cli-package.tar.gz"'
    expect((await latestVersion(CLI_SPECS.cursor, { fetch: ok(script, true), homeDir: '/nonexistent' })).version).toBe('2026.10.01-e373342')
  })
  it('agy has no read-only source; network errors come back as error, not throw', async () => {
    expect(await latestVersion(CLI_SPECS.agy, { fetch: ok({}), homeDir: '/x' })).toEqual({ version: null, source: 'none' })
    const boom = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const r = await latestVersion(CLI_SPECS.codex, { fetch: boom, homeDir: '/x' })
    expect(r.version).toBeNull()
    expect(r.error).toContain('ENOTFOUND')
  })
})
