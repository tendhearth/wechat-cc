import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeLetterStore } from '../../core/penpal-letter-store'
import { makeMessagesStore } from '../../lib/messages-store'
import { socialRoutes } from './routes-social'
import { makeRoutes } from './routes'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()

describe('GET /v1/social/relationships —— 四种对方一张表', () => {
  it('registry 对端(去掉手)+ 信道 + 邻居 + 来过的人', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rel-'))
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ default_chat_id: 'owner@im.wechat' }))
    writeFileSync(join(stateDir, 'companion', 'neighbors.json'), JSON.stringify({ lastId: 'ayou', introduced: true, notes: { ayou: { at: '2026-09-02T00:00:00Z', note: '聊了豆子', visits: 2 } } }))
    const db = openDb({ path: ':memory:' })
    const channelStore = makeChannelStore(db)
    const letterStore = makeLetterStore(db)
    channelStore.create({ id: 'ch1', seekId: 's', myPrivkey: 'a', myPubkey: 'b', myChannelId: 'mine', degree: 1, relayVia: null, peerAgentId: 'cc-b' })
    channelStore.setStatus('ch1', 'open')
    letterStore.create({ id: 'l1', channelId: 'ch1', direction: 'in', sealedCiphertext: '', nonce: 'n', tag: 't', plaintext: '', kind: 'visit', payload: { id: 'v1', round: 2, max: 6, text: 'x' } })
    const ms = makeMessagesStore(db)
    await ms.append({ id: 'm1', chatId: 'friend@im.wechat', ts: '2026-09-04T01:00:00Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    await ms.append({ id: 'm2', chatId: 'owner@im.wechat', ts: '2026-09-04T02:00:00Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })

    const deps = {
      stateDir, db,
      a2a: { registry: { list: () => [
        { id: 'cc-b', name: '老王的 bot', capabilities: [], transport: 'mailbox', paused: false },
        { id: 'win', name: '公司那台', capabilities: ['exec'], transport: 'push', paused: false },   // 手,不该出现
      ] } },
      social: { penpal: { channelStore, letterStore } },
    } as unknown as InternalApiDeps
    const r = await socialRoutes(deps)['GET /v1/social/relationships']!(qs(), undefined)
    expect(r.status).toBe(200)
    const rels = (r.body as { relationships: Array<{ id: string; kind: string; label: string; autoVisit: boolean; familiarity: { visits: number } }> }).relationships
    const ids = rels.map(x => x.id)
    expect(ids).toContain('peer:cc-b')
    expect(ids).not.toContain('peer:win')            // 手是设备
    expect(ids).toContain('neighbor:ayou')
    expect(ids).toContain('human:friend@im.wechat')
    expect(ids).not.toContain('human:owner@im.wechat') // 主人自己不算
    const peer = rels.find(x => x.id === 'peer:cc-b')!
    expect(peer.autoVisit).toBe(true)                 // 对端回过串门信
    expect(peer.familiarity.visits).toBe(1)
    expect(rels.find(x => x.id === 'neighbor:ayou')!.familiarity.visits).toBe(2)
  })

  it('没接 db / social 也不炸 —— 至少有邻居', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rel-'))
    const r = await socialRoutes({ stateDir } as unknown as InternalApiDeps)['GET /v1/social/relationships']!(qs(), undefined)
    const rels = (r.body as { relationships: Array<{ kind: string }> }).relationships
    expect(rels.length).toBeGreaterThan(0)
    expect(rels.every(x => x.kind === 'neighbor')).toBe(true)
  })

  it('POST /v1/social/visit 起跑就回,不等两三分钟', async () => {
    let called: string | undefined = 'unset'
    const deps = { stateDir: '/tmp', social: { penpal: { startVisit: async (t?: string) => { called = t; await new Promise(r => setTimeout(r, 50)); return { ok: true, id: 'v', channel: 'c' } } } } } as unknown as InternalApiDeps
    const t0 = Date.now()
    const r = await socialRoutes(deps)['POST /v1/social/visit']!(qs(), { target: '阿柚' })
    expect(Date.now() - t0).toBeLessThan(40)
    expect(r.body).toEqual({ ok: true, started: true })
    expect(called).toBe('阿柚')
    expect((await socialRoutes(deps)['POST /v1/social/visit']!(qs(), { target: 42 })).status).toBe(400)
    expect((await socialRoutes({ stateDir: '/tmp' } as unknown as InternalApiDeps)['POST /v1/social/visit']!(qs(), {})).status).toBe(503)
  })

  it('接线 + 分级 trusted', () => {
    const table = makeRoutes({ deps: { stateDir: '/tmp', daemonPid: 1 } as unknown as InternalApiDeps, getDelegate: () => null, maybePrefix: (_c: string, t: string) => t })
    expect(Object.keys(table)).toContain('GET /v1/social/relationships')
    expect(Object.keys(table)).toContain('POST /v1/social/visit')
    expect(minTierFor('GET /v1/social/relationships')).toBe('trusted')
    expect(minTierFor('POST /v1/social/visit')).toBe('trusted')
  })
})
