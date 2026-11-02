import type { Migration } from './types'

// v96 — 一件事最后一次有动静时的全库游标(2026-11-02,P1 设计稿 2026-11-02-p1-change-feed-design.md §P1a)。轮 / 步每写一次、
// 以及非步的变化(状态、权限卡、成果批准…经 MatterLog.touch)都推进 matter_log_cursor,同时记在这件事的 cursor 上 ——
// 订阅只认这一个数。存量按这件事已有的轮 / 步里最大的那个游标补;没有轮 / 步的是 0。只有 matter-log.ts 写这一列。
// 可重放:列已经在就不再加;补值只往大里补。
export const migration: Migration = (db) => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(matters)').all()
    if (!columns.some(column => column.name === 'cursor')) db.exec('ALTER TABLE matters ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      UPDATE matters SET cursor = MAX(cursor,
        COALESCE((SELECT MAX(cursor) FROM matter_items WHERE matter_id = matters.id), 0),
        COALESCE((SELECT MAX(cursor) FROM matter_turns WHERE matter_id = matters.id), 0));
    `)
  }
