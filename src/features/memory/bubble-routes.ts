import { makeThreadsStore } from '../../lib/threads-store'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../../lib/db'
import type { RouteHandler, RouteTable } from '../../daemon/internal-api/types'
import { hintWrite, onWriteHint } from '../../lib/write-hints'
import { matterFeed } from '../../adapters/store/matter-feed'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import { framedTooLargeFor } from '../../domain/matters/phone-scope'
import { TopicDetailQuery, TopicOpenRequest, TopicRenameRequest, TopicMergeRequest, TopicDeleteRequest, TopicWrongRequest, TopicsListQuery, TopicsSubscribeQuery } from '../../../packages/protocol/src/topic-bubbles'
import type { MatterSeen } from '../../adapters/store/matter-seen'
import type { ProjectTaskActivitySource } from '../../ports/topic-activity'
import { topicDetailPage, topicsProjection } from './topic-projection'

type Caller = Parameters<RouteHandler>[2]
/** admin 本身不是主人表面;私密展示接口只认宿主 operator 与已认证设备。 */
export const isTopicOwnerSurface = (caller: Caller): boolean => !!caller && caller.tier === 'admin' && (caller.origin === 'operator' || caller.origin === 'device')
const err = (status: number, error: string) => ({ status, body: { ok: false, error } })
const secret = randomBytes(32)
function cursorFor(scope: string, offset: number): string {
  const text = Buffer.from(JSON.stringify([scope, offset])).toString('base64url')
  return `${text}.${createHmac('sha256', secret).update(text).digest('base64url')}`
}
function offsetOf(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0
  const [text, mac, extra] = cursor.split('.')
  const expected = createHmac('sha256', secret).update(text ?? '').digest('base64url')
  if (extra || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error('invalid_cursor')
  const [bound, offset] = JSON.parse(Buffer.from(text!, 'base64url').toString())
  if (bound !== scope || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_cursor')
  return offset
}
export function bubbleRoutes(d: { db: Db; ownerChatId(): string | null; seen?: MatterSeen; taskActivity?:ProjectTaskActivitySource }): RouteTable {
  const threads = makeThreadsStore(d.db)
  const bubbles = makeTopicBubbles(d.db)
  const wrap = (run: (q: URLSearchParams, body: unknown, owner: string, caller: NonNullable<Caller>, ctx: Parameters<RouteHandler>[3]) => ReturnType<RouteHandler>): RouteHandler => async (q, body, caller, ctx) => {
    if (!isTopicOwnerSurface(caller)) return err(403, 'forbidden')
    const owner = d.ownerChatId()
    if (!owner) return err(404, 'not_found')
    try {
      const result = await run(q, body, owner, caller!, ctx)
      if (d.ownerChatId() !== owner) return err(403, 'forbidden')
      return result
    } catch (e) { return err(e instanceof Error && e.message === 'invalid_cursor' ? 400 : 503, e instanceof Error && e.message === 'invalid_cursor' ? 'invalid_cursor' : 'topics_unavailable') }
  }
  const edit = (action: 'rename' | 'merge' | 'delete' | 'entry/wrong'): RouteHandler => wrap(async (_q, body, owner) => {
    const schema = action === 'rename' ? TopicRenameRequest : action === 'merge' ? TopicMergeRequest : action === 'entry/wrong' ? TopicWrongRequest : TopicDeleteRequest
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(400, 'invalid_params')
    const p = parsed.data as {id:string;title?:string;into?:string}
    if (action === 'entry/wrong') {
      const entry = await threads.getEntry(p.id)
      const topic = entry && await threads.get(entry.threadId)
      if (!entry || topic?.chatId !== owner) return err(404, 'not_found')
      if(d.ownerChatId()!==owner)return err(403,'forbidden')
      await threads.updateEntry(entry.id, { status: 'superseded' })
      return { status: 200, body: { ok: true, message: '记下了，这条不再当作事实。' } }
    }
    const topic = await threads.get(p.id)
    if (topic?.chatId !== owner) return err(404, 'not_found')
    if(d.ownerChatId()!==owner)return err(403,'forbidden')
    if (action === 'rename') {
      if (!p.title) return err(400, 'invalid_params')
      await threads.update(p.id, { title: p.title })
    } else if (action === 'merge') {
      if (!p.into || p.into === p.id) return err(400, 'invalid_params')
      if (!await threads.merge(owner, p.id, p.into)) return err(404, 'not_found')
    } else {
      d.db.transaction(() => {
        d.db.query('DELETE FROM topic_merge_aliases WHERE chat_id=? AND (old_id=? OR surviving_id=?)').run(owner, p.id, p.id)
        d.db.query('DELETE FROM threads WHERE id=? AND chat_id=?').run(p.id, owner)
      })()
    }
    hintWrite(d.db, { kind: 'topics', chatId: owner })
    return { status: 200, body: { ok: true } }
  })
  return {
    'GET /v1/memory/topics': wrap(async (q, _body, owner, caller) => {
      const parsed = TopicsListQuery.safeParse(Object.fromEntries(q))
      if (!parsed.success || (parsed.data.q && parsed.data.view !== 'all')) return err(400, 'invalid_params')
      const p = parsed.data, snapshot = await topicsProjection(d.db, owner, undefined, d.seen, d.taskActivity), revision=snapshot.revision
      const scope = JSON.stringify([owner, 'list', p.view, p.q ?? '', revision])
      const offset = offsetOf(p.cursor, scope)
      let count = Math.min(p.limit, p.view === 'recent' ? 8 : 50)
      const projection = snapshot.pageOf({ view: p.view, offset, limit: count, ...(p.q ? {q:p.q} : {}) })
      const build = () => ({ topics: projection.topics.slice(0, count), nextCursor: offset + count < projection.total ? cursorFor(scope, offset + count) : null, revision })
      let body = build()
      while (count > 1 && caller.frameBudget && framedTooLargeFor(JSON.stringify(body), caller.frameBudget)) { count--; body = build() }
      if (caller.frameBudget && framedTooLargeFor(JSON.stringify(body), caller.frameBudget)) return err(413, 'too_large')
      return { status: 200, body }
    }),
    'GET /v1/memory/topics/detail': wrap(async (q, _body, owner, caller) => {
      const parsed = TopicDetailQuery.safeParse(Object.fromEntries(q))
      if (!parsed.success || (parsed.data.cursor && !parsed.data.section)) return err(400, 'invalid_params')
      const p = parsed.data, snapshot = await topicsProjection(d.db, owner, undefined, d.seen, d.taskActivity), revision=snapshot.revision
      const alias = d.db.query<{ surviving_id: string }, [string,string]>(`SELECT a.surviving_id FROM topic_merge_aliases a JOIN threads t ON t.id=a.surviving_id AND t.chat_id=a.chat_id WHERE a.chat_id=? AND a.old_id=?`).get(owner,p.id)
      if(alias) p.id=alias.surviving_id
      const sections = ['entries', 'matters', 'messages'] as const
      const budgets = { entries: 4, matters: 3, messages: 4 }
      const offsets = { entries: 0, matters: 0, messages: 0 }
      const scope = (section: string) => JSON.stringify([owner, p.id, section, revision])
      if (p.section) { offsets[p.section] = offsetOf(p.cursor, scope(p.section)); budgets[p.section] = p.limit ?? budgets[p.section] }
      const build = async () => {
        const data = await topicDetailPage(d.db, owner, p.id, offsets, budgets, d.seen, snapshot)
        if (!data) return null
        const page = (section: typeof sections[number]) => ({ total: data.totals[section], nextCursor: offsets[section] + budgets[section] < data.totals[section] ? cursorFor(scope(section), offsets[section] + budgets[section]) : null })
        return { topic: { ...data.topic, mergedInto: alias?.surviving_id ?? null }, entries: data.entries, matters: data.matters, messages: data.messages, pages: { entries: page('entries'), matters: page('matters'), messages: page('messages') }, revision }
      }
      let body = await build()
      if (!body) return err(404, 'not_found')
      while (caller.frameBudget && framedTooLargeFor(JSON.stringify(body), caller.frameBudget)) {
        const section = [...sections].sort((a, b) => budgets[b] - budgets[a]).find(s => budgets[s] > 1)
        if (!section) return err(413, 'too_large')
        budgets[section]--; body = await build()
        if (!body) return err(404, 'not_found')
      }
      return { status: 200, body }
    }),
    'POST /v1/memory/topics/rename': edit('rename'),
    'POST /v1/memory/topics/merge': edit('merge'),
    'POST /v1/memory/topics/delete': edit('delete'),
    'POST /v1/memory/topics/entry/wrong': edit('entry/wrong'),
    'POST /v1/memory/topics/open': wrap(async (_q, body, owner) => {
      const parsed = TopicOpenRequest.safeParse(body)
      if (!parsed.success) return err(400, 'invalid_params')
      const { requestId } = parsed.data
      const alias=d.db.query<{surviving_id:string},[string,string]>('SELECT a.surviving_id FROM topic_merge_aliases a JOIN threads t ON t.id=a.surviving_id AND t.chat_id=a.chat_id WHERE a.chat_id=? AND a.old_id=?').get(owner,parsed.data.id)
      const id=alias?.surviving_id??parsed.data.id
      if (!d.db.query('SELECT id FROM threads WHERE id=? AND chat_id=?').get(id, owner)) return err(404, 'not_found')
      bubbles.adopt(owner, `${id}:${requestId}`, 'owner', [{ id }])
      const p = await topicsProjection(d.db, owner, undefined, d.seen, d.taskActivity)
      return { status: 200, body: { id, bubbleState: bubbles.get(id)?.state ?? 'closed', revision: p.revision } }
    }),
    'GET /v1/subscribe/topics': wrap(async (q, _body, owner, _caller, ctx) => {
      const parsed = TopicsSubscribeQuery.safeParse(Object.fromEntries(q))
      if (!parsed.success) return err(400, 'invalid_params')
      const { since, wait_ms } = parsed.data
      const current = async () => { if (d.ownerChatId() !== owner) throw new Error('owner_changed'); return (await topicsProjection(d.db, owner, undefined, d.seen, d.taskActivity)).summary }
      const initial = await current()
      if (!since || since !== initial.revision || !wait_ms || ctx?.signal.aborted) return { status: 200, body: initial }
      return new Promise(resolve => {
        let done = false, busy = false, dirty = false
        const finish = (result: Awaited<ReturnType<RouteHandler>>) => {
          if (done) return
          done = true; clearTimeout(timeout); offHints(); offFeed(); ctx?.signal.removeEventListener('abort', abort); resolve(result)
        }
        const poke = () => {
          dirty = true
          if (busy || done) return
          busy = true
          queueMicrotask(async () => {
            try { do { dirty = false; const data = await current(); if (data.revision !== since) finish({ status: 200, body: data }) } while (dirty && !done) }
            catch { finish(err(503, 'topics_unavailable')) } finally { busy = false }
          })
        }
        const offHints = onWriteHint(d.db, h => { if ((h.kind === 'topics' || h.kind === 'messages') ? h.chatId === owner : h.kind === 'matter') poke() })
        const offFeed = matterFeed(d.db).onChange(() => poke())
        const abort = () => finish({ status: 200, body: initial })
        const timeout = setTimeout(() => { void current().then(body => finish({ status: 200, body }), () => finish(err(503, 'topics_unavailable'))) }, wait_ms)
        ctx?.signal.addEventListener('abort', abort, { once: true })
        // 订好后再算:堵住第一次读取与订阅之间的写入窗口。
        poke()
      })
    }),
  }
}
