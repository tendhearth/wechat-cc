import type { Migration } from './types'

// v43 — 旧的工具社交管道退役(spec 2026-09-04-wish-postcard §3)。
//
// 派心愿 / 回声 / 揭晓改写成走 E2E 信道的信封(kind='wish' / 'postcard'),
// 状态在 penpal_letter + companion/wishes.json。四张表 + seen_intent 在
// 真机上全是 0 行。DROP IF EXISTS:#79 路径下的库可能从没建过它们。
// repairBranchRenumberedSchema 只看 user_version 19–21,这里不受影响。
export const migration: Migration = (db) => {
    db.exec(`
      DROP TABLE IF EXISTS social_seen_intent;
      DROP TABLE IF EXISTS social_relay;
      DROP TABLE IF EXISTS social_pledge;
      DROP TABLE IF EXISTS social_echo;
      DROP TABLE IF EXISTS social_seek;
    `)
  }
