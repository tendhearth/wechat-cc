import type { Migration } from './types'

// v34 — 介绍人(W)那一侧的欠账。W 在 2 跳连接里替两端跑腿,而它的**每一条
// 外发都是 fire-and-forget、失败只留一行日志**:
//   · 转发下游明信片给 S(social-echo-relay)—— 掉了 ⇒ Q 以为自己答过了、
//     S 什么都没收到、W 留着一条谁也用不上的 relay 行。
//   · 互揭达成后给两端的 complete 回投 —— 掉了 ⇒ 那一端永久停在
//     awaiting_peer,而 W 的行说「两条腿都揭晓了」,重试还会走 legAlready
//     分支直接返回,一个字节都不再发。跟 v32 是同一个形状,只是发生在 W。
// 记下欠什么(echo_blurb/degree)、什么时候欠的(echo_queued_at,补投有界的
// 起点)、以及三件事各自的送达时刻。同 v32/v33 刻意不回填。
// 同款 table-exists 守卫:db.test.ts 有从 user_version=26 起跑的夹具。
export const migration: Migration = (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='social_relay'")
      .get()
    if (!found || found.cnt === 0) return
    db.exec(`
      ALTER TABLE social_relay ADD COLUMN echo_blurb TEXT;
      ALTER TABLE social_relay ADD COLUMN echo_degree INTEGER;
      ALTER TABLE social_relay ADD COLUMN echo_queued_at TEXT;
      ALTER TABLE social_relay ADD COLUMN echo_delivered_at TEXT;
      ALTER TABLE social_relay ADD COLUMN upstream_completed_at TEXT;
      ALTER TABLE social_relay ADD COLUMN downstream_completed_at TEXT;
    `)
  }
