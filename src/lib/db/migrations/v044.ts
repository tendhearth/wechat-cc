import type { Migration } from './types'

// v44 — conversations.mode_model:按对话钉的模型(/api DeepSeek、
// provider_switch)。provider 本来就是按对话的,模型钉之前却写在全局
// agent-config 里 —— 这个群钉了 Qwen,那个群也被换了。守卫同 v11:
// 表可能不存在(user_version=9 起步的单测库)、列可能已在(重跑)。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='conversations'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('conversations')").all()
    if (cols.some(c => c.name === 'mode_model')) return
    db.exec('ALTER TABLE conversations ADD COLUMN mode_model TEXT;')
  }
