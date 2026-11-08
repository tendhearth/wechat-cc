import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { topicRoutes } from './topic-routes'
import { ROUTES } from '@wechat-cc/protocol/routes'

describe('POST /v1/memory/topics/search', () => {
  it('路由表里是 admin、挂在 memory 下;admin 才给,query 要合法', async () => {
    expect(ROUTES['POST /v1/memory/topics/search']).toEqual({ module: 'memory', desktop: { tier: 'admin' } })
    const db = openTestDb()
    const threads = makeThreadsStore(db)
    const t = await threads.create({ chatId: 'owner', title: 'bx', summary: '网络工具', facets: ['task'], tags: [], private: false, episodes: [] })
    await threads.addEntry({ threadId: t, kind: 'decision', line: 'UDP 走 hysteria2' })
    const h = topicRoutes({ db, ownerChatId: () => 'owner' })['POST /v1/memory/topics/search']!
    const r = await h(new URLSearchParams(), { query: 'bx UDP' }, { tier: 'admin', origin: 'session', chatId: 'owner' } as never)
    expect(r.status).toBe(200)
    expect((r.body as { topics: Array<{ title: string }> }).topics.map(x => x.title)).toEqual(['bx'])
    expect((await h(new URLSearchParams(), { query: 'bx' }, { tier: 'trusted', origin: 'session', chatId: 'owner' } as never)).status).toBe(403)
    expect((await h(new URLSearchParams(), { query: '' }, { tier: 'admin', origin: 'session' } as never)).status).toBe(400)
    expect((await h(new URLSearchParams(), {}, { tier: 'admin', origin: 'session' } as never)).status).toBe(400)
  })
})
