import type { Migration } from './types'

// v103 — speech_log 与 matter_report_outbox 各加一列 ref(2026-11-05,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md §S3a)。
// ref = 同一个事件的键(domain/speech/event-ref.ts:`ask:<matter>:<request>` / `turn:<matter>:<seq>`)。带 ref 的判定
// 写账时同一个 ref 只有一行(daemon/speech/ledger-store.ts:没有就插,有了就改那一行、通道追加),于是「同一事件账上一行」
// 由写口保证。不带 ref 的照旧一判一行。
// matter_report_outbox.ref = 这一条回报报的是哪一轮(入队那一刻记下;同一件事上一条还没发、下一轮又来时合并成一行,ref 跟着换成
// 新的那一轮 —— 不能事后按 created_at 推,合并时 created_at 故意不动)。旧行是空 ⇒ 问门不带键。
// 可重放:已有这一列就跳过,索引 IF NOT EXISTS。
export const migration: Migration = (db) => {
    const has = (table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === 'ref')
    if (!has('speech_log')) db.exec('ALTER TABLE speech_log ADD COLUMN ref TEXT')
    if (!has('matter_report_outbox')) db.exec('ALTER TABLE matter_report_outbox ADD COLUMN ref TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS speech_log_ref ON speech_log(ref) WHERE ref IS NOT NULL')
  }
