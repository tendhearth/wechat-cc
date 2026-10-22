import type { Migration } from './types'

// v32 — 揭晓的「送达」与「同意」分家。social_echo / social_pledge 各加一列
// self_reveal_delivered_at:self_revealed_at 记的是**我的 owner 同意了**,
// 这一列记的是**我的揭晓真的送到对端了**。此前只有前者,于是投递失败
// (信箱掉网)之后、对方的揭晓又恰好到达时,两个本地时间戳都齐了,重试
// 直接短路报「已连接」,一次都不重发 —— 对端永远停在 awaiting_peer。
// 2026-09-01 Mac↔Windows 真机上就是这样断的。
//
// 刻意**不回填**(不写 self_reveal_delivered_at = self_revealed_at):
// 回填等于把毒继续留在库里。留成 NULL 的代价只是每条历史揭晓行被补投
// 一次 —— onInboundReveal 对重复揭晓是无写入、无通知的,而真正卡住的行
// 会因此自愈。
// Nullable-TEXT ADD COLUMN 在 STRICT 表上安全。**表存在与否要问,不能假设**:
// v19/v20 确实无条件建这两张表,但 db.test.ts 里有从 user_version=26 起跑的
// 夹具,库里根本没有 social_*(和 v31 的 hasEvents 守卫同一类情况)。
export const migration: Migration = (db) => {
    for (const t of ['social_echo', 'social_pledge']) {
      const found = db
        .query<{ cnt: number }, [string]>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name = ?")
        .get(t)
      if (!found || found.cnt === 0) continue
      db.exec(`ALTER TABLE ${t} ADD COLUMN self_reveal_delivered_at TEXT;`)
    }
  }
