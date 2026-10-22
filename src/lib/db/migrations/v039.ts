import type { Migration } from './types'

// v39 — penpal_letter 加 kind / payload:社交信封(架构重构 §2.1,core/envelope.ts)。
//
// 此前每个社交功能一条路由;串门为了不加路由往明文塞头部。现在密封明文里
// 只有一种结构 `⟪env⟫{kind,payload}`,在 correspondent 一处解析、按 kind 分发。
// kind='letter' 是主人写的真信(明文即信,payload NULL)。
// 表名不改:概念上它是 social_message,改名只有搬迁成本。
//
// 两列各自带列存在守卫(同 v35/v37/v38)。#79 重放路径下 penpal_letter 会被
// drop 重建,但守卫不多余:任何一条只跑到一半的迁移都会留下半张表。
export const migration: Migration = (db) => {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('penpal_letter')").all()
    if (cols.length === 0) return
    if (!cols.some(c => c.name === 'kind')) db.exec(`ALTER TABLE penpal_letter ADD COLUMN kind TEXT NOT NULL DEFAULT 'letter';`)
    if (!cols.some(c => c.name === 'payload')) db.exec(`ALTER TABLE penpal_letter ADD COLUMN payload TEXT;`)
  }
