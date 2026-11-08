import { realpathSync, statSync } from 'node:fs'
import z from 'zod'
import { openSqlite } from '../lib/runtime/sqlite'
import { readJsonFile } from '../lib/read-json-file'
import { writeJsonExclusive } from '../lib/json-file'
import { planTopicNoiseCleanup, applyTopicNoiseCleanup, TopicNoisePlanSchema } from './topic-noise-cleanup-plan'

export interface TopicNoiseCleanupOptions {
  db: string
  chatId: string
  apply?: boolean
  rollback?: boolean
  dryRun?: boolean
  journal?: string
}
const Journal = z.object({ dbPath: z.string(), dev: z.number(), ino: z.number(), plan: TopicNoisePlanSchema })

/** Explicit offline DB only; never opens STATE_DIR, migrates, starts a daemon or calls models. */
export function runTopicNoiseCleanup(o: TopicNoiseCleanupOptions) {
  if (!o.chatId?.trim()) throw new Error('chat_id_required')
  if ((o.apply && o.rollback) || (o.dryRun && (o.apply || o.rollback))) throw new Error('conflicting_cleanup_flags')
  if ((o.apply || o.rollback) && !o.journal) throw new Error('journal_required')
  const dbPath = realpathSync(o.db), file = statSync(dbPath)
  if (!file.isFile()) throw new Error('database_must_be_regular_file')
  const saved = o.rollback ? Journal.parse(readJsonFile(o.journal!)) : null
  if (saved && (saved.dbPath !== dbPath || saved.dev !== file.dev || saved.ino !== file.ino || saved.plan.chatId !== o.chatId)) throw new Error('journal_scope_mismatch')
  const writing = !!(o.apply || o.rollback)
  const db = openSqlite(dbPath, writing ? { readwrite: true, create: false } : { readonly: true })
  try {
    const plan = saved?.plan ?? planTopicNoiseCleanup(db, o.chatId)
    const candidates = plan.topics.map(p => ({ id: p.before.topic.id, title: p.before.topic.title, entries: p.before.entries.filter((e, i) => e.status !== p.after.entries[i]!.status).map(e => ({ id: e.id, kind: e.kind, line: e.line, source: e.source })) }))
    const changed = writing ? applyTopicNoiseCleanup(db, plan, !!o.rollback, o.apply ? () => {
      // Exclusive create + durable before image precede every DB mutation. Existing journal is never overwritten.
      writeJsonExclusive(o.journal!, { dbPath, dev: file.dev, ino: file.ino, plan })
    } : undefined) : candidates.reduce((n, t) => n + t.entries.length, 0)
    return { mode: o.rollback ? 'rollback' : o.apply ? 'apply' : 'dry-run', changed, topics: candidates, ...(writing ? { journal: o.journal } : {}) }
  } finally { db.close() }
}
