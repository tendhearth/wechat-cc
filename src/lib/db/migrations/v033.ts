import type { Migration } from './types'

// v33 — 明信片的「欠账」。答话的一方 match:'yes' 之后建 pledge 行、发
// 明信片给求助的人。发失败时以前只有一行日志(而信箱腿上连那行都不会打,
// 见 social-post-seam.ts),没有任何人会再发一次:求助的一方什么都收不到,
// 答话的一方却留着 pledge 行以为自己回过了。和 v32 是同一个病 —— 投递
// 失败没人补 —— 只是发生在早一站。
// echo_blurb/echo_degree 记「我欠什么」,echo_queued_at 是补投有界的起点,
// echo_delivered_at 记「真的送到了」。同 v32 刻意不回填。
// 同 v32 的 table-exists 守卫:db.test.ts 有从 user_version=26 起跑的夹具。
export const migration: Migration = (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='social_pledge'")
      .get()
    if (!found || found.cnt === 0) return
    db.exec(`
      ALTER TABLE social_pledge ADD COLUMN echo_blurb TEXT;
      ALTER TABLE social_pledge ADD COLUMN echo_degree INTEGER;
      ALTER TABLE social_pledge ADD COLUMN echo_queued_at TEXT;
      ALTER TABLE social_pledge ADD COLUMN echo_delivered_at TEXT;
    `)
  }
