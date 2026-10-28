import type { Migration } from './types'

// v42 — turn_records.tool_calls 的分支编号碰撞自愈。
//
// 2026-09-03 的 Atelier 工作树曾把 reminders 自愈作为自己的 v35 跑在本机；
// 随后 origin/dev 的正式 v35 用来新增 tool_calls。PRAGMA user_version 只记
// 数量，所以那台机器升级时会跳过正式 v35，却继续跑 v36+，最终在启动
// turn-record store 时因缺列崩溃。不能改写已发布 v35；在数组尾部再做一次
// 列存在守卫，既修复受影响数据库，也对正常数据库保持无操作。
export const migration: Migration = (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='turn_records'")
      .get()
    if (!found || found.cnt === 0) return
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('turn_records')").all()
    if (cols.some(c => c.name === 'tool_calls')) return
    db.exec('ALTER TABLE turn_records ADD COLUMN tool_calls TEXT;')
  }
