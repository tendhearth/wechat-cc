import type { Migration } from './types'

// v73 — 工作台「没确认退出」(writer_not_closed)记下执行程序的进程组(workbench_tasks.writer_groups,JSON 数组)。
//
// WHY:关不掉的执行程序可能还在写那个文件夹,所以占用要等退出证据才解除。以前证据只能来自本进程里的
// close() 迟到成功;daemon 一重启,证据永远等不到 —— 记录卡住、归档不了,而新任务其实已经不受保护了
// (占用只在内存里)。记下进程组,重启后能逐个查:都没了 = 退出证据;还在 = 重新挂回占用。
// NULL = 旧记录 / 执行者交不出进程组,只能由主人确认。守表同 v71。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='workbench_tasks'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info('workbench_tasks')").all().map(c => c.name))
    if (!cols.has('writer_groups')) db.exec(`ALTER TABLE workbench_tasks ADD COLUMN writer_groups TEXT;`)
  }
