import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AServer } from '../core/a2a-server'
import { mintInvite, verifyAndConsumeInvite } from '../lib/a2a-pairing'
import { acceptBrain, addHand, joinHand, listPairings, pingHands, planHandInvite } from './hand-pairing'

let stateDir: string
const TOKEN = 'shared-secret-0123456789'  // ≥16

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'hand-pair-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('addHand (brain side)', () => {
  it('registers a hand the brain can call (outbound_api_key=token, exec capability)', () => {
    addHand(stateDir, { id: 'home', url: 'http://home.ts.net:7000/a2a', name: '家里', token: TOKEN })
    const rec = createA2ARegistry({ stateDir }).get('home')!
    expect(rec.name).toBe('家里')
    expect(rec.url).toBe('http://home.ts.net:7000/a2a')
    expect(rec.outbound_api_key).toBe(TOKEN)
    expect(rec.capabilities).toContain('exec')
    expect(rec.inbound_api_key.length).toBeGreaterThanOrEqual(16)
  })

  it('rejects a non-slug id and a short token', () => {
    expect(() => addHand(stateDir, { id: '家里', url: 'http://x/a2a', token: TOKEN })).toThrow(/slug/)
    expect(() => addHand(stateDir, { id: 'home', url: 'http://x/a2a', token: 'short' })).toThrow(/at least 16/)
  })
})

describe('listPairings (role classification)', () => {
  it('classifies hands (exec), brains (unused sentinel), and other agents', () => {
    addHand(stateDir, { id: 'home', url: 'http://home/a2a', name: '家里', token: TOKEN })   // hand
    acceptBrain(stateDir, { brainId: 'office-brain', token: TOKEN })                         // brain
    // a plain notify-only agent
    createA2ARegistry({ stateDir }).add({
      id: 'pager', name: 'pager', url: 'https://pager/a2a',
      inbound_api_key: TOKEN, outbound_api_key: 'real-key', capabilities: ['notify'], paused: false,
      transport: 'push', may_exec: false,
    })
    const p = listPairings(stateDir)
    expect(p.hands.map(h => h.id)).toEqual(['home'])
    expect(p.hands[0]!.name).toBe('家里')
    expect(p.brains.map(b => b.id)).toEqual(['office-brain'])
    expect(p.others.map(o => o.id)).toEqual(['pager'])
  })

  it('returns empty groups for an empty registry', () => {
    const p = listPairings(stateDir)
    expect(p).toEqual({ hands: [], brains: [], others: [] })
  })
})

describe('acceptBrain (hand side)', () => {
  it('registers the brain so the hand verifies its exec calls', () => {
    acceptBrain(stateDir, { brainId: 'wechat-cc', token: TOKEN })
    const reg = createA2ARegistry({ stateDir })
    // This is exactly the check /a2a/exec runs on an inbound brain call:
    expect(reg.verifyBearer('wechat-cc', TOKEN)).not.toBeNull()
    expect(reg.verifyBearer('wechat-cc', 'wrong-token-0123456789')).toBeNull()
  })

  it('rejects a short token', () => {
    expect(() => acceptBrain(stateDir, { brainId: 'wechat-cc', token: 'short' })).toThrow(/at least 16/)
  })
})

describe('end-to-end record match', () => {
  it('the brain token (outbound) matches what the hand verifies (inbound)', () => {
    // Brain machine:
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    // Hand machine:
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    try {
      addHand(brainDir, { id: 'home', url: 'http://home/a2a', token: TOKEN })
      acceptBrain(handDir, { brainId: 'wechat-cc', token: TOKEN })
      const brainSendsBearer = createA2ARegistry({ stateDir: brainDir }).get('home')!.outbound_api_key
      // The hand verifies the brain's call with id='wechat-cc' + that bearer:
      expect(createA2ARegistry({ stateDir: handDir }).verifyBearer('wechat-cc', brainSendsBearer)).not.toBeNull()
    } finally {
      rmSync(brainDir, { recursive: true, force: true })
      rmSync(handDir, { recursive: true, force: true })
    }
  })
})

describe('smooth pairing (invite code) end-to-end', () => {
  let brainDir: string
  let handDir: string
  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    handDir = mkdtempSync(join(tmpdir(), 'hand-'))
  })
  afterEach(() => {
    rmSync(brainDir, { recursive: true, force: true })
    rmSync(handDir, { recursive: true, force: true })
  })

  /** Spin up a hand's A2A server with /a2a/pair wired exactly like bootstrap. */
  async function startHand() {
    const handRegistry = createA2ARegistry({ stateDir: handDir })
    const server = createA2AServer({
      host: '127.0.0.1', port: 0,
      registry: handRegistry,
      onNotify: vi.fn(async () => {}),
      onPair: async ({ secret, brainId, execKey }) => {
        if (!verifyAndConsumeInvite(handDir, secret, Date.now())) return { ok: false, error: 'invalid_or_expired_invite' }
        const existing = handRegistry.get(brainId)
        if (existing) handRegistry.update(brainId, { inbound_api_key: execKey })
        else handRegistry.add({
          id: brainId, name: brainId, url: 'http://brain.local/a2a',
          inbound_api_key: execKey, outbound_api_key: 'unused', capabilities: [], paused: false,
          transport: 'push', may_exec: false,
        })
        return { ok: true }
      },
      daemonInfo: { name: 'wechat-cc', version: 'test' },
    })
    await server.start()
    return { server, handRegistry, handUrl: `${server.baseUrl()}/a2a` }
  }

  it('mint on hand → join on brain auto-registers both sides with the same exec key', async () => {
    const { server, handRegistry, handUrl } = await startHand()
    try {
      const { code } = mintInvite(handDir, { handUrl, nowMs: Date.now() })
      const r = await joinHand(brainDir, { code, id: 'home', name: '家里', selfId: 'wechat-cc' })
      expect(r.ok).toBe(true)

      const brainSide = createA2ARegistry({ stateDir: brainDir }).get('home')
      const handSide = handRegistry.get('wechat-cc')
      expect(brainSide).toBeTruthy()
      expect(handSide).toBeTruthy()
      // The key the brain presents (outbound) === the key the hand verifies (inbound).
      expect(brainSide!.outbound_api_key).toBe(handSide!.inbound_api_key)
      expect(brainSide!.url).toBe(handUrl)
      expect(brainSide!.name).toBe('家里')
      expect(brainSide!.capabilities).toContain('exec')
      // And that key actually authenticates an inbound exec call:
      expect(handRegistry.verifyBearer('wechat-cc', brainSide!.outbound_api_key)).not.toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('rejects a second join with the same code (single-use) and rolls back the brain record', async () => {
    const { server, handUrl } = await startHand()
    try {
      const { code } = mintInvite(handDir, { handUrl, nowMs: Date.now() })
      expect((await joinHand(brainDir, { code, id: 'home', selfId: 'wechat-cc' })).ok).toBe(true)

      const second = await joinHand(brainDir, { code, id: 'home2', selfId: 'wechat-cc' })
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/invalid_or_expired_invite/)
      expect(createA2ARegistry({ stateDir: brainDir }).get('home2')).toBeNull()  // no half-paired record
    } finally {
      await server.stop()
    }
  })

  it('fails cleanly when the hand is unreachable, leaving no brain record', async () => {
    const { code } = mintInvite(handDir, { handUrl: 'http://127.0.0.1:1/a2a', nowMs: Date.now() })
    const r = await joinHand(brainDir, { code, id: 'home', selfId: 'wechat-cc', timeoutMs: 1000 })
    expect(r.ok).toBe(false)
    expect(createA2ARegistry({ stateDir: brainDir }).get('home')).toBeNull()
  })
})

describe('pingHands (reachability)', () => {
  let brainDir: string
  beforeEach(() => { brainDir = mkdtempSync(join(tmpdir(), 'brain-ping-')) })
  afterEach(() => { rmSync(brainDir, { recursive: true, force: true }) })

  it('reports a reachable, exec-advertising hand as ✅ and a dead one as ❌', async () => {
    // A live hand whose Agent Card advertises exec (onExec wired).
    const server = createA2AServer({
      host: '127.0.0.1', port: 0,
      registry: createA2ARegistry({ stateDir: mkdtempSync(join(tmpdir(), 'h-')) }),
      onNotify: vi.fn(async () => {}),
      onExec: vi.fn(async () => ({ ok: true as const, response: 'ok' })),
      daemonInfo: { name: 'wechat-cc', version: '9.9.9' },
    })
    await server.start()
    try {
      addHand(brainDir, { id: 'home', url: `${server.baseUrl()}/a2a`, name: '家里', token: 'shared-secret-0123456789' })
      addHand(brainDir, { id: 'dead', url: 'http://127.0.0.1:1/a2a', name: '死的', token: 'shared-secret-0123456789' })

      const results = await pingHands(brainDir, { timeoutMs: 1500 })
      const home = results.find(r => r.id === 'home')!
      const dead = results.find(r => r.id === 'dead')!
      expect(home.ok).toBe(true)
      expect(home.detail).toContain('wechat-cc')
      expect(home.detail).toContain('9.9.9')
      expect(dead.ok).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('filters to a specific hand by name', async () => {
    addHand(brainDir, { id: 'home', url: 'http://127.0.0.1:1/a2a', name: '家里', token: 'shared-secret-0123456789' })
    addHand(brainDir, { id: 'office', url: 'http://127.0.0.1:1/a2a', name: '公司', token: 'shared-secret-0123456789' })
    const results = await pingHands(brainDir, { filter: '公司', timeoutMs: 800 })
    expect(results.map(r => r.id)).toEqual(['office'])
  })
})

// 2026-09-02:`hand join <码>` 不再要求 --id/--name —— 手那台自己知道它叫
// 什么,名字随邀请码带过来。用户少想一个 slug、少记两个参数。
describe('joinHand —— id/name 从邀请码里推', () => {
  it('不给 --id → 用机器名推出的 slug 注册', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    const { code } = mintInvite(handDir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now(), handName: 'MacBook-Pro.local' })
    const r = await joinHand(brainDir, { code, selfId: 'wechat-cc', timeoutMs: 50 })
    // 网络必然失败(没有真的手在听),但 id 的推导在发请求之前就完成了
    expect(r.id).toBe('macbook-pro')
  })

  it('显式 --id 覆盖推导结果', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    const { code } = mintInvite(handDir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now(), handName: 'MacBook-Pro' })
    const r = await joinHand(brainDir, { code, id: 'laptop', selfId: 'wechat-cc', timeoutMs: 50 })
    expect(r.id).toBe('laptop')
  })

  it('机器名推不出合法 slug(纯中文)→ 明说要 --id,不替用户编一个', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    const { code } = mintInvite(handDir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now(), handName: '我的旧电脑' })
    await expect(joinHand(brainDir, { code, selfId: 'wechat-cc', timeoutMs: 50 }))
      .rejects.toThrow(/--id/)
  })

  it('老版本的码(没带机器名)→ 同样明说要 --id', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    const { code } = mintInvite(handDir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now() })
    await expect(joinHand(brainDir, { code, selfId: 'wechat-cc', timeoutMs: 50 }))
      .rejects.toThrow(/--id/)
  })
})

// 2026-09-02:配一台手此前要 4 条命令,其中最贵的是第一步 ——
// `daemon a2a enable --host <你得自己知道的IP>`,用户先得搞懂「为什么
// 127.0.0.1 不行」。`hand invite` 现在自己把前三步做完;这里测的是**决策**
// 部分(纯函数),I/O 留给 CLI。
describe('planHandInvite —— 一条命令要不要先开监听/重启', () => {
  const tail = { host: '100.101.102.103', why: 'tailscale' as const }
  const lan = { host: '10.84.6.254', why: 'lan' as const }

  it('已经开在可达地址上 → 直接出码,不重启', () => {
    expect(planHandInvite({ info: { enabled: true, base_url: 'http://10.84.6.254:8717' }, pick: lan }))
      .toEqual({ action: 'ready', handUrl: 'http://10.84.6.254:8717/a2a' })
  })

  it('没开 → 挑地址、开、重启', () => {
    expect(planHandInvite({ info: null, pick: tail }))
      .toEqual({ action: 'enable', host: '100.101.102.103', port: 8717, why: 'tailscale' })
  })

  it('开在回环上 = 等于没开(配对会成功、派活永远失败)→ 重开到可达地址', () => {
    expect(planHandInvite({ info: { enabled: true, base_url: 'http://127.0.0.1:8717' }, pick: lan }))
      .toEqual({ action: 'enable', host: '10.84.6.254', port: 8717, why: 'lan' })
  })

  it('开在 0.0.0.0 上也算不可达(对端拿到这个地址连不了)', () => {
    expect(planHandInvite({ info: { enabled: true, base_url: 'http://0.0.0.0:8717' }, pick: lan }).action)
      .toBe('enable')
  })

  it('挑不出地址 → no_address,**明说**,绝不悄悄用回环', () => {
    expect(planHandInvite({ info: null, pick: null })).toEqual({ action: 'no_address' })
  })

  it('--host 覆盖:即使已经开着,也按用户给的重开', () => {
    expect(planHandInvite({ info: { enabled: true, base_url: 'http://10.0.0.1:8717' }, pick: lan, host: '100.1.2.3' }))
      .toEqual({ action: 'enable', host: '100.1.2.3', port: 8717, why: 'override' })
  })

  it('--host 跟当前已开的完全一致 → 不用白重启一次', () => {
    expect(planHandInvite({ info: { enabled: true, base_url: 'http://100.1.2.3:8717' }, pick: lan, host: '100.1.2.3' }))
      .toEqual({ action: 'ready', handUrl: 'http://100.1.2.3:8717/a2a' })
  })

  it('自定义端口', () => {
    expect(planHandInvite({ info: null, pick: lan, port: 9001 }))
      .toEqual({ action: 'enable', host: '10.84.6.254', port: 9001, why: 'lan' })
  })
})
