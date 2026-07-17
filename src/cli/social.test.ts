import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'
import { cmdSocialSeeks, cmdSocialEchoes, cmdSocialPledges } from './social'

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-cli-social-test-'))
}

// Capture console.log calls during a block.
function captureLog(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const out: string[] = []
  const stub = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  })
  const result = fn()
  if (result instanceof Promise) {
    return result.then(() => { stub.mockRestore(); return out })
      .catch(err => { stub.mockRestore(); throw err })
  }
  stub.mockRestore()
  return Promise.resolve(out)
}

describe('cmdSocialSeeks', () => {
  let stateDir: string
  function seed(fn: (s: ReturnType<typeof makeSeekStore>) => void): void {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { fn(makeSeekStore(db)) } finally { db.close() }
  }
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('prints an empty note when there are no seeks', async () => {
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out.some(l => /没有|no seeks/i.test(l))).toBe(true)
  })

  it('prints seeks newest-first with topic + status', async () => {
    seed(s => {
      s.create({ id: 'i1', kind: 'seek', topic: '找摄影搭子' })
      s.create({ id: 'i2', kind: 'seek', topic: '找会修相机的' })
    })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out[0]).toContain('找会修相机的')   // newest first
    expect(out[0]).toContain('foraging')
    expect(out.some(l => l.includes('找摄影搭子'))).toBe(true)
  })

  it('--json emits a parseable envelope', async () => {
    seed(s => { s.create({ id: 'i1', kind: 'seek', topic: '找摄影搭子' }) })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: true }))
    const parsed = JSON.parse(out.join('\n'))
    expect(parsed.seeks[0].topic).toBe('找摄影搭子')
  })
})

describe('cmdSocialEchoes', () => {
  let stateDir: string
  function seedEcho(fn: (s: ReturnType<typeof makeEchoStore>) => void): void {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { fn(makeEchoStore(db)) } finally { db.close() }
  }
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  // THE PRIVACY LOCK — this is the reason toPublicEcho exists.
  it('NEVER prints peer_agent_id / relay_via / relay_token (human or json)', async () => {
    seedEcho(s => {
      s.create({ id: 'echo001', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个师傅', peerAgentId: 'ccb' })
      s.create({ id: 'echo002', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: '经W转发', peerAgentId: null, relayVia: 'ccw', relayToken: 'tok' })
    })
    const human = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: false }))).join('\n')
    const json = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: true }))).join('\n')
    for (const blob of [human, json]) {
      expect(blob).not.toContain('ccb')
      expect(blob).not.toContain('ccw')
      expect(blob).not.toContain('tok')
      expect(blob).not.toContain('peer_agent_id')
      expect(blob).not.toContain('relay_via')
      expect(blob).not.toContain('relay_token')
    }
    // The masked view IS shown:
    expect(human).toContain('第 1 度的某人')
    expect(human).toContain('第 2 度的某人')
  })

  it('--seek filters to one wish', async () => {
    seedEcho(s => {
      s.create({ id: 'echo001', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'aaa', peerAgentId: 'ccb' })
      s.create({ id: 'echo002', seekId: 'i2', peerMasked: '第 1 度的某人', degree: 1, content: 'bbb', peerAgentId: 'ccc' })
    })
    const out = (await captureLog(() => cmdSocialEchoes(stateDir, { limit: 20, json: false, seek: 'i1' }))).join('\n')
    expect(out).toContain('aaa')
    expect(out).not.toContain('bbb')
  })
})

describe('cmdSocialPledges', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('prints pledges with topic (empty note when none)', async () => {
    const empty = await captureLog(() => cmdSocialPledges(stateDir, { limit: 20, json: false }))
    expect(empty.some(l => /没有|no pledges/i.test(l))).toBe(true)

    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try { makePledgeStore(db).create({ id: 'i9:cca', intentId: 'i9', seekerAgentId: 'cca', topic: '找球友' }) }
    finally { db.close() }

    const out = (await captureLog(() => cmdSocialPledges(stateDir, { limit: 20, json: false }))).join('\n')
    expect(out).toContain('找球友')
  })
})
