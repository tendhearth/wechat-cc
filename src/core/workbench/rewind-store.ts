import { randomUUID } from 'node:crypto'
import type { Db } from '../../lib/db'

/**
 * 回退记录(v81,回退设计稿):一次回退 / 撤销回退一行。先插 `applying`(意图),做完改 `done`,回滚改 `failed`。
 * 撤销回退也是一行:target_artifact_id = `undo:<被撤的那一行>`,目标 = 那一行的备份 B,discarded 为空。
 * 制品与审阅标记从不动 —— 「已撤掉」只靠这里的 discarded_json 标。
 */
export interface RewindRow {
  id: string; taskId: string; targetArtifactId: string; targetPoint: 'start' | 'end'
  targetCommit: string; priorHead: string; backupRef: string; backupCommit: string
  discarded: string[]; state: 'applying' | 'done' | 'failed'
  noticeSentAt: number | null; createdAt: number; undoneAt: number | null
}
type Row = Omit<RewindRow, 'discarded'> & { discardedJson: string }
const SELECT = 'SELECT id,task_id AS taskId,target_artifact_id AS targetArtifactId,target_point AS targetPoint,target_commit AS targetCommit,prior_head AS priorHead,backup_ref AS backupRef,backup_commit AS backupCommit,discarded_json AS discardedJson,state,notice_sent_at AS noticeSentAt,created_at AS createdAt,undone_at AS undoneAt FROM workbench_rewinds'
const UNDO = 'undo:'
const parse = ({ discardedJson, ...row }: Row): RewindRow => {
  let discarded: string[] = []
  try { const v: unknown = JSON.parse(discardedJson); if (Array.isArray(v)) discarded = v.filter((x): x is string => typeof x === 'string') } catch { /* 坏行当没撤 */ }
  return { ...row, discarded }
}
export const isUndoRow = (row: Pick<RewindRow, 'targetArtifactId'>) => row.targetArtifactId.startsWith(UNDO)
export const undoTargetId = (rowId: string) => `${UNDO}${rowId}`

export function makeRewindStore(db: Db, bump: (taskId: string) => number) {
  const get = (id: string) => { const row = db.query<Row, [string]>(`${SELECT} WHERE id=?`).get(id); return row ? parse(row) : null }
  const rows = (taskId: string) => db.query<Row, [string]>(`${SELECT} WHERE task_id=? ORDER BY created_at,rowid`).all(taskId).map(parse)
  const tx = <T>(fn: () => T) => db.transaction(fn)()
  return {
    get,
    list: rows,
    /** 写意图(state='applying')。 */
    record(input: Omit<RewindRow, 'id' | 'state' | 'noticeSentAt' | 'createdAt' | 'undoneAt'> & { createdAt?: number }): RewindRow {
      const id = randomUUID()
      tx(() => {
        db.query("INSERT INTO workbench_rewinds(id,task_id,target_artifact_id,target_point,target_commit,prior_head,backup_ref,backup_commit,discarded_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'applying',?)")
          .run(id, input.taskId, input.targetArtifactId, input.targetPoint, input.targetCommit, input.priorHead, input.backupRef, input.backupCommit, JSON.stringify(input.discarded), input.createdAt ?? Date.now())
        bump(input.taskId)
      })
      return get(id)!
    },
    setState(id: string, state: 'done' | 'failed') {
      const row = get(id); if (!row) return
      tx(() => { db.query("UPDATE workbench_rewinds SET state=? WHERE id=? AND state='applying'").run(state, id); bump(row.taskId) })
    },
    /** 所有还卡在 applying 的(开机对账)。 */
    applying: () => db.query<Row, []>(`${SELECT} WHERE state='applying' ORDER BY created_at,rowid`).all().map(parse),
    /** 最近一次做成的回退 / 撤销回退。 */
    latest(taskId: string): RewindRow | null { return rows(taskId).filter(r => r.state === 'done').at(-1) ?? null },
    /** 已撤掉的轮次(制品 id):做成、没被撤销的回退里 discarded 的并集。 */
    discarded(taskId: string): Set<string> {
      const out = new Set<string>()
      for (const r of rows(taskId)) if (r.state === 'done' && r.undoneAt === null && !isUndoRow(r)) for (const id of r.discarded) out.add(id)
      return out
    },
    /** 还没告诉执行者的(做成、notice_sent_at 为空),旧 → 新。 */
    pendingNotice: (taskId: string) => rows(taskId).filter(r => r.state === 'done' && r.noticeSentAt === null),
    markNoticed(taskId: string, ids: readonly string[], at = Date.now()) {
      if (!ids.length) return
      tx(() => { for (const id of ids) db.query('UPDATE workbench_rewinds SET notice_sent_at=COALESCE(notice_sent_at,?) WHERE id=? AND task_id=?').run(at, id, taskId); bump(taskId) })
    },
    /**
     * 撤销回退做成了:原行记 undone_at。原行的告知还没发 ⇒ 执行者从来不知道那次回退,两行都记成已告知(什么都不用说)。
     */
    undo(rowId: string, undoRowId: string, at = Date.now()) {
      const row = get(rowId); if (!row) return
      tx(() => {
        db.query('UPDATE workbench_rewinds SET undone_at=COALESCE(undone_at,?) WHERE id=?').run(at, rowId)
        if (row.noticeSentAt === null) db.query('UPDATE workbench_rewinds SET notice_sent_at=COALESCE(notice_sent_at,?) WHERE id IN (?,?)').run(at, rowId, undoRowId)
        bump(row.taskId)
      })
    },
  }
}
export type RewindStore = ReturnType<typeof makeRewindStore>
