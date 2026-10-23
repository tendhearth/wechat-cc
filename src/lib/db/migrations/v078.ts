import type { Migration } from './types'

// v78 — 放行规则留痕(2026-10-19,spec 2026-10-19-permission-rules-design §4):CC 替主人拿的权限决定
// (规则放行 / 初审放行 / 规则拒绝)每条一行;主人亲手批的不在这里(各入口自己有记录)。保留 30 天。
// `by` 是 SQL 关键字,列名用 by_。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS permission_decisions (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
        surface TEXT NOT NULL CHECK(surface IN ('terminal','workbench')),
        provider TEXT NOT NULL, project TEXT, tool TEXT NOT NULL, summary TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('allow','deny')),
        by_ TEXT NOT NULL CHECK(by_ IN ('rule','review','floor')),
        rule_id TEXT, reason TEXT NOT NULL, scope TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS permission_decisions_at ON permission_decisions(at);
    `)
  }
