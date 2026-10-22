import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v66 — 回报放弃窗口的锚点从「这行何时创建」(created_at)改成「它第一次真的
// 失败是什么时候」(first_fail_at,评审修复轮 3):主人一整天不回微信时,这段
// 时间全是 errcode=-2 的退避,created_at 早早就过了 24h——这时第一次真正的
// 送达失败(网络抖动、风控)会被误判成"早该放弃"。first_fail_at 只在非 -2
// 失败时写一次(已有值不动);为空 = 从没真的失败过,放弃判定永远不成立。
export const migration: Migration = (db) => {
    if(!hasTable(db,'matter_report_outbox'))return
    const columns=db.query<{name:string},[]>('PRAGMA table_info(matter_report_outbox)').all()
    if(!columns.some(column=>column.name==='first_fail_at'))db.exec('ALTER TABLE matter_report_outbox ADD COLUMN first_fail_at INTEGER')
  }
