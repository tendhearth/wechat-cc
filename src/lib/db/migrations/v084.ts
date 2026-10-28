import type { Migration } from './types'

// v84 — CC 主动开口的外发账(2026-10-21,第三批 3a,spec 2026-10-21-speech-policy-design):每次判定一行 ——
// 种类、类别、结果(allowed / deferred / dropped / failed)、原因、通道。**没有正文列**:只回答「为什么说了 / 没说」,
// 不留 CC 说过的话(那在 messages 里,按主人对话的规矩走)。90 天前的行由 daemon/speech/ledger-store 写入时顺手删。
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS speech_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('blocking','requested','report','initiative')),
      chat_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('allowed','deferred','dropped','failed')),
      reason TEXT,
      channel TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS speech_log_chat_at ON speech_log(chat_id, at);`)
  }
