import type { Migration } from './types'

// v40 — hunt_catch → journal(架构重构 §2.4)。
//
// 背包本来是「打猎带回的东西」,一天之内又装进了见闻和明信片。它其实是
// 伙伴的**日志**:今天干了什么、遇到了谁、带回了什么。名字跟着概念走;
// kind 决定每条是什么(hunt | visit | 将来的 gift / proposal / letter)。
//
// 三种起点都要能到:已有 hunt_catch(改名)/ 已是 journal(跳过)/ 都没有
// (#79 路径下不会发生,但守着不亏)。
export const migration: Migration = (db) => {
    const has = (name: string) =>
      (db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(name)?.c ?? 0) > 0
    if (has('journal')) return
    if (has('hunt_catch')) { db.exec(`ALTER TABLE hunt_catch RENAME TO journal;`); return }
    db.exec(`
      CREATE TABLE journal (
        id TEXT PRIMARY KEY NOT NULL, ts TEXT NOT NULL, chat_id TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT, note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', kind TEXT NOT NULL DEFAULT 'hunt', image_svg TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS hunt_catch_ts ON journal(ts DESC);
    `)
  }
