import type { Migration } from './types'

// v95 — 删掉一起做搬家前的三张表(2026-11-02,设计稿 2026-10-31 §4 M2c)。时间线 v93 已经搬进 matter_items,执行设置与用量 v94
// 已经搬进 matter_turns;两版在真机上都跑过、soak 过,从此 src 里不再有人读写它们。删了就回不到 v93 之前的版本了(那一版要读
// workbench_events)—— 所以这一条只在 v94 部署且 soak 绿之后才进。没有别的表用外键指着它们(交接那条 v93 已改指 matter_items),
// 索引跟着表一起没。可重放:IF EXISTS,删过了再跑一次什么都不做。
export const migration: Migration = (db) => {
    db.exec(`
      DROP TABLE IF EXISTS workbench_events;
      DROP TABLE IF EXISTS workbench_run_execution;
      DROP TABLE IF EXISTS workbench_turn_usage;
    `)
  }
