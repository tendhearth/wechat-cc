/** Offline, reversible use of the topic “wrong” semantics. No migrations and no deletes. */
import z from 'zod'
import type { Db } from '../lib/db'
import { isRoutineTopicEntry } from '../domain/topic-noise'

const Scalar = z.union([z.string(), z.number(), z.null()])
const Entry = z.object({ id: z.string(), thread_id: z.string(), kind: z.string(), line: z.string(), body: z.string(), status: z.string(), superseded_by: z.string().nullable(), updated_ts: z.string() }).catchall(Scalar)
const Topic = z.object({ id: z.string(), chat_id: z.string(), summary: z.string(), description: z.string() }).catchall(Scalar)
const Snapshot = z.object({ topic: Topic, entries: z.array(Entry) })
export const TopicNoisePlanSchema = z.object({ version: z.literal(1), chatId: z.string().min(1), at: z.string(), topics: z.array(z.object({ before: Snapshot, after: Snapshot })) })
export type TopicNoisePlan = z.infer<typeof TopicNoisePlanSchema>
type Snapshot = z.infer<typeof Snapshot>

function snapshot(db: Db, id: string): Snapshot {
  return Snapshot.parse({ topic: db.query('SELECT * FROM threads WHERE id=?').get(id), entries: db.query('SELECT * FROM topic_entries WHERE thread_id=? ORDER BY id').all(id) })
}

function afterCleanup(before: Snapshot, at: string): Snapshot {
  const entries = before.entries.map(e => e.status === 'live' && isRoutineTopicEntry(e)
    ? { ...e, status: 'superseded', superseded_by: null, updated_ts: at } : { ...e })
  const live = entries.filter(e => e.status === 'live').sort((a, b) => b.updated_ts.localeCompare(a.updated_ts) || b.id.localeCompare(a.id))
  const latest = live.find(e => e.kind === 'progress' || e.kind === 'conclusion') ?? live.find(e => e.kind === 'decision')
  const description = before.topic.description.trim().replace(/[。.;；]+$/, '')
  const status = latest ? [...latest.line].slice(0, 80).join('') : ''
  const summary = status ? (description ? `${description}。现状:${status}` : status) : description
  return { topic: { ...before.topic, summary }, entries }
}

/** Read-only snapshot: candidates only; every retained row is included to guard summary reconstruction. */
export function planTopicNoiseCleanup(db: Db, chatId: string, at = new Date().toISOString()): TopicNoisePlan {
  if (!chatId.trim()) throw new Error('chat_id_required')
  const topics: TopicNoisePlan['topics'] = []
  for (const t of db.query<{ id: string }, [string]>('SELECT id FROM threads WHERE chat_id=? ORDER BY id').all(chatId)) {
    const before = snapshot(db, t.id)
    if (!before.entries.some(e => e.status === 'live' && isRoutineTopicEntry(e))) continue
    topics.push({ before, after: afterCleanup(before, at) })
  }
  return { version: 1, chatId, at, topics }
}

/** Stable object-key order, including journals serialized by another runtime. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
}

/** Exact compare-and-swap of the whole plan. Optional beforeWrite persists journal while holding the write lock. */
export function applyTopicNoiseCleanup(db: Db, input: TopicNoisePlan, rollback = false, beforeWrite?: () => void): number {
  const plan = TopicNoisePlanSchema.parse(input)
  const seen = new Set<string>()
  for (const p of plan.topics) {
    if (seen.has(p.before.topic.id) || p.before.topic.chat_id !== plan.chatId || p.before.entries.some(e => e.thread_id !== p.before.topic.id) || canonical(afterCleanup(p.before, plan.at)) !== canonical(p.after)) throw new Error('invalid_cleanup_plan')
    seen.add(p.before.topic.id)
  }
  return db.transaction(() => {
    // Validate every snapshot before making any change; reject new/deleted/edited retained entries too.
    for (const p of plan.topics) {
      if (canonical(snapshot(db, p.before.topic.id)) !== canonical(rollback ? p.after : p.before)) throw new Error(`topic_changed:${p.before.topic.id}`)
    }
    beforeWrite?.()
    let changed = 0
    for (const p of plan.topics) {
      const target = rollback ? p.before : p.after
      for (let i = 0; i < p.before.entries.length; i++) {
        if (canonical(p.before.entries[i]) === canonical(p.after.entries[i])) continue
        const e = target.entries[i]!
        db.query('UPDATE topic_entries SET status=?,superseded_by=?,updated_ts=? WHERE id=? AND thread_id=?').run(e.status, e.superseded_by, e.updated_ts, e.id, target.topic.id)
        changed++
      }
      db.query('UPDATE threads SET summary=? WHERE id=? AND chat_id=?').run(target.topic.summary, target.topic.id, plan.chatId)
    }
    return changed
  }).immediate()
}
