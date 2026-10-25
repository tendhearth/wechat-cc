import type { Migration } from './types'

// v85 — 放行规则留痕表的 surface 加上 'chat'(2026-10-25 主人点头:主人自己的对话也走放行规则)。v78 的 CHECK 只收
// terminal / workbench,SQLite 改不了 CHECK ⇒ 重建表、原样搬行、补回索引。不加这一条,对话里规则替主人放的那一步写不进
// 留痕 ⇒ permission-gate「记不下来就不放」把它改回问。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE permission_decisions_v85 (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
        surface TEXT NOT NULL CHECK(surface IN ('terminal','workbench','chat')),
        provider TEXT NOT NULL, project TEXT, tool TEXT NOT NULL, summary TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('allow','deny')),
        by_ TEXT NOT NULL CHECK(by_ IN ('rule','review','floor')),
        rule_id TEXT, reason TEXT NOT NULL, scope TEXT NOT NULL
      ) STRICT;
      INSERT INTO permission_decisions_v85(id, at, surface, provider, project, tool, summary, verdict, by_, rule_id, reason, scope)
        SELECT id, at, surface, provider, project, tool, summary, verdict, by_, rule_id, reason, scope FROM permission_decisions;
      DROP TABLE permission_decisions;
      ALTER TABLE permission_decisions_v85 RENAME TO permission_decisions;
      CREATE INDEX IF NOT EXISTS permission_decisions_at ON permission_decisions(at);
    `)
  }
