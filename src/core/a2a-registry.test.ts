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
    capabilities: ['notify'], paused: false, may_exec: false, ...overrides, transport: overrides.transport ?? 'push',
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

  it('verifyBearer rejects an empty stored key — no constant-time empty-match bypass', () => {
    // A hand-edited / corrupted agent-config.json can carry an empty
    // inbound_api_key (loadAll does NOT re-validate). Without an explicit guard
    // constantTimeEquals('', '') is true, so an attacker sending
    // `Authorization: Bearer ` (empty bearer) would authenticate as that agent
    // and could trigger notify/exec. Auth must reject an empty stored key.
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('ghost', { inbound_api_key: '' })])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.verifyBearer('ghost', '')).toBeNull()
    expect(reg.verifyBearer('ghost', 'anything')).toBeNull()
  })

  it('verifyBearer rejects an empty bearer against a real key', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(reg.verifyBearer('alpha', '')).toBeNull()
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

  it('update() patches name and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    const updated = reg.update('alpha', { name: 'New Display' })
    expect(updated.name).toBe('New Display')
    expect(reg.get('alpha')?.name).toBe('New Display')
    // Round-trip: reload from disk
    const reg2 = createA2ARegistry({ stateDir })
    expect(reg2.get('alpha')?.name).toBe('New Display')
  })

  it('update() patches outbound_api_key and persists', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    reg.update('alpha', { outbound_api_key: 'new-rotated-key' })
    expect(reg.get('alpha')?.outbound_api_key).toBe('new-rotated-key')
  })

  it('update() patches multiple fields atomically', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    reg.update('alpha', { name: 'X', url: 'https://moved.example.com/a2a' })
    const a = reg.get('alpha')
    expect(a?.name).toBe('X')
    expect(a?.url).toBe('https://moved.example.com/a2a')
  })

  it('update() preserves unchanged fields', () => {
    const stateDir = makeTempStateDir()
    const original = rec('alpha')
    writeConfig(stateDir, [original])
    const reg = createA2ARegistry({ stateDir })
    reg.update('alpha', { name: 'Renamed' })
    const after = reg.get('alpha')!
    expect(after.id).toBe(original.id)
    expect(after.url).toBe(original.url)
    expect(after.inbound_api_key).toBe(original.inbound_api_key)
    expect(after.outbound_api_key).toBe(original.outbound_api_key)
    expect(after.capabilities).toEqual(original.capabilities)
    expect(after.paused).toBe(original.paused)
  })

  it('update() throws on unknown id', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(() => reg.update('missing', { name: 'X' })).toThrow(/not found/)
  })

  it('update() rejects empty name / url / outbound_api_key', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(() => reg.update('alpha', { name: '' })).toThrow(/non-empty/)
    expect(() => reg.update('alpha', { url: '' })).toThrow(/non-empty/)
    expect(() => reg.update('alpha', { outbound_api_key: '' })).toThrow(/non-empty/)
  })

  it('update() rejects too-short inbound_api_key (matches schema min 16)', () => {
    const stateDir = makeTempStateDir()
    writeConfig(stateDir, [rec('alpha')])
    const reg = createA2ARegistry({ stateDir })
    expect(() => reg.update('alpha', { inbound_api_key: 'too-short' })).toThrow(/at least 16/)
  })
})

// 2026-09-02:重新配对(onPair 的「已存在」分支)必须能把 may_exec 从
// false 翻成 true —— **重新配对本身就是一次新的授权**,它消费掉的是本机
// `hand invite` 刚铸出来的一次性密钥。
//
// 真机上栽过:那个分支只 patch 了 inbound_api_key,于是一个此前以社交身份
// 登记过的 id 重新配成手之后照旧 403,而且没有任何提示。修完这条路才通。
describe('update —— may_exec 可 patch(重新配对是一次新授权)', () => {
  it('把一条 may_exec=false 的记录翻成 true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-reg-mayexec-'))
    const reg = createA2ARegistry({ stateDir: dir })
    reg.add({
      id: 'brain', name: 'brain', url: 'http://b/a2a',
      inbound_api_key: 'k'.repeat(16), outbound_api_key: 'unused',
      capabilities: [], paused: false, transport: 'push', may_exec: false,
    })
    expect(reg.get('brain')!.may_exec).toBe(false)
    const updated = reg.update('brain', { inbound_api_key: 'n'.repeat(16), may_exec: true })
    expect(updated.may_exec).toBe(true)
    // 落盘也要生效(daemon 重启后仍然算授权过)
    expect(createA2ARegistry({ stateDir: dir }).get('brain')!.may_exec).toBe(true)
  })
})
