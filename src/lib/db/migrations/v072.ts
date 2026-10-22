import type { Migration } from './types'

// v72 — 回复交付:桌面 / 手机那一轮的附件与旁白跟着回复那一行落库(messages.extras,JSON)。
//
// WHY:手机「跟 CC 说」是收下即回、回复从消息库里拉(/m/api/chat),converse 的返回值它根本看不到;
// 不落库,手机永远见不到语音 / 表情 / 文件和过程行。放在回复那一行的一个可空列里而不是另起几行 ——
// 消息库的读者很多(线索抽取、交接、夜间记忆、搜索),旁白要是变成「CC 说的话」的行,它们会
// 一并读进去。NULL = 这一行没有附件也没有旁白(包括所有旧行)。
//
// 守表与守列(同 v71):v14 建 messages;测试从 user_version=9 起跑的阶梯也要能过。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='messages'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info('messages')").all().map(c => c.name))
    if (!cols.has('extras')) db.exec(`ALTER TABLE messages ADD COLUMN extras TEXT;`)
  }
