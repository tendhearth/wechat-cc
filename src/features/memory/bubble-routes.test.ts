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

it('历史话题搜索在 owner 内先搜索再分页；cursor不能换搜索词，不因搜索而打开泡泡',async()=>{
 const {db,threads,call}=await fixture()
 const a=await threads.create({chatId:'owner',title:'旧备份 A',summary:'',facets:[],tags:[],private:true,episodes:[]})
 await threads.create({chatId:'owner',title:'旧备份 B',summary:'',facets:[],tags:[],private:true,episodes:[]})
 await threads.create({chatId:'guest',title:'旧备份 秘密',summary:'',facets:[],tags:[],private:true,episodes:[]})
 const first=TopicsListResponse.parse((await call('GET /v1/memory/topics','view=all&q=旧备份&limit=1')).body)
 expect(first.topics).toHaveLength(1);expect(first.nextCursor).not.toBeNull()
 const next=TopicsListResponse.parse((await call('GET /v1/memory/topics','view=all&q=旧备份&limit=1&cursor='+encodeURIComponent(first.nextCursor!))).body)
 expect(new Set([...first.topics,...next.topics].map(t=>t.id)).size).toBe(2);expect(next.nextCursor).toBeNull();expect(JSON.stringify([first,next])).not.toContain('秘密')
 expect((await call('GET /v1/memory/topics','view=all&q=其他&cursor='+encodeURIComponent(first.nextCursor!))).status).toBe(400)
 expect(db.query('SELECT * FROM topic_bubbles WHERE thread_id=?').get(a)).toBeNull();db.close()
})

it('T5d merge aliases preserve chains and owner scope with canonical matter routes',async()=>{
  const {db,threads,id,call,setOwner}=await fixture()
  const create=(title:string,chatId='owner')=>threads.create({chatId,title,summary:'',facets:[],tags:[],private:true,episodes:[]})
  const next=await create('next'), final=await create('final'), guest=await create('private','guest')
  expect(await threads.merge('owner',id,guest)).toBe(false)
  const m=makeMatterStore(db).create({kind:'terminal',ownerChatId:'owner',title:'terminal'})
  db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts) VALUES(?,?,?)').run(m.id,id,'now')
  expect(await threads.merge('owner',id,next)).toBe(true)
  expect(await threads.merge('owner',next,final)).toBe(true)
  const detail=TopicDetailResponse.parse((await call('GET /v1/memory/topics/detail',`id=${id}`)).body)
  expect(detail.topic).toMatchObject({id:final,mergedInto:final})
  expect(detail.matters).toEqual([expect.objectContaining({id:m.id,kind:'terminal',detailRoute:`/v1/matter?id=${m.id}`})])
  setOwner('guest')
  expect((await call('GET /v1/memory/topics/detail',`id=${id}`)).status).toBe(404)
  db.close()
})

it('merging topics recalled in one request unions entry and message provenance',async()=>{
  const {db,threads,id}=await fixture()
  const into=await threads.create({chatId:'owner',title:'survivor',summary:'',facets:[],tags:[],private:true,episodes:[]})
  const a=await threads.addEntry({threadId:id,kind:'fact',line:'a'}),b=await threads.addEntry({threadId:into,kind:'fact',line:'b'})
  makeTopicBubbles(db).adopt('owner','same-request','recall',[{id,entryIds:[a],messageIds:['message-a']},{id:into,entryIds:[b],messageIds:['message-b']}])
  expect(await threads.merge('owner',id,into)).toBe(true)
  const row=db.query<{entry_ids:string;message_ids:string},[string]>('SELECT entry_ids,message_ids FROM topic_recall_refs WHERE thread_id=?').get(into)!
  expect(JSON.parse(row.entry_ids).sort()).toEqual([a,b].sort())
  expect(JSON.parse(row.message_ids).sort()).toEqual(['message-a','message-b'])
  db.close()
})

it('merge keeps an adopted bubble open and lets an old id deliberately open its survivor',async()=>{
  const {db,threads,id,call}=await fixture()
  const into=await threads.create({chatId:'owner',title:'survivor',summary:'',facets:[],tags:[],private:true,episodes:[]})
  makeTopicBubbles(db).adopt('owner','request','owner',[{id}])
  await threads.merge('owner',id,into)
  expect(makeTopicBubbles(db).get(into)?.state).toBe('open')
  const result=await call('POST /v1/memory/topics/open','',{id,requestId:'old-link'})
  expect(result.status).toBe(200);expect(result.body).toMatchObject({id:into,bubbleState:'open'})
  db.close()
})

it('主人改名/合并/删/这条不对;link与其他owner均不能写,合并保留v109别名', async () => {
  const { db, threads, id, call } = await fixture()
  try {
    const other = await threads.create({chatId:'guest',title:'guest',summary:'',facets:[],tags:[],private:true,episodes:[]})
    const target = await threads.create({chatId:'owner',title:'目标',summary:'',facets:[],tags:[],private:true,episodes:[]})
    const entry = await threads.addEntry({threadId:id,kind:'fact',line:'错误事实'})
    for (const action of ['rename','merge','delete','entry/wrong']) {
      const key=`POST /v1/memory/topics/${action}`
      expect((await call(key,'',{id,title:'改名',into:target},{tier:'admin',origin:'link'})).status).toBe(403)
      expect((await call(key,'',{id:other,...(action==='rename'?{title:'改名'}:action==='merge'?{into:target}:{})})).status).toBe(404)
    }
    expect((await call('POST /v1/memory/topics/rename','',{id,title:'新名字'},{tier:'admin',origin:'device'})).status).toBe(200)
    expect((await threads.get(id))?.title).toBe('新名字')
    expect((await call('POST /v1/memory/topics/entry/wrong','',{id:entry})).status).toBe(200)
    expect((await threads.getEntry(entry))?.status).toBe('superseded')
    expect((await call('POST /v1/memory/topics/merge','',{id,into:other})).status).toBe(404)
    expect((await call('POST /v1/memory/topics/merge','',{id,into:target})).status).toBe(200)
    expect(db.query('SELECT surviving_id FROM topic_merge_aliases WHERE old_id=?').get(id)).toEqual({surviving_id:target})
    expect((await threads.getEntry(entry))?.threadId).toBe(target)
    expect((await call('POST /v1/memory/topics/delete','',{id:target})).status).toBe(200)
    expect(await threads.get(target)).toBeNull()
    expect(await threads.getEntry(entry)).toBeNull()
    expect(db.query('SELECT * FROM topic_merge_aliases WHERE old_id=?').all(id)).toEqual([])
  } finally {db.close()}
})
