import type { Db } from '../../lib/db'

/**
 * 行评论(v83,行评论设计稿):锚在 (成果, 快照 sha, 路径, 块序号, 块 sha, 块内行) 上。
 * id 由客户端生成 ⇒ 建评论幂等:同内容回原行,不同内容 review_comment_conflict。
 * 只有草稿能改 / 删(否则 review_comment_sent);markSent 只动草稿。每次写 + bump 同一事务。
 * 正文长度、条数上限、锚点合法性由服务端在写入前判(切片 2),这里只管落库。
 */
export interface ReviewComment {
  id: string; taskId: string; artifactId: string; artifactSha256: string; path: string
  hunkIndex: number; hunkSha256: string
  rowStart: number | null; rowEnd: number | null
  side: 'old' | 'new' | null; lineStart: number | null; lineEnd: number | null
  quote: string; body: string; state: 'draft' | 'sent'
  sentRequestId: string | null; sentAt: number | null; resolvedAt: number | null
  createdAt: number; updatedAt: number
}
export type NewReviewComment = Pick<ReviewComment, 'id' | 'taskId' | 'artifactId' | 'artifactSha256' | 'path' | 'hunkIndex' | 'hunkSha256' | 'quote' | 'body'>
  & Partial<Pick<ReviewComment, 'rowStart' | 'rowEnd' | 'side' | 'lineStart' | 'lineEnd'>> & { createdAt?: number }

const SELECT = 'SELECT id,task_id AS taskId,artifact_id AS artifactId,artifact_sha256 AS artifactSha256,path,hunk_index AS hunkIndex,hunk_sha256 AS hunkSha256,row_start AS rowStart,row_end AS rowEnd,side,line_start AS lineStart,line_end AS lineEnd,quote,body,state,sent_request_id AS sentRequestId,sent_at AS sentAt,resolved_at AS resolvedAt,created_at AS createdAt,updated_at AS updatedAt FROM workbench_review_comments'
/** 决定「是不是同一条评论」的字段(引用 / 行号由锚点派生,锚点同就同)。 */
const SAME: Array<keyof ReviewComment> = ['taskId', 'artifactId', 'artifactSha256', 'path', 'hunkIndex', 'hunkSha256', 'rowStart', 'rowEnd', 'body']

export function makeReviewCommentStore(db: Db, bump: (taskId: string) => number) {
  const get = (id: string) => db.query<ReviewComment, [string]>(`${SELECT} WHERE id=?`).get(id) ?? null
  const tx = <T>(fn: () => T) => db.transaction(fn)()
  /** 这件事的这一条;别的任务的 id 当不存在。 */
  const own = (taskId: string, id: string) => {
    const row = get(id)
    if (!row || row.taskId !== taskId) throw new Error('review_comment_not_found')
    return row
  }
  const draft = (taskId: string, id: string) => {
    const row = own(taskId, id)
    if (row.state !== 'draft') throw new Error('review_comment_sent')
    return row
  }
  return {
    get,
    /** 按建的先后;发出时的排序(轮、路径、块、行)由 composeCommentsText 定。 */
    list: (taskId: string): ReviewComment[] => db.query<ReviewComment, [string]>(`${SELECT} WHERE task_id=? ORDER BY created_at,rowid`).all(taskId),
    countDrafts: (taskId: string): number => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM workbench_review_comments WHERE task_id=? AND state='draft'").get(taskId)?.n ?? 0,
    create(input: NewReviewComment): ReviewComment {
      return tx(() => {
        const at = input.createdAt ?? Date.now()
        const inserted = db.query('INSERT INTO workbench_review_comments(id,task_id,artifact_id,artifact_sha256,path,hunk_index,hunk_sha256,row_start,row_end,side,line_start,line_end,quote,body,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'draft\',?,?) ON CONFLICT(id) DO NOTHING')
          .run(input.id, input.taskId, input.artifactId, input.artifactSha256, input.path, input.hunkIndex, input.hunkSha256, input.rowStart ?? null, input.rowEnd ?? null, input.side ?? null, input.lineStart ?? null, input.lineEnd ?? null, input.quote, input.body, at, at).changes
        const row = get(input.id)!
        if (!inserted) {
          // 重试同一条 ⇒ 原行(哪怕已发出);同 id 不同内容 ⇒ 冲突
          const want: Record<string, unknown> = { ...input, rowStart: input.rowStart ?? null, rowEnd: input.rowEnd ?? null }
          if (SAME.some(k => row[k] !== want[k])) throw new Error('review_comment_conflict')
          return row
        }
        bump(input.taskId)
        return row
      })
    },
    edit(taskId: string, id: string, body: string): ReviewComment {
      return tx(() => {
        const row = draft(taskId, id)
        if (row.body === body) return row
        db.query("UPDATE workbench_review_comments SET body=?,updated_at=? WHERE id=? AND state='draft'").run(body, Date.now(), id)
        bump(taskId)
        return get(id)!
      })
    },
    remove(taskId: string, id: string): void {
      tx(() => {
        draft(taskId, id)
        db.query("DELETE FROM workbench_review_comments WHERE id=? AND state='draft'").run(id)
        bump(taskId)
      })
    },
    /** 投递成功后把这一批记成已发出:只动这件事的草稿;返回实际改了几条。 */
    markSent(taskId: string, ids: readonly string[], requestId: string, at = Date.now()): number {
      if (!ids.length) return 0
      return tx(() => {
        let changed = 0
        const update = db.query("UPDATE workbench_review_comments SET state='sent',sent_request_id=?,sent_at=?,updated_at=? WHERE id=? AND task_id=? AND state='draft'")
        for (const id of ids) changed += update.run(requestId, at, at, id, taskId).changes
        if (changed) bump(taskId)
        return changed
      })
    },
  }
}
export type ReviewCommentStore = ReturnType<typeof makeReviewCommentStore>
