import type { Db } from '../../../lib/db'

/**
 * 按块撤回 / 恢复的留痕(v83):一块一行,(任务, 快照 sha, 路径, 块序号) 主键,再撤 / 再恢复就覆盖。
 * 只给界面「已撤回」小签和下一批评论里的「撤回了这几块」用 —— 写入路径从不信它(按盘上内容无状态判)。
 */
export interface ReviewHunkEntry {
  taskId: string; artifactSha256: string; path: string; hunkIndex: number; hunkSha256: string
  state: 'reverted' | 'restored'; notifiedAt: number | null; createdAt: number
}
export type ReviewHunkKey = Pick<ReviewHunkEntry, 'artifactSha256' | 'path' | 'hunkIndex'>
const SELECT = 'SELECT task_id AS taskId,artifact_sha256 AS artifactSha256,path,hunk_index AS hunkIndex,hunk_sha256 AS hunkSha256,state,notified_at AS notifiedAt,created_at AS createdAt FROM workbench_review_hunks'

export function makeReviewHunkLog(db: Db, bump: (taskId: string) => number) {
  const tx = <T>(fn: () => T) => db.transaction(fn)()
  return {
    list: (taskId: string): ReviewHunkEntry[] => db.query<ReviewHunkEntry, [string]>(`${SELECT} WHERE task_id=? ORDER BY created_at,rowid`).all(taskId),
    /**
     * 记一次撤回 / 恢复(upsert)。同一块、同一状态再记一次(崩溃后重试、幂等分支补记)⇒ 原行不动,
     * 保留 created_at 与 notified_at,不会让执行者被重复告知;状态或块 sha 变了 ⇒ 重新算「没告知过」。
     */
    set(input: Omit<ReviewHunkEntry, 'notifiedAt' | 'createdAt'> & { createdAt?: number }): ReviewHunkEntry {
      return tx(() => {
        const row = db.query<ReviewHunkEntry, [string, string, string, number, string, string, number]>(
          `INSERT INTO workbench_review_hunks(task_id,artifact_sha256,path,hunk_index,hunk_sha256,state,created_at) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(task_id,artifact_sha256,path,hunk_index) DO UPDATE SET
             created_at=CASE WHEN state=excluded.state AND hunk_sha256=excluded.hunk_sha256 THEN created_at ELSE excluded.created_at END,
             notified_at=CASE WHEN state=excluded.state AND hunk_sha256=excluded.hunk_sha256 THEN notified_at ELSE NULL END,
             hunk_sha256=excluded.hunk_sha256,state=excluded.state
           RETURNING task_id AS taskId,artifact_sha256 AS artifactSha256,path,hunk_index AS hunkIndex,hunk_sha256 AS hunkSha256,state,notified_at AS notifiedAt,created_at AS createdAt`,
        ).get(input.taskId, input.artifactSha256, input.path, input.hunkIndex, input.hunkSha256, input.state, input.createdAt ?? Date.now())!
        bump(input.taskId)
        return row
      })
    },
    /** 告知执行者之后(同一事务里)记上;已记过的不动。 */
    markNotified(taskId: string, keys: readonly ReviewHunkKey[], at = Date.now()): number {
      if (!keys.length) return 0
      return tx(() => {
        let changed = 0
        const update = db.query('UPDATE workbench_review_hunks SET notified_at=? WHERE task_id=? AND artifact_sha256=? AND path=? AND hunk_index=? AND notified_at IS NULL')
        for (const k of keys) changed += update.run(at, taskId, k.artifactSha256, k.path, k.hunkIndex).changes
        if (changed) bump(taskId)
        return changed
      })
    },
  }
}
export type ReviewHunkLog = ReturnType<typeof makeReviewHunkLog>
