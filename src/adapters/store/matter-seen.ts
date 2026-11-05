/**
 * matter-seen.ts —— 这件事某一刻以后在哪个面上被看过(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 手机:已有的 matter_bindings(v60)里 `phone`(手机打开 / 列出这件事时 routes-matters seenOnPhone 写)。
 * 桌面:daemon/desktop-surface.ts 内存里记的(不写这张表 —— 它出现在一件事的详情里,读出形状要一字不变)。
 * 只读。看过 ⇒ 回那个面;没有 ⇒ null。读出错 ⇒ null(当没看过:宁可多推一次)。
 */
import type { Db } from '../../lib/db'

export type MatterSeen = (matterId: string, sinceMs: number) => string | null

export function makeMatterSeen(db: Db, desktop?: { seenSince(matterId: string, sinceMs: number): boolean }): MatterSeen {
  return (matterId, sinceMs) => {
    try { if (desktop?.seenSince(matterId, sinceMs)) return 'desktop' } catch { /* 当没看过 */ }
    try {
      return db.query<{ surface: string }, [string, number]>("SELECT surface FROM matter_bindings WHERE matter_id = ? AND surface = 'phone' AND last_seen_at >= ? LIMIT 1")
        .get(matterId, sinceMs)?.surface ?? null
    } catch {
      return null
    }
  }
}
