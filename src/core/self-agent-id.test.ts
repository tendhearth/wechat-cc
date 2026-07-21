import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSelfAgentId } from './self-agent-id'
import type { AgentConfig } from '../lib/agent-config'

const base: AgentConfig = { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }

describe('resolveSelfAgentId', () => {
  it('prefers the env override', () => {
    expect(resolveSelfAgentId(base, '/s', { env: { WECHAT_A2A_SELF_ID: 'from-env' } })).toBe('from-env')
  })

  it('uses config.self_agent_id when no env', () => {
    expect(resolveSelfAgentId({ ...base, self_agent_id: 'cc-cfg1234' }, '/s', { env: {} })).toBe('cc-cfg1234')
  })

  it('generates cc-<8hex sha256(mailbox_addr)> and persists it for a FRESH daemon (mailbox, no peers)', () => {
    const persist = vi.fn()
    const loadIdentity = vi.fn(() => ({ addr: 'AAAA_mailbox_addr' }))
    const cfg: AgentConfig = { ...base, mailbox_relays: ['https://brain.example/mailbox'] }
    const id = resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })
    expect(id).toMatch(/^cc-[0-9a-f]{8}$/)
    expect(resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })).toBe(id) // deterministic
    expect(persist).toHaveBeenCalledWith('/s', id)
  })

  it('GRANDFATHERS to wechat-cc when the config already has a2a_agents (no self_id/env)', () => {
    const persist = vi.fn()
    const loadIdentity = vi.fn()
    const cfg: AgentConfig = { ...base, mailbox_relays: ['https://brain.example/mailbox'],
      a2a_agents: [{ id: 'friend-1', name: 'F', url: 'https://f.example', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: [], paused: false, transport: 'push' }] }
    expect(resolveSelfAgentId(cfg, '/s', { env: {}, loadIdentity, persist })).toBe('wechat-cc')
    expect(loadIdentity).not.toHaveBeenCalled()       // never mints a new identity for a grandfathered daemon
    expect(persist).toHaveBeenCalledWith('/s', 'wechat-cc')
  })

  it('keeps the legacy wechat-cc default when no mailbox is configured (never touches loadMailboxIdentity)', () => {
    const loadIdentity = vi.fn()
    expect(resolveSelfAgentId(base, '/s', { env: {}, loadIdentity })).toBe('wechat-cc')
    expect(loadIdentity).not.toHaveBeenCalled()
  })

  it('persistSelfAgentId MERGES — sets only self_agent_id, preserves a2a_agents + unmodeled disk fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfid-merge-'))
    // On-disk config carries a peer AND a legacy/unmodeled key the schema drops.
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      mailbox_relays: ['https://brain.example/mailbox'],
      a2a_agents: [{ id: 'cc-peer0001', name: 'peer', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: [], transport: 'mailbox', mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://brain.example/mailbox'] }],
      legacy_unmodeled_field: 'keep-me',
    }))
    // Grandfathered → persists 'wechat-cc' via the REAL merge helper (no persist stub).
    const id = resolveSelfAgentId({ ...base, mailbox_relays: ['https://brain.example/mailbox'], a2a_agents: [{ id: 'cc-peer0001' } as any] }, dir, { env: {} })
    expect(id).toBe('wechat-cc')
    const onDisk = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8'))
    expect(onDisk.self_agent_id).toBe('wechat-cc')
    expect(onDisk.a2a_agents).toHaveLength(1)            // NOT wiped
    expect(onDisk.a2a_agents[0].id).toBe('cc-peer0001')
    expect(onDisk.legacy_unmodeled_field).toBe('keep-me') // unmodeled field survived
  })
})
