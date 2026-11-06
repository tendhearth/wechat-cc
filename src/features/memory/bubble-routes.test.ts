import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { bubbleRoutes } from './bubble-routes'
import { topicRoutes } from './topic-routes'
import { topicsProjection } from './topic-projection'
import { makePhoneEventsWiring } from '../phone/phone-topic-sources'
import { TopicDetailResponse, TopicsListResponse, TopicOpenResponse, TopicsSnapshot } from '../../../packages/protocol/src/topic-bubbles'

const operator = { tier: 'admin', origin: 'operator' } as const
async function fixture() {
  const db = openTestDb(), threads = makeThreadsStore(db)
  let owner: string | null = 'owner'
  const id = await threads.create({ chatId: 'owner', title: '服务器', summary: '家里的备份', facets: ['task'], tags: [], private: true, episodes: [] })
  const routes = bubbleRoutes({ db, ownerChatId: () => owner })
  const call = async (key: string, query = '', body: unknown = null, caller: unknown = operator) => routes[key]!(new URLSearchParams(query), body, caller as never)
  return { db, threads, id, routes, call, setOwner: (value: string | null) => { owner = value } }
}
describe('T4 owner routes and topics projection', () => {
  it('列表/详情/订阅只读;只有 owner 表面可看 private,不同 owner id 同为404', async () => {
    const { db, threads, id, call, setOwner } = await fixture()
    const other = await threads.create({ chatId: 'guest', title: '他人的秘密', summary: '', facets: [], tags: [], private: true, episodes: [] })
    const list = TopicsListResponse.parse((await call('GET /v1/memory/topics')).body)
    expect(list.topics.map(t => t.id)).toEqual([id])
    expect(list.topics[0]?.bubbleState).toBe('closed')
    expect(TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail', `id=${id}`)).body).topic.id).toBe(id)
    expect(TopicsSnapshot.parse((await call('GET /v1/subscribe/topics', 'wait_ms=0')).body).openIds).toEqual([])
    expect(db.query('SELECT * FROM topic_bubbles').all()).toEqual([])
    for (const caller of [{ tier: 'trusted', origin: 'file' }, { tier: 'admin', origin: 'file' }, { tier: 'admin', origin: 'session', chatId: 'owner' }, { tier: 'admin', origin: 'session', chatId: 'guest' }, { tier: 'admin', origin: 'link' }, undefined]) {
      for (const key of ['GET /v1/memory/topics', 'GET /v1/memory/topics/detail', 'POST /v1/memory/topics/open', 'GET /v1/subscribe/topics']) {
        const r = await call(key, `id=${id}`, { id, requestId: 'test' }, caller ?? null)
        expect(r.status).toBe(403)
        expect(JSON.stringify(r.body)).not.toContain('服务器')
      }
    }
    expect((await call('GET /v1/memory/topics/detail', `id=${other}`)).body).toEqual((await call('GET /v1/memory/topics/detail', 'id=missing')).body)
    expect((await call('GET /v1/memory/topics', '', null, { tier: 'admin', origin: 'device' })).status).toBe(200)
    setOwner(null)
    expect((await call('GET /v1/memory/topics')).status).toBe(404)
    db.close()
  })
  it('默认6个、recent最多8;详情分区有界分页,cursor绑定区/话题/owner/版本,当前live引用才标记', async () => {
    const { db, threads, id, call, setOwner } = await fixture()
    for (let n = 0; n < 9; n++) await threads.create({ chatId: 'owner', title: `topic${n}`, summary: '', facets: [], tags: [], private: false, episodes: [] })
    expect(TopicsListResponse.parse((await call('GET /v1/memory/topics')).body).topics).toHaveLength(6)
    expect(TopicsListResponse.parse((await call('GET /v1/memory/topics', 'limit=50')).body).topics).toHaveLength(8)
    const ids: string[] = []
    for (let n = 0; n < 7; n++) ids.push(await threads.addEntry({ threadId: id, kind: 'decision', line: `备份${n}` }))
    makeTopicBubbles(db).adopt('owner', 'recall', 'recall', [{ id, entryIds: [ids[0]!] }])
    const first = TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail', `id=${id}`)).body)
    expect(first.entries).toHaveLength(4)
    expect(first.entries.find(e => e.id === ids[0])?.recalled).toBe(true)
    expect(first.pages.entries.total).toBe(7)
    const cursor = first.pages.entries.nextCursor!
    const next = TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail', `id=${id}&section=entries&cursor=${cursor}`)).body)
    expect(next.entries).toHaveLength(3)
    expect(next.entries.some(e => first.entries.some(a => a.id === e.id))).toBe(false)
    expect((await call('GET /v1/memory/topics/detail', `id=${id}&section=messages&cursor=${cursor}`)).status).toBe(400)
    expect((await call('GET /v1/memory/topics/detail', `id=${id}&section=entries&cursor=${cursor}x`)).status).toBe(400)
    await threads.updateEntry(ids[0]!, { status: 'superseded' })
    const refreshed = TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail', `id=${id}`)).body)
    expect(refreshed.entries.some(e => e.recalled)).toBe(false)
    expect((await call('GET /v1/memory/topics/detail', `id=${id}&section=entries&cursor=${cursor}`)).status).toBe(400)
    setOwner('guest')
    expect((await call('GET /v1/memory/topics', `view=all&cursor=${TopicsListResponse.parse((await call('GET /v1/memory/topics', 'view=all')).body).nextCursor ?? 'bad'}`)).status).toBe(400)
    db.close()
  })
  it('open幂等不发聊天;长轮询与hub看到详情变更,不只id变化;消息不越chat', async () => {
    const { db, threads, id, call, routes } = await fixture()
    const result = TopicOpenResponse.parse((await call('POST /v1/memory/topics/open', '', { id, requestId: 'click' })).body)
    expect(result.bubbleState).toBe('open')
    expect(TopicOpenResponse.parse((await call('POST /v1/memory/topics/open', '', { id, requestId: 'click' })).body)).toEqual(result)
    expect(db.query('SELECT * FROM messages').all()).toEqual([])
    const entry = await threads.addEntry({ threadId: id, kind: 'fact', line: '备份在家' })
    const hub = makePhoneEventsWiring({ home: async () => ({}) as never, topics: async () => (await topicsProjection(db, 'owner')).summary })
    const frames: unknown[] = []
    const off = hub.events.subscribe('topics', undefined, ev => frames.push(ev.data))
    await expect.poll(() => frames.length).toBe(1)
    const snapshot = TopicsSnapshot.parse(frames[0])
    const controller = new AbortController()
    const pending = routes['GET /v1/subscribe/topics']!(new URLSearchParams({ since: snapshot.revision, wait_ms: '1000' }), null, operator, { signal: controller.signal, onSent() {} })
    await threads.updateEntry(entry, { body: '新的细节' })
    const changed = TopicsSnapshot.parse((await pending).body)
    expect(changed.revision).not.toBe(snapshot.revision)
    expect(changed.openIds).toEqual(snapshot.openIds)
    hub.events.poke()
    await expect.poll(() => frames.length).toBe(2)
    const messages = makeMessagesStore(db)
    await messages.append({ id: 'other', chatId: 'guest', ts: '2026-11-06T00:00:00Z', direction: 'in', kind: 'text', text: '绝不能看', source: 'wechat' })
    makeTopicBubbles(db).adopt('owner', 'r2', 'recall', [{ id, messageIds: ['other'] }])
    expect(TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail', `id=${id}`)).body).messages).toEqual([])
    off(); hub.dispose(); db.close()
  })
  it('topic_search只有成功返回主人正在跑的轮后开泡泡,后台/未送出/迟到都不算', async () => {
    const { db, threads, id } = await fixture()
    await threads.addEntry({ threadId: id, kind: 'fact', line: '服务器备份' })
    const matter = makeMatterStore(db).ensureChat('owner'), log = makeMatterLog(db)
    const turn = log.startTurn({ matterId: matter.id, executor: 'claude', policy: { alias: 'main' } })
    const handler = topicRoutes({ db, ownerChatId: () => 'owner' })['POST /v1/memory/topics/search']!
    const sent: Array<() => void> = []
    const ctx = { signal: new AbortController().signal, onSent: (cb: () => void) => sent.push(cb) }
    await handler(new URLSearchParams(), { query: '服务器' }, { tier: 'admin', origin: 'file' }, ctx)
    expect(sent).toHaveLength(0)
    await handler(new URLSearchParams(), { query: '服务器' }, { tier: 'admin', origin: 'session', chatId: 'owner', sessionKey: 'claude/main/owner' }, ctx)
    expect(makeTopicBubbles(db).get(id)).toBeNull()
    expect(sent).toHaveLength(1)
    sent[0]!()
    expect(makeTopicBubbles(db).get(id)?.state).toBe('open')
    const sleep = makeTopicBubbles(db).beginSleep('owner', 'sleep')
    makeTopicBubbles(db).closeAfterSleep(sleep)
    sent[0]!()
    expect(makeTopicBubbles(db).get(id)?.state).toBe('closed')
    await handler(new URLSearchParams(), { query: '备份' }, { tier: 'admin', origin: 'session', chatId: 'owner', sessionKey: 'claude/main/owner' }, ctx)
    log.finishTurn(turn.id, { status: 'completed' })
    sent[1]!()
    expect(makeTopicBubbles(db).get(id)?.state).toBe('closed')
    db.close()
  })
})
