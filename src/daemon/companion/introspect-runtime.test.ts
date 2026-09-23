import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIntrospectAgent, resolveIntrospectChatId } from './introspect-runtime'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { openTestDb, type Db } from '../../lib/db'

function makeStores(stateDir: string, chatId: string, db: Db) {
  const memoryRoot = join(stateDir, 'memory')
  return {
    events: makeEventsStore(db, chatId),
    observations: makeObservationsStore(db, chatId),
  }
}

describe('makeIntrospectAgent (real SDK)', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intro-rt-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds context, calls injected sdkEval, parses response', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    const sdkEval = vi.fn(async (_prompt: string) =>
      JSON.stringify({ write: true, body: '观察一条', tone: 'curious', reasoning: 'r' })
    )
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => 'profile.md: hello',
      recentInboundMessages: async () => ['今天累'],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(sdkEval).toHaveBeenCalledOnce()
    expect(result).toEqual({ write: true, body: '观察一条', tone: 'curious', reasoning: 'r' })
  })

  it('excludes archived observation reasoning from future introspection without removing audit history', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    const archived = await observations.append({ body: 'superseded observation body' })
    const active = await observations.append({ body: 'current observation body' })
    // The event remains relevant even when its active observation is older
    // than the five bodies included in the bounded prompt context.
    for (let i = 0; i < 5; i++) await observations.append({ body: `newer body ${i}` })
    await events.append({ kind: 'observation_written', trigger: 'introspect', reasoning: 'superseded inference', observation_id: archived })
    await events.append({ kind: 'observation_written', trigger: 'introspect', reasoning: 'still active inference', observation_id: active })
    await events.append({ kind: 'cron_eval_skipped', trigger: 'daily', reasoning: 'unrelated cron decision' })
    await observations.archive(archived)
    const sdkEval = vi.fn(async (_prompt: string) => '{"write":false,"reasoning":"nothing new"}')
    const agent = makeIntrospectAgent({ chatId: 'chat_x', events, observations, memorySnapshot: async () => '', recentInboundMessages: async () => [], sdkEval })
    await agent.runIntrospect()
    const prompt = sdkEval.mock.calls[0]![0]
    expect(prompt).not.toContain('superseded inference')
    expect(prompt).not.toContain('superseded observation body')
    expect(prompt).toContain('still active inference')
    expect(prompt).toContain('unrelated cron decision')
    expect(await events.list()).toHaveLength(3)
    expect(await observations.listArchived()).toMatchObject([{ id: archived, body: 'superseded observation body' }])
  })

  it('omits observation event reasoning when its source cannot be verified as active', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    await events.append({ kind: 'observation_written', trigger: 'legacy', reasoning: 'unverifiable legacy inference' })
    await events.append({ kind: 'observation_written', trigger: 'legacy', reasoning: 'missing record inference', observation_id: 'obs_missing' })
    const sdkEval = vi.fn(async (_prompt: string) => '{"write":false,"reasoning":"nothing new"}')
    const agent = makeIntrospectAgent({ chatId: 'chat_x', events, observations, memorySnapshot: async () => '', recentInboundMessages: async () => [], sdkEval })
    await agent.runIntrospect()
    expect(sdkEval.mock.calls[0]![0]).not.toContain('unverifiable legacy inference')
    expect(sdkEval.mock.calls[0]![0]).not.toContain('missing record inference')
    expect(await events.list()).toHaveLength(2)
  })

  it('returns write=false on SDK error (does not throw)', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    const sdkEval = vi.fn(async () => { throw new Error('timeout') })
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result.write).toBe(false)
    expect(result.reasoning).toContain('SDK error')
    expect(result.reasoning).toContain('timeout')
  })

  it('returns write=false on malformed SDK output (parse failure)', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    const sdkEval = vi.fn(async () => 'not json at all')
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result.write).toBe(false)
    expect(result.reasoning).toContain('parse failed')
  })

  it('forwards SDK output verbatim when valid JSON', async () => {
    const { events, observations } = makeStores(dir, 'chat_x', db)
    const sdkEval = vi.fn(async () =>
      '```json\n{"write":false,"reasoning":"nothing new"}\n```'
    )
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result).toEqual({ write: false, reasoning: 'nothing new' })
  })
})

describe('resolveIntrospectChatId', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'introspect-rt-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null when no companion config exists', () => {
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns null when default_chat_id is not set', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true }))
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns the configured default_chat_id', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'chat_x' }))
    expect(resolveIntrospectChatId(dir)).toBe('chat_x')
  })
})
