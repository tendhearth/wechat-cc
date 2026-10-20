import { randomUUID } from 'node:crypto'
import type { Db } from '../../lib/db'

/**
 * 回退记录(v81,回退设计稿):一次回退 / 撤销回退一行。先插 `applying`(意图),做完改 `done`,回滚改 `failed`。
 * 撤销回退也是一行:target_artifact_id = `undo:<被撤的那一行>`,目标 = 那一行的备份 B,discarded 为空。
 * 制品与审阅标记从不动 —— 「已撤掉」只靠这里的 discarded_json 标。
 * needs_owner(评审 #433-4):回滚没回干净 / 开机对账说不清 ⇒ 这件事停住(派发、补充、工作区动作一律 rewind_needs_owner),
 * 直到主人选 resolution(keep / restore_backup);选完行变 failed,但告知照样要送到执行者(pendingNotice 认 resolution)。
 */
export interface RewindRow {
  id: string; taskId: string; targetArtifactId: string; targetPoint: 'start' | 'end'
  targetCommit: string; priorHead: string; backupRef: string; backupCommit: string
  discarded: string[]; state: 'applying' | 'done' | 'failed' | 'needs_owner'
  resolution: 'keep' | 'restore_backup' | null
  noticeSentAt: number | null; createdAt: number; undoneAt: number | null
}
type Row = Omit<RewindRow, 'discarded'> & { discardedJson: string }
const SELECT = 'SELECT id,task_id AS taskId,target_artifact_id AS targetArtifactId,target_point AS targetPoint,target_commit AS targetCommit,prior_head AS priorHead,backup_ref AS backupRef,backup_commit AS backupCommit,discarded_json AS discardedJson,state,resolution,notice_sent_at AS noticeSentAt,created_at AS createdAt,undone_at AS undoneAt FROM workbench_rewinds'
const UNDO = 'undo:'
const parse = ({ discardedJson, ...row }: Row): RewindRow => {
  let discarded: string[] = []
  try { const v: unknown = JSON.parse(discardedJson); if (Array.isArray(v)) discarded = v.filter((x): x is string => typeof x === 'string') } catch { /* 坏行当没撤 */ }
  return { ...row, discarded }
}
export const isUndoRow = (row: Pick<RewindRow, 'targetArtifactId'>) => row.targetArtifactId.startsWith(UNDO)
export const undoTargetId = (rowId: string) => `${UNDO}${rowId}`
export const RESTORE_PREFIX = 'restore:'
/** 主人拍板「恢复到回退之前」做成的那一行(target_artifact_id = `restore:<停住的那一行>`)。 */
export const isRestoreRow = (row: Pick<RewindRow, 'targetArtifactId'>) => row.targetArtifactId.startsWith(RESTORE_PREFIX)

/**
 * 停住时写进时间线那句的固定结尾(park 一律带上)。详情里的停住原因只认带它的那条 system 事件 ——
 * 之后别的 system 事件(会话收工、goal 停了这类)不会顶掉它。不加迁移(v81 已发,v82 别人占着)。
 */
export const REWIND_PARK_NOTE_TAIL = '(要选「恢复」时,如果工作区里留着上次崩溃的 .git 锁文件 index.lock / HEAD.lock,先删掉它。)'
export const isRewindParkNote = (text: string) => text.endsWith(REWIND_PARK_NOTE_TAIL)

/**
 * 详情里给桌面的回退状态(切片 3):undo = 最近一次还能撤销的回退(之后没有新的审阅轮);
 * blocked = 停住等主人拍板的那一行 + 时间线里那句原因。两样都没有 ⇒ null(详情不带这个字段)。
 */
export interface RewindView {
  undo: { rewindId: string; createdAt: number } | null
  blocked: { rewindId: string; backupRef: string; reason: string | null } | null
}
export function rewindView(rewinds: Pick<RewindStore, 'latest' | 'blocker'>, taskId: string, reviewTimes: readonly number[], reasonSince: (at: number) => string | null): RewindView | null {
  let latest: RewindRow | null = null, blocker: RewindRow | null = null
  try { latest = rewinds.latest(taskId); blocker = rewinds.blocker(taskId) } catch { return null /* 表不在 */ }
  const undo = latest && !isUndoRow(latest) && !isRestoreRow(latest) && latest.undoneAt === null && !reviewTimes.some(t => t > latest!.createdAt)
    ? { rewindId: latest.id, createdAt: latest.createdAt } : null
  const blocked = blocker?.state === 'needs_owner' ? { rewindId: blocker.id, backupRef: blocker.backupRef, reason: reasonSince(blocker.createdAt) } : null
  return undo || blocked ? { undo, blocked } : null
}

/** 这件事被回退停住了吗:applying(正在做 / 开机还没对完账)⇒ workbench_busy;needs_owner ⇒ rewind_needs_owner。 */
export function assertNotRewindBlocked(rewinds: { blocking(taskId: string): 'applying' | 'needs_owner' | null }, taskId: string): void {
  let state: 'applying' | 'needs_owner' | null = null
  try { state = rewinds.blocking(taskId) } catch { return /* 表不在(老测试只建了几张表) */ }
  if (state === 'needs_owner') throw new Error('rewind_needs_owner')
  if (state === 'applying') throw new Error('workbench_busy')
}

export function makeRewindStore(db: Db, bump: (taskId: string) => number) {
  const get = (id: string) => { const row = db.query<Row, [string]>(`${SELECT} WHERE id=?`).get(id); return row ? parse(row) : null }
  const rows = (taskId: string) => db.query<Row, [string]>(`${SELECT} WHERE task_id=? ORDER BY created_at,rowid`).all(taskId).map(parse)
  const tx = <T>(fn: () => T) => db.transaction(fn)()
  return {
    get,
    list: rows,
    /** 写意图(state='applying')。 */
    record(input: Omit<RewindRow, 'id' | 'state' | 'resolution' | 'noticeSentAt' | 'createdAt' | 'undoneAt'> & { createdAt?: number }): RewindRow {
      const id = randomUUID()
      tx(() => {
        db.query("INSERT INTO workbench_rewinds(id,task_id,target_artifact_id,target_point,target_commit,prior_head,backup_ref,backup_commit,discarded_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'applying',?)")
          .run(id, input.taskId, input.targetArtifactId, input.targetPoint, input.targetCommit, input.priorHead, input.backupRef, input.backupCommit, JSON.stringify(input.discarded), input.createdAt ?? Date.now())
        bump(input.taskId)
      })
      return get(id)!
    },
    /** applying ⇒ done / failed / needs_owner。 */
    setState(id: string, state: 'done' | 'failed' | 'needs_owner') {
      const row = get(id); if (!row) return
      tx(() => { db.query("UPDATE workbench_rewinds SET state=? WHERE id=? AND state='applying'").run(state, id); bump(row.taskId) })
    },
    /** 主人拍板了停住的那一行:needs_owner ⇒ failed + resolution(告知随后送达执行者)。 */
    resolve(id: string, resolution: 'keep' | 'restore_backup') {
      const row = get(id); if (!row) return
      tx(() => { db.query("UPDATE workbench_rewinds SET state='failed',resolution=?,notice_sent_at=NULL WHERE id=? AND state='needs_owner'").run(resolution, id); bump(row.taskId) })
    },
    /** 所有还卡在 applying 的(开机对账)。 */
    applying: () => db.query<Row, []>(`${SELECT} WHERE state='applying' ORDER BY created_at,rowid`).all().map(parse),
    /** 停住这件事的那一行(needs_owner 优先);没有 ⇒ null。 */
    blocker(taskId: string): RewindRow | null {
      const row = db.query<Row, [string]>(`${SELECT} WHERE task_id=? AND state IN ('applying','needs_owner') ORDER BY CASE state WHEN 'needs_owner' THEN 0 ELSE 1 END,created_at DESC LIMIT 1`).get(taskId)
      return row ? parse(row) : null
    },
    blocking(taskId: string): 'applying' | 'needs_owner' | null {
      return db.query<{ state: 'applying' | 'needs_owner' }, [string]>("SELECT state FROM workbench_rewinds WHERE task_id=? AND state IN ('applying','needs_owner') ORDER BY CASE state WHEN 'needs_owner' THEN 0 ELSE 1 END LIMIT 1").get(taskId)?.state ?? null
    },
    /** 最近一次做成的回退 / 撤销回退。 */
    latest(taskId: string): RewindRow | null { return rows(taskId).filter(r => r.state === 'done').at(-1) ?? null },
    /** 已撤掉的轮次(制品 id):做成、没被撤销的回退里 discarded 的并集。 */
    discarded(taskId: string): Set<string> {
      const out = new Set<string>()
      for (const r of rows(taskId)) if (r.state === 'done' && r.undoneAt === null && !isUndoRow(r)) for (const id of r.discarded) out.add(id)
      return out
    },
    /** 还没告诉执行者的(做成的,或主人拍板过的停住行;notice_sent_at 为空),旧 → 新。 */
    pendingNotice: (taskId: string) => rows(taskId).filter(r => (r.state === 'done' || r.resolution !== null) && r.noticeSentAt === null),
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
