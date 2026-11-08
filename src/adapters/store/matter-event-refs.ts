/**
 * 「这是哪一轮」的读法(S3a):各条路给同一个事件算同一个键(domain/speech/event-ref.ts)时,从 matter_turns 读那一轮的 seq。
 * 只读;写口仍只有 matter-log.ts。读不到(没有这件事 / 一轮都没有)⇒ null,调用方就不带键(账照旧一判一行)。
 */
import type { Db } from '../../lib/db'
import { turnRef } from '../../domain/speech/event-ref'

export interface MatterEventRefs {
  /** 这件事最新那一轮(探测到「做完了」那一刻就是它)。 */
  latestTurn(matterId: string): string | null
  /** 某一个 run 的最后一轮(工作台 run 终态的通知)。 */
  lastTurnOfRun(matterId: string, runId: string): string | null
}

export function makeMatterEventRefs(db: Db): MatterEventRefs {
  const ref = (matterId: string, row: { seq: number | null } | null | undefined) => typeof row?.seq === 'number' ? turnRef(matterId, row.seq) : null
  const guard = (f: () => string | null): string | null => { try { return f() } catch { return null } }
  return {
    latestTurn: id => guard(() => ref(id, db.query<{ seq: number | null }, [string]>('SELECT MAX(seq) AS seq FROM matter_turns WHERE matter_id=?').get(id))),
    lastTurnOfRun: (id, runId) => guard(() => ref(id, db.query<{ seq: number | null }, [string, string]>('SELECT MAX(seq) AS seq FROM matter_turns WHERE matter_id=? AND run_id=?').get(id, runId))),
  }
}
