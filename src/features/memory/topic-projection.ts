import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeTopicBubbles, topicMatters, topicRevision } from '../../lib/topic-bubbles'

export async function topicsProjection(db: Db, owner: string) {
  const store = makeThreadsStore(db), bubbles = makeTopicBubbles(db)
  const topics = []
  for (const t of (await store.list(owner)).sort((a, b) => a.id.localeCompare(b.id))) {
    const bubble = bubbles.get(t.id)
    const matters = topicMatters(db, owner, t.id).map(m => ({ id: m.id, title: m.title.slice(0, 160), state: m.state, archivedAt: m.archived_at }))
      .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || Number(b.state === 'working') - Number(a.state === 'working') || a.id.localeCompare(b.id))
    const refs = db.query<{ entry_ids: string; message_ids: string; request_id: string; created_at: string }, [string, string]>(
      'SELECT entry_ids,message_ids,request_id,created_at FROM topic_recall_refs WHERE thread_id=? AND chat_id=? ORDER BY created_at DESC,rowid DESC').all(t.id, owner)
    const recalled = new Set<string>(refs[0] ? JSON.parse(refs[0].entry_ids) : [])
    const entries = (await store.entries(t.id, { live: true })).map(e => ({ ...e, recalled: recalled.has(e.id) }))
      .sort((a, b) => Number(b.kind === 'commitment') - Number(a.kind === 'commitment') || Number(b.recalled) - Number(a.recalled) || b.updatedTs.localeCompare(a.updatedTs) || a.id.localeCompare(b.id))
    const messageIds = new Set<string>(refs.flatMap(r => JSON.parse(r.message_ids) as string[]))
    // episodes 是已抽取的相关区间,不把 agent 过程或其它 chat 的话挂过来。
    const messages = db.query<{ id: string; ts: string; direction: string; text: string }, [string]>(
      'SELECT id,ts,direction,text FROM messages WHERE chat_id=? ORDER BY ts DESC,id LIMIT 1000').all(owner)
      .filter(m => messageIds.has(m.id) || t.episodes.some(e => m.ts >= e.from_ts && m.ts <= e.to_ts))
      .map(m => ({ id: m.id, ts: m.ts, speaker: m.direction === 'in' ? 'owner' : 'cc', excerpt: m.text.replace(/\s+/g, ' ').slice(0, 240), source: messageIds.has(m.id) ? 'recall' : 'episode' }))
    const item = {
      id: t.id, title: t.title.slice(0, 160), description: t.description.slice(0, 600), summary: t.summary.slice(0, 600),
      bubbleState: bubble?.state ?? 'closed' as const,
      lastRecalledAt: bubble?.last_recalled_at ?? null, lastOpenedByOwnerAt: bubble?.last_opened_by_owner_at ?? null,
      activityRevision: bubble?.activity_revision ?? 0,
      matterSummary: { waiting: matters.filter(m => m.archivedAt === null && m.state === 'waiting').length, running: matters.filter(m => m.archivedAt === null && m.state === 'working').length, total: matters.length },
    }
    topics.push({ topic: item, entries, matters, messages, refs, private: t.private })
  }
  const revision = topicRevision(topics)
  const recent = [...topics].sort((a, b) => {
    const at = (t: typeof a) => [t.topic.lastRecalledAt ?? '', t.topic.lastOpenedByOwnerAt ?? ''].sort().at(-1)!
    return at(b).localeCompare(at(a)) || a.topic.id.localeCompare(b.topic.id)
  })
  const open = topics.filter(t => t.topic.bubbleState === 'open')
  return { topics, recent, revision, summary: { revision, recentIds: recent.slice(0, 8).map(t => t.topic.id), openIds: open.slice(0, 64).map(t => t.topic.id), hasMoreOpen: open.length > 64 } }
}
