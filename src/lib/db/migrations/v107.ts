import type { Migration } from './types'

// S4a: delivery evidence is separate from the policy decision. Historical
// allowed rows have no proof of delivery and must not spend the budget.
export const migration: Migration = (db) => {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(speech_log)').all()
  if (!columns.some(c => c.name === 'spoken_at')) db.exec('ALTER TABLE speech_log ADD COLUMN spoken_at INTEGER')
  if (!columns.some(c => c.name === 'delivery_state')) db.exec("ALTER TABLE speech_log ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK(delivery_state IN ('legacy_unknown','unconfirmed','confirmed'))")
  db.exec("CREATE INDEX IF NOT EXISTS speech_log_initiative_spoken ON speech_log(chat_id,spoken_at) WHERE origin='initiative' AND spoken_at IS NOT NULL")
}
