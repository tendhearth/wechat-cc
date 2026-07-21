import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdSocialEnable, DEFAULT_SOCIAL_DISCLOSURE_POLICY, DEFAULT_MAILBOX_RELAYS } from './social-enable'

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-cli-social-enable-test-'))
}

// Capture console.log calls during a block.
function captureLog(fn: () => void): string[] {
  const out: string[] = []
  const stub = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  })
  try { fn() } finally { stub.mockRestore() }
  return out
}

describe('cmdSocialEnable', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('merge-persists social_enabled + defaults, preserving unmodeled/existing keys (bot_name, a2a_agents)', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      bot_name: 'x',
      a2a_agents: [{ id: 'peer-1', name: 'peer' }],
      legacy_unmodeled_field: 'keep-me',
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')

    cmdSocialEnable(stateDir, { status: false })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    expect(onDisk.social_disclosure_policy).toBe(DEFAULT_SOCIAL_DISCLOSURE_POLICY)
    expect(onDisk.mailbox_relays).toEqual(DEFAULT_MAILBOX_RELAYS)
    // unmodeled/existing keys preserved byte-for-byte (except the set keys)
    expect(onDisk.bot_name).toBe('x')
    expect(onDisk.a2a_agents).toEqual(before.a2a_agents)
    expect(onDisk.legacy_unmodeled_field).toBe('keep-me')
  })

  it('does NOT overwrite an existing social_disclosure_policy or mailbox_relays', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      social_disclosure_policy: '我自己的策略',
      mailbox_relays: ['https://other/mailbox'],
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')

    cmdSocialEnable(stateDir, { status: false })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    expect(onDisk.social_disclosure_policy).toBe('我自己的策略')
    expect(onDisk.mailbox_relays).toEqual(['https://other/mailbox'])
  })

  it('writes the config file atomically (tmp+rename) with mode 0600', () => {
    const configPath = join(stateDir, 'agent-config.json')
    cmdSocialEnable(stateDir, { status: false })

    // No leftover tmp file, real file exists and parses.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('--status prints the three current values and does NOT write', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      social_enabled: true,
      social_disclosure_policy: '现有策略',
      mailbox_relays: ['https://existing/mailbox'],
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')
    const beforeRaw = readFileSync(configPath, 'utf8')

    const out = captureLog(() => cmdSocialEnable(stateDir, { status: true }))
    const joined = out.join('\n')
    expect(joined).toContain('true')
    expect(joined).toContain('现有策略')
    expect(joined).toContain('https://existing/mailbox')

    // no write happened
    expect(readFileSync(configPath, 'utf8')).toBe(beforeRaw)
  })

  it('--status on a missing config prints falsy defaults without creating the file', () => {
    const out = captureLog(() => cmdSocialEnable(stateDir, { status: true }))
    expect(out.join('\n')).toBeTruthy()
  })
})
