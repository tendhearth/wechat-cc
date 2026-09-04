import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../lib/db'
import { makeJournal } from '../../core/journal-store'
import { readJournalSeen } from '../../core/journal-seen'
import { journalRoutes } from './routes-journal'
import { minTierFor } from './route-tiers'
import { makeRoutes } from './routes'
import type { InternalApiDeps } from './types'

const qs = (s = '') => new URLSearchParams(s)

let deps: InternalApiDeps
let routes: ReturnType<typeof journalRoutes>
beforeEach(() => {
  const db = openDb({ path: ':memory:' })
  const hunt = makeJournal(db)
  hunt.recordHunt({ chatId: 'owner', text: '看这个 https://a.com/x' })
  deps = { hunt } as unknown as InternalApiDeps
  routes = journalRoutes(deps)
})

describe('GET /v1/journal', () => {
  it('列出战利品', async () => {
    const r = await routes['GET /v1/journal']!(qs(), undefined)
    expect(r.status).toBe(200)
    expect((r.body as { items: unknown[] }).items).toHaveLength(1)
  })

  it('limit 有上界,且垃圾值回落到默认(不是 NaN LIMIT)', async () => {
    for (const q of ['limit=99999', 'limit=abc', 'limit=-3', '']) {
      const r = await routes['GET /v1/journal']!(qs(q), undefined)
      expect(r.status).toBe(200)
    }
  })

  it('**没接 store → 503,不是空清单** —— 空清单会被读成「CC 什么都没打到」', async () => {
    const r = await journalRoutes({} as InternalApiDeps)['GET /v1/journal']!(qs(), undefined)
    expect(r.status).toBe(503)
  })
})

describe('POST /v1/journal/status', () => {
  const idOf = async () => {
    const r = await routes['GET /v1/journal']!(qs(), undefined)
    return (r.body as { items: Array<{ id: string }> }).items[0]!.id
  }

  it('改成 using', async () => {
    const r = await routes['POST /v1/journal/status']!(qs(), { id: await idOf(), status: 'using' })
    expect(r.body).toEqual({ ok: true })
  })

  it('不认识的状态 → 400,并告诉调用方允许哪些', async () => {
    const r = await routes['POST /v1/journal/status']!(qs(), { id: await idOf(), status: '在用' })
    expect(r.status).toBe(400)
    expect((r.body as { allowed: string[] }).allowed).toContain('using')
  })

  it('缺 id → 400', async () => {
    expect((await routes['POST /v1/journal/status']!(qs(), { status: 'using' })).status).toBe(400)
  })

  it('**id 不存在 → ok:false,不是静默 200 成功**', async () => {
    const r = await routes['POST /v1/journal/status']!(qs(), { id: 'gone', status: 'using' })
    expect(r.body).toEqual({ ok: false })
  })
})

describe('POST /v1/journal/remove', () => {
  it('删掉后就不在清单里了', async () => {
    const list = await routes['GET /v1/journal']!(qs(), undefined)
    const id = (list.body as { items: Array<{ id: string }> }).items[0]!.id
    expect((await routes['POST /v1/journal/remove']!(qs(), { id })).body).toEqual({ ok: true })
    const after = await routes['GET /v1/journal']!(qs(), undefined)
    expect((after.body as { items: unknown[] }).items).toHaveLength(0)
  })
})

describe('接线', () => {
  it('**三个路由真的进了总路由表** —— 写了一个路由文件却忘了 spread 进去,是不会有任何报错的', () => {
    // 今天早上 .sig 就是这么丢的:上游产出了、下游认得它,中间一层没接。
    const table = makeRoutes({
      deps: { stateDir: '/tmp', daemonPid: 1 } as unknown as InternalApiDeps,
      getDelegate: () => null,
      maybePrefix: (_c: string, t: string) => t,
    })
    for (const r of ['GET /v1/journal', 'POST /v1/journal/status', 'POST /v1/journal/remove']) {
      expect(Object.keys(table)).toContain(r)
    }
  })
})

describe('分级', () => {
  it('三个路由都是 trusted —— 桌面端的凭证是 FILE token,admin 会让每次真实读 403', () => {
    for (const r of ['GET /v1/journal', 'POST /v1/journal/status', 'POST /v1/journal/remove']) {
      expect(minTierFor(r)).toBe('trusted')
    }
  })
})

describe('POST /v1/journal/seen —— 主人打开觅食台,水位推到现在', () => {
  it('写水位文件并返回 seen_until;之后 summary 归零', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'jroute-'))
    const db = openDb({ path: ':memory:' })
    const hunt = makeJournal(db)
    hunt.recordHunt({ chatId: 'owner', text: '看这个 https://a.com/x' })
    const r = await journalRoutes({ hunt, stateDir } as unknown as InternalApiDeps)['POST /v1/journal/seen']!(qs(), undefined)
    expect(r.status).toBe(200)
    const body = r.body as { ok: boolean; seen_until: string }
    expect(body.ok).toBe(true)
    expect(readJournalSeen(stateDir)).toBe(body.seen_until)
    expect(hunt.summary(body.seen_until).unread).toBe(0)
  })
  it('tier 是 trusted(桌面 FILE token 能打;admin 会让桌面 403)', () => {
    expect(minTierFor('POST /v1/journal/seen')).toBe('trusted')
  })
})
