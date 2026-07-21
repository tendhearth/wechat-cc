import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore } from '../core/social-echo-store'
import { makePledgeStore } from '../core/social-pledge-store'
import {
  cmdSocialSeeks, cmdSocialEchoes, cmdSocialPledges, cmdSocialReveal,
  cmdSocialPropose, cmdSocialConfirm, cmdSocialCancel,
} from './social'

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

  // P4 派心愿 — propose() persists a `proposed` row (not `foraging`); the
  // status column already pads to width 9 and both 'proposed'(8) and
  // 'cancelled'(9) fit, so this is a no-code-change guard (task-5 brief 5a).
  it('renders a `proposed` row with its status', async () => {
    seed(s => { s.propose({ id: 'i3', kind: 'seek', topic: '找摄影搭子', redactedTopic: '找搭子' }) })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out.some(l => l.includes('proposed'))).toBe(true)
  })

  it('renders a `cancelled` row with its status', async () => {
    seed(s => {
      s.propose({ id: 'i4', kind: 'seek', topic: '找摄影搭子', redactedTopic: '找搭子' })
      s.update('i4', { status: 'cancelled' })
    })
    const out = await captureLog(() => cmdSocialSeeks(stateDir, { limit: 20, json: false }))
    expect(out.some(l => l.includes('cancelled'))).toBe(true)
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

describe('cmdSocialReveal', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('reveals an echo and prints the outcome state', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ outcome: { state: 'connected' } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialReveal('/nope', 'i1:ccb', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]).toContain('/v1/social/echoes/reveal')
    expect(out.join('\n')).toContain('connected')
  })

  it('falls back to pledges/reveal when the echo route 404s', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      return String(url).includes('/echoes/')
        ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
        : new Response(JSON.stringify({ outcome: { state: 'awaiting_peer' } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialReveal('/nope', 'i9:cca', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]).toContain('/echoes/reveal')
    expect(calls[1]).toContain('/pledges/reveal')
    expect(out.join('\n')).toContain('awaiting_peer')
  })

  it('fails clearly when neither route knows the id', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as unknown as typeof fetch
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialReveal('/nope', 'bogus', { json: false }, { ...baseDeps, fetch: fakeFetch, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/没找到|not found/i)
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialReveal('/nope', 'i1:ccb', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})

// P4 派心愿 — propose/confirm/cancel forms, mirroring cmdSocialReveal's
// injected-fetch/readInfo/readToken deps pattern above. Results are unions
// ({ok:true,...}/{ok:false,reason}) passed through verbatim by the
// internal-api route at HTTP 200 — assert both branches, never assume success.
describe('cmdSocialPropose', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('POSTs topic + city to seek/propose and prints the redacted preview + 派/取消 hint', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, intent_id: 'abc123', redacted: '找搭子', redacted_city: '北京' }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialPropose('/nope', '找摄影搭子,住朝阳', { city: '北京', json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/social/seek/propose')
    expect(calls[0]!.body).toEqual({ topic: '找摄影搭子,住朝阳', city: '北京' })
    const joined = out.join('\n')
    expect(joined).toContain('找搭子')
    expect(joined).toContain('abc123')
    expect(joined).toContain('派')
    expect(joined).toContain('取消')
  })

  it('omits city from the body when not given', async () => {
    const calls: { body: unknown }[] = []
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, intent_id: 'abc123', redacted: '找搭子' }), { status: 200 })
    }) as unknown as typeof fetch
    await cmdSocialPropose('/nope', '找搭子', { json: false }, { ...baseDeps, fetch: fakeFetch })
    expect(calls[0]!.body).toEqual({ topic: '找搭子' })
  })

  it('prints the gate-reject reason instead of a preview', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'blocked: contains phone number' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialPropose('/nope', '打给我 13800001111', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('blocked: contains phone number')
  })

  it('--json emits the outcome verbatim', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true, intent_id: 'abc123', redacted: '找搭子' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialPropose('/nope', '找搭子', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out.join('\n'))).toEqual({ ok: true, intent_id: 'abc123', redacted: '找搭子' })
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialPropose('/nope', '找搭子', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})

describe('cmdSocialConfirm', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('POSTs the id to seek/confirm and prints the dispatch-consistent success copy', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, intent_id: 'abc123' }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialConfirm('/nope', 'abc123', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/social/seek/confirm')
    expect(calls[0]!.body).toEqual({ id: 'abc123' })
    // Same wording as pipeline-deps.ts's WeChat 派 handler (~line 490).
    expect(out.join('\n')).toContain('已发出,觅食中')
  })

  it('prints the not-proposed failure copy consistent with the WeChat dispatch wording', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'not_proposed' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialConfirm('/nope', 'stale', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('不存在或已处理')
  })

  it('--json emits the outcome verbatim', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true, intent_id: 'abc123' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialConfirm('/nope', 'abc123', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out.join('\n'))).toEqual({ ok: true, intent_id: 'abc123' })
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialConfirm('/nope', 'abc123', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})

describe('cmdSocialCancel', () => {
  const info = { baseUrl: 'http://127.0.0.1:9', tokenFilePath: '/tmp/tok' }
  const baseDeps = { readInfo: () => info, readToken: () => 'tokhex' }

  it('POSTs the id to seek/cancel and prints 已作废, matching the WeChat 取消 handler', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialCancel('/nope', 'abc123', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(calls[0]!.url).toContain('/v1/social/seek/cancel')
    expect(calls[0]!.body).toEqual({ id: 'abc123' })
    expect(out.join('\n')).toContain('已作废')
  })

  it('prints the not_found failure reason', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, reason: 'not_found' }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialCancel('/nope', 'ghost', { json: false }, { ...baseDeps, fetch: fakeFetch }))
    expect(out.join('\n')).toContain('not_found')
  })

  it('--json emits the outcome verbatim', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    const out = await captureLog(() => cmdSocialCancel('/nope', 'abc123', { json: true }, { ...baseDeps, fetch: fakeFetch }))
    expect(JSON.parse(out.join('\n'))).toEqual({ ok: true })
  })

  it('fails clearly when the daemon is not running', async () => {
    const failed: string[] = []
    const fail = ((m: string) => { failed.push(m); throw new Error(m) }) as (m: string) => never
    await expect(cmdSocialCancel('/nope', 'abc123', { json: false }, { readInfo: () => null, fail })).rejects.toThrow()
    expect(failed[0]).toMatch(/daemon/i)
  })
})
