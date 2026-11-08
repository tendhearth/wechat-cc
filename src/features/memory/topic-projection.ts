import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeTopicBubbles, topicMatters } from '../../lib/topic-bubbles'
import { TopicBubbleEntry } from '../../../packages/protocol/src/topic-bubbles'

export function topicsRevision(db: Db, owner: string): string {
  return String(db.query<{ revision: number }, [string]>('SELECT revision FROM topic_bubble_revisions WHERE chat_id=?').get(owner)?.revision ?? 0)
}
const RECENT_ORDER = "MAX(COALESCE(b.last_recalled_at,''),COALESCE(b.last_opened_by_owner_at,'')) DESC,t.id"
const FROM = 'FROM threads t LEFT JOIN topic_bubbles b ON b.thread_id=t.id WHERE t.chat_id=?'
export async function topicSummary(db: Db, owner: string, id: string) {
  const t = await makeThreadsStore(db).get(id)
  if (!t || t.chatId !== owner) return null
  const bubble = makeTopicBubbles(db).get(id), matters = topicMatters(db, owner, id)
  return {
    id, mergedInto: null, title: t.title.slice(0, 160), description: t.description.slice(0, 600), summary: t.summary.slice(0, 600),
    bubbleState: bubble?.state ?? 'closed' as const,
    lastRecalledAt: bubble?.last_recalled_at ?? null, lastOpenedByOwnerAt: bubble?.last_opened_by_owner_at ?? null,
    activityRevision: bubble?.activity_revision ?? 0,
    matterSummary: { waiting: matters.filter(m => m.archived_at === null && m.state === 'waiting').length, running: matters.filter(m => m.archived_at === null && m.state === 'working').length, total: matters.length },
  }
}
/** Hub/list 不读条目与消息正文。历史正文只在被点开的话题中按 LIMIT/OFFSET 读取。 */
export async function topicsProjection(db: Db, owner: string, page?: { view: 'recent' | 'all'; offset: number; limit: number; q?: string }) {
  const revision = topicsRevision(db, owner)
  const recentIds = db.query<{ id: string }, [string]>(`SELECT t.id ${FROM} ORDER BY ${RECENT_ORDER} LIMIT 8`).all(owner).map(t => t.id)
  const openIds = db.query<{ id: string }, [string]>(`SELECT t.id ${FROM} AND b.state='open' ORDER BY t.id LIMIT 65`).all(owner).map(t => t.id)
  const search = page?.q ? ' AND instr(lower(t.title || char(10) || t.description || char(10) || t.summary),lower(?))>0' : ''
  const searchArgs = page?.q ? [owner,page.q] : [owner]
  const ids = page ? page.view === 'recent' ? recentIds.slice(page.offset, page.offset + page.limit)
    : db.query<{ id: string }, (string | number)[]>(`SELECT t.id ${FROM}${search} ORDER BY ${RECENT_ORDER} LIMIT ? OFFSET ?`).all(...searchArgs, page.limit, page.offset).map(t => t.id) : []
  const topics = []
  for (const id of ids) { const topic = await topicSummary(db, owner, id); if (topic) topics.push(topic) }
  const total = !page ? 0 : page.view === 'recent' ? recentIds.length : db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n ${FROM}${search}`).get(...searchArgs)!.n
  return { topics, total, revision, summary: { revision, recentIds, openIds: openIds.slice(0, 64), hasMoreOpen: openIds.length > 64 } }
}
export type TopicSection = 'entries' | 'matters' | 'messages'
export async function topicDetailPage(db: Db, owner: string, id: string, offsets: Record<TopicSection, number>, limits: Record<TopicSection, number>) {
  const topic = await topicSummary(db, owner, id)
  if (!topic) return null
  const store = makeThreadsStore(db), t = (await store.get(id))!
  const ref = db.query<{ entry_ids: string }, [string, string]>('SELECT entry_ids FROM topic_recall_refs WHERE thread_id=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id, owner)
  const recalled = ref?.entry_ids ?? '[]'
  const entries = db.query<Record<string, unknown>, [string, string, number, number]>(`SELECT id,thread_id AS threadId,kind,line,body,due,status,source,matter_id AS matterId,superseded_by AS supersededBy,created_ts AS createdTs,updated_ts AS updatedTs,
    id IN (SELECT value FROM json_each(?1)) AS recalled FROM topic_entries WHERE thread_id=?2 AND status='live'
    ORDER BY kind='commitment' DESC,recalled DESC,updated_ts DESC,id LIMIT ?3 OFFSET ?4`).all(recalled, id, limits.entries, offsets.entries)
    .map(e => TopicBubbleEntry.parse({ ...e, recalled: !!e.recalled }))
  const allMatters = topicMatters(db, owner, id, true).map(m => ({ id: m.id, kind: m.kind, detailRoute: `/v1/matter?id=${encodeURIComponent(m.id)}`, title: m.title.slice(0, 160), state: m.state, archivedAt: m.archived_at }))
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || Number(b.state === 'working') - Number(a.state === 'working') || a.id.localeCompare(b.id))
  const related = `FROM messages m WHERE m.chat_id=?1 AND (
    EXISTS(SELECT 1 FROM topic_recall_refs r,json_each(r.message_ids) j WHERE r.chat_id=?1 AND r.thread_id=?2 AND j.value=m.id)
    OR EXISTS(SELECT 1 FROM json_each(?3) ep WHERE m.ts>=json_extract(ep.value,'$.from_ts') AND m.ts<=json_extract(ep.value,'$.to_ts')))`
  const messages = db.query<{ id: string; ts: string; direction: string; text: string; recalled: number }, [string, string, string, number, number]>(`SELECT m.id,m.ts,m.direction,substr(m.text,1,1000) AS text,
    EXISTS(SELECT 1 FROM topic_recall_refs r,json_each(r.message_ids) j WHERE r.chat_id=?1 AND r.thread_id=?2 AND j.value=m.id) AS recalled
    ${related} ORDER BY m.ts DESC,m.id LIMIT ?4 OFFSET ?5`).all(owner, id, JSON.stringify(t.episodes), limits.messages, offsets.messages)
    .map(m => ({ id: m.id, ts: m.ts, speaker: m.direction === 'in' ? 'owner' : 'cc', excerpt: m.text.replace(/\s+/g, ' ').slice(0, 240), source: m.recalled ? 'recall' : 'episode' }))
  const totals = {
    entries: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM topic_entries WHERE thread_id=? AND status='live'").get(id)!.n,
    matters: allMatters.length,
    messages: db.query<{ n: number }, [string, string, string]>(`SELECT COUNT(*) AS n ${related}`).get(owner, id, JSON.stringify(t.episodes))!.n,
  }
  return { topic, entries, matters: allMatters.slice(offsets.matters, offsets.matters + limits.matters), messages, totals }
}
