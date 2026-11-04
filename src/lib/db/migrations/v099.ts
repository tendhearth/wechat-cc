import type { Migration } from './types'

// v99 — 删掉 turn_records(2026-11-04,设计稿 2026-11-02-m3-chat-turns-design.md §M3c)。M3b(v97)起回合记录在这件对话的轮上
// (matter_turns),turn_records 停写;564f69fe 在真机上跑满 soak 之后删。回滚到 v97 以前的版本读不到回合记录(只少诊断用的历史,
// 不影响对话)。可重放:IF EXISTS。
export const migration: Migration = (db) => {
    db.exec('DROP TABLE IF EXISTS turn_records')
  }
