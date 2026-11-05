/**
 * matter-seen.ts —— 这件事某一刻以后在哪个面上被看过(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 落在已有的 matter_bindings(v60):手机打开 / 列出这件事写 `phone`(routes-matters seenOnPhone),桌面读这件事的详情写
 * `desktop`(S3b)。只读;写口照旧是 matters-store 的 bind。看过 ⇒ 回那个面;没有 ⇒ null。读出错 ⇒ null(当没看过:宁可多推一次)。
 */
import type { Db } from '../../lib/db'

export type MatterSeen = (matterId: string, sinceMs: number) => string | null

export function makeMatterSeen(db: Db): MatterSeen {
  return (matterId, sinceMs) => {
    try {
      return db.query<{ surface: string }, [string, number]>("SELECT surface FROM matter_bindings WHERE matter_id = ? AND surface IN ('desktop', 'phone') AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 1")
        .get(matterId, sinceMs)?.surface ?? null
    } catch {
      return null
    }
  }
}
