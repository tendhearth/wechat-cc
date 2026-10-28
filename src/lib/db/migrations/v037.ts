import type { Migration } from './types'

// v37 — hunt_catch 加 kind:'hunt'(打猎带回的东西)| 'visit'(串门带回的见闻)。
//
// WHY(2026-09-03):串门(core/visit.ts)让伙伴回家跟主人讲一段话。那段话
// 发到微信就没了,跟打猎一开始的洞一模一样。背包本来就是「CC 出门带回来
// 的」,东西和见闻是同一个面的两个分类,不另开一张表。
//
// 列存在守卫,不是表守卫:#79 修复路径重放时 hunt_catch 会活下来(v36 用了
// IF NOT EXISTS),裸 ALTER 会抛 duplicate column name。同 v35。
export const migration: Migration = (db) => {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('hunt_catch')").all()
    if (cols.length === 0 || cols.some(c => c.name === 'kind')) return
    db.exec(`ALTER TABLE hunt_catch ADD COLUMN kind TEXT NOT NULL DEFAULT 'hunt';`)
  }
