import type { Migration } from './types'

// v71 — 回复交付(spec 2026-10-03-reply-delivery §4.10):turn_records 记「主人到底收到了什么」。
//
// WHY:以前只有 reply_tool_called 与 text_chunks(计数)—— 「这轮说没说话」靠的是模型调没调
// reply 工具,主人收到几条、有没有附件、是不是静默,库里一个字都没有。daemon 模式的轮写这四列;
// legacy 的轮留空(NULL = 不知道,不是「什么都没发」)。旧列保留以读历史,daemon 模式写
// reply_tool_called=0。
//
// 守列存在(同 v35):#79 的修复路径会重放 v19+,但不会 drop turn_records。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='turn_records'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info('turn_records')").all().map(c => c.name))
    if (!cols.has('delivery')) db.exec(`ALTER TABLE turn_records ADD COLUMN delivery TEXT;`)
    if (!cols.has('bubbles')) db.exec(`ALTER TABLE turn_records ADD COLUMN bubbles INTEGER;`)
    if (!cols.has('attachments')) db.exec(`ALTER TABLE turn_records ADD COLUMN attachments INTEGER;`)
    if (!cols.has('narration_segments')) db.exec(`ALTER TABLE turn_records ADD COLUMN narration_segments INTEGER;`)
  }
