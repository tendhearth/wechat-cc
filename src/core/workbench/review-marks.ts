import type { Db } from '../../lib/db'

export interface ReviewMark { taskId: string; artifactSha256: string; path: string; afterSha256: string | null; mark: 'accepted' | 'returned'; comment: string; createdAt: number }

const SELECT = 'SELECT task_id AS taskId,artifact_sha256 AS artifactSha256,path,after_sha256 AS afterSha256,mark,comment,created_at AS createdAt FROM workbench_review_marks'

/** 一份快照(artifact_sha256)里的一个文件只有一个当前标记 —— 再标就覆盖(见 v62 的 PRIMARY KEY)。 */
export function makeReviewMarkStore(db: Db) {
  return {
    list: (taskId: string): ReviewMark[] => db.query<ReviewMark, [string]>(`${SELECT} WHERE task_id=? ORDER BY created_at,rowid`).all(taskId),
    set(input: Omit<ReviewMark, 'createdAt'>): ReviewMark {
      return db.query<ReviewMark, [string, string, string, string | null, string, string, number]>(
        `INSERT INTO workbench_review_marks(task_id,artifact_sha256,path,after_sha256,mark,comment,created_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(task_id,artifact_sha256,path) DO UPDATE SET after_sha256=excluded.after_sha256, mark=excluded.mark, comment=excluded.comment, created_at=excluded.created_at
         RETURNING task_id AS taskId,artifact_sha256 AS artifactSha256,path,after_sha256 AS afterSha256,mark,comment,created_at AS createdAt`,
      ).get(input.taskId, input.artifactSha256, input.path, input.afterSha256, input.mark, input.comment, Date.now())!
    },
  }
}
