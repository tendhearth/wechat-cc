import type { Migration } from './types'

// v103 — speech_log 加一列 ref(2026-11-05,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md §S3a)。
// ref = 同一个事件的键(domain/speech/event-ref.ts:`ask:<matter>:<request>` / `turn:<matter>:<seq>`)。带 ref 的判定
// 写账时同一个 ref 只有一行(daemon/speech/ledger-store.ts:没有就插,有了就改那一行、通道追加),于是「同一事件账上一行」
// 由写口保证。不带 ref 的照旧一判一行。可重放:已有这一列就只补索引。
export const migration: Migration = (db) => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(speech_log)').all()
    if (!columns.some(c => c.name === 'ref')) db.exec('ALTER TABLE speech_log ADD COLUMN ref TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS speech_log_ref ON speech_log(ref) WHERE ref IS NOT NULL')
  }
