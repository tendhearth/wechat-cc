import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createA2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'

function makeTempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-a2a-test-'))
}

function writeConfig(stateDir: string, agents: A2AAgentRecord[]): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, 'agent-config.json'),
    JSON.stringify({ provider: 'claude', a2a_agents: agents }, null, 2),
  )
}

function rec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `https://${id}.example.com/a2a`,
    inbound_api_key: `wc_${id}1234567890123456`.slice(0, 24),  // ensure min 16
    outbound_api_key: `out_${id}`,
    capabilities: ['notify'], paused: false, ...overrides,
  }
}

describe('a2a-registry', () => {
  it('loads existing agents from config file', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha'), rec('beta')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list().map(a => a.id).sort()).toEqual(['alpha', 'beta'])
  })

  it('list() returns empty when config has no a2a_agents', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list()).toEqual([])
  })

  it('get(id) returns the matching record', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.url).toBe('https://alpha.example.com/a2a')
    expect(reg.get('missing')).toBeNull()
  })

  it('verifyBearer returns the agent on match, null on mismatch', () => {
    const stateDir = makeTempStateDir()
    const alphaRec = rec('alpha')
    writeConfig(stateDir, [alphaRec])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.verifyBearer('alpha', alphaRec.inbound_api_key)?.id).toBe('alpha')
    expect(reg.verifyBearer('alpha', 'wrong')).toBeNull()
    expect(reg.verifyBearer('missing', 'anything')).toBeNull()
  })

  it('add() persists a new agent and rejects duplicate id', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [])
    const reg = createA2ARegistry({ stateDir })
    reg.add(rec('alpha'))
    expect(reg.list().map(a => a.id)).toEqual(['alpha'])
    expect(() => reg.add(rec('alpha'))).toThrow(/already exists/)
    // Reload from disk to confirm persistence
    const reg2 = createA2ARegistry({ stateDir })
    expect(reg2.list().map(a => a.id)).toEqual(['alpha'])
  })

  it('remove() drops the agent and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha'), rec('beta')])
    const reg = createA2ARegistry({ stateDir })
    reg.remove('alpha')
    expect(reg.list().map(a => a.id)).toEqual(['beta'])
    expect(() => reg.remove('missing')).toThrow(/not found/)
  })

  it('setPaused() flips the paused flag and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    reg.setPaused('alpha', true)
    expect(reg.get('alpha')?.paused).toBe(true)
    reg.setPaused('alpha', false)
    expect(reg.get('alpha')?.paused).toBe(false)
  })
})
