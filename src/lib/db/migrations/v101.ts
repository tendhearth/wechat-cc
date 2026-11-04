import type { Migration } from './types'

// v101 — 待发队列一张表 speech_pending(2026-11-04,设计稿 2026-11-04-s2-one-pending-queue-design.md §S2b)。
// CC 想说、门说「这会儿别说」或者放行了却没发出去的那几样都在这里等:
//   lane = 'say'  经 SpeechPolicy 补说的话(回报 / 拍板类 tell,以前在 speech/pending-notices.json;S2c 起还有新贴纸那一句、见闻);
//   lane = 'push' App 原生推送(speech/push-gate.ts,以前只在内存里,重启就没了)。
// body = 正文(say)或推送的 JSON(push);attach = 随这句一起发的图(S2c:贴纸 / 明信片,JSON);ref = 同一件事的键
// (push 用:同一件事只留最新那一条)。next_at / attempts / first_failed_at = 共用退避(lib/delivery-backoff)记在行上,重启不归零;
// expires_at = 过了就记一行账「过期作废」(speech_log outcome=dropped、reason=expired)、不再发;
// status:pending 在等 / overflow 一条对话压太多被挤掉的(说的时候带一句「还有 N 件更早的」,说过就删)。说完 / 作废的行直接删。
// speech/pending-notices.json 里已有的,开机时由 daemon/speech/pending-notices.ts 读进来(迁移里拿不到 stateDir)。可重放:IF NOT EXISTS。
export const migration: Migration = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS speech_pending (
      id TEXT PRIMARY KEY,
      lane TEXT NOT NULL CHECK(lane IN ('say','push')),
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      attach TEXT,
      ref TEXT,
      created_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_failed_at INTEGER,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','overflow'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS speech_pending_lane_chat ON speech_pending(lane, status, chat_id, created_at);
    CREATE INDEX IF NOT EXISTS speech_pending_lane_next ON speech_pending(lane, status, next_at);
    CREATE UNIQUE INDEX IF NOT EXISTS speech_pending_ref ON speech_pending(lane, ref) WHERE ref IS NOT NULL;`)
  }
