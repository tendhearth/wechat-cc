import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeJournal } from '../../core/journal-store'
import { writeJournalSeen } from '../../core/journal-seen'
import { presenceRoutes } from './routes-presence'
import { minTierFor } from './route-tiers'
import { PresenceResponse } from './schema'
import type { InternalApiDeps } from './types'

const qs = () => new URLSearchParams()
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

/** 把 default_chat_id 写进 companion 配置(loadCompanionConfig 读 <stateDir>/companion/config.json)。 */
function writeOwnerChat(stateDir: string, chatId: string): void {
  mkdirSync(join(stateDir, 'companion'), { recursive: true })
  writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ default_chat_id: chatId }), 'utf8')
}

const session = (chatId: string) => ({ alias: 'a', path: '/p', providerId: 'claude', chatId, lastUsedAt: NOW })

function deps(over: Partial<InternalApiDeps> = {}): InternalApiDeps {
  const stateDir = mkdtempSync(join(tmpdir(), 'presence-'))
  const hunt = makeJournal(openDb({ path: ':memory:' }))
  return {
    stateDir, hunt,
    listSessions: () => [],
    busyLabels: () => [],
    subsystems: () => [],
    outbound: () => ({ state: 'ok', consecutiveFailures: 0, lastOkAt: null, lastError: null }),
    ...over,
  } as unknown as InternalApiDeps
}

describe('GET /v1/companion/presence', () => {
  it('形状对 zod;一切安静 → ok / idle / 0', async () => {
    const r = await presenceRoutes(deps())['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.status).toBe(200)
    expect(PresenceResponse.safeParse(r.body).success).toBe(true)
    expect(r.body).toMatchObject({ presence: 'ok', activity: { kind: 'idle' }, news: { unread: 0 } })
  })

  it('把每个 deps 信号都喂进推导:busy hunt → foraging;journal 一条没看 → unread 1', async () => {
    const d = deps({ busyLabels: () => ['hunt'] })
    d.hunt!.recordHunt({ chatId: 'o', text: '看这个 https://a.com/x' })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.body).toMatchObject({ activity: { kind: 'foraging' }, news: { unread: 1, latest_kind: 'hunt' } })
  })

  it('水位之后 unread 归零', async () => {
    const d = deps()
    d.hunt!.recordHunt({ chatId: 'o', text: '看这个 https://a.com/x', nowIso: '2026-09-01T00:00:00.000Z' })
    writeJournalSeen(d.stateDir, '2026-09-02T00:00:00.000Z')
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { news: { unread: number } }).news.unread).toBe(0)
  })

  it('串门登记 → visiting;外发 degraded → offline;子系统 degraded → degraded', async () => {
    const d = deps({
      social: { penpal: { activeVisit: () => ({ id: 'v', peerLabel: '邻居「阿柚」', hosting: false, sinceMs: NOW }) } } as never,
      outbound: () => ({ state: 'degraded', consecutiveFailures: 3, lastOkAt: null, lastError: 'x' }) as never,
    })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.body).toMatchObject({ presence: 'offline', activity: { kind: 'visiting' } })
    const d2 = deps({ subsystems: () => [{ name: 'x', state: 'degraded', sinceIso: 'now' }] as never })
    expect((await presenceRoutes(d2)['GET /v1/companion/presence']!(qs(), undefined)).body).toMatchObject({ presence: 'degraded' })
  })

  it('没配 default_chat_id 时,有入站的活跃会话算客人', async () => {
    const d = deps({ listSessions: () => [session('someone')], latestInboundTs: async () => iso(NOW - 1000) })
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { activity: { kind: string } }).activity.kind).toBe('hosting_human')
  })

  it('default_chat_id 的会话刚收到主人消息 → chatting', async () => {
    const d = deps({ listSessions: () => [session('owner-chat')], latestInboundTs: async () => iso(NOW - 1000) })
    writeOwnerChat(d.stateDir, 'owner-chat')
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { activity: { kind: string } }).activity.kind).toBe('chatting')
  })

  it('同一个会话,主人 10 分钟没说话 → idle(伙伴自己的外发 bump 了 lastUsedAt 也不算在聊)', async () => {
    const d = deps({ listSessions: () => [session('owner-chat')], latestInboundTs: async () => iso(NOW - 10 * 60_000) })
    writeOwnerChat(d.stateDir, 'owner-chat')
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { activity: { kind: string } }).activity.kind).toBe('idle')
  })

  it('没接 latestInboundTs → 没有入站证据,不算在聊', async () => {
    const d = deps({ listSessions: () => [session('owner-chat')] })
    writeOwnerChat(d.stateDir, 'owner-chat')
    const r = await presenceRoutes(d)['GET /v1/companion/presence']!(qs(), undefined)
    expect((r.body as { activity: { kind: string } }).activity.kind).toBe('idle')
  })

  it('没接 journal → 503(和 /v1/journal 同姿势:空不是 0)', async () => {
    const r = await presenceRoutes(deps({ hunt: undefined }))['GET /v1/companion/presence']!(qs(), undefined)
    expect(r.status).toBe(503)
  })

  it('tier 是 trusted', () => {
    expect(minTierFor('GET /v1/companion/presence')).toBe('trusted')
  })
})
