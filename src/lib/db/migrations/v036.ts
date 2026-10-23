import type { Migration } from './types'

// v36 — hunt_catch:每日打猎带回来的东西。
//
// WHY(2026-09-03,用户反馈):打猎每天在跑,发完就没了。careLedger 只记
// 「今天打过猎」,**猎到什么一个字都没存** —— 主人想回头找上周那条链接,
// 只能去微信聊天记录里翻。一位用户的 CC 自己想了个办法:建个 Excel
// 「军火库」,每样东西记「是什么/对你有什么用/链接/状态(没试/跑过/在用)」。
// 那张表就是这张表要长成的样子。
//
// `note` 是**发出去的原文**,一字不改;`title` 是派生的短标题,只为列表
// 扫读。status 由主人在桌面端改,默认 new。
//
// IF NOT EXISTS 不是保险起见 —— #79 的修复路径「回退到 v18 再重放 v19+」
// 只 drop social_* 那批表,hunt_catch 会活下来,于是重放到这里时裸 CREATE
// 必抛 already exists。v35 刚为同一条路径吃过一次(那次是 duplicate
// column name)。
export const migration: Migration = (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hunt_catch (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS hunt_catch_ts ON hunt_catch(ts DESC);
    `)
  }
