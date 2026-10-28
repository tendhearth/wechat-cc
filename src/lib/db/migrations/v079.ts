import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v79 — 独立工作区的脚本与端口(2026-10-20,对标 Conductor):仓库根 tendhearth.json 的 setup / run / archive。
// script_sha = 建工作区时的 HEAD,脚本一律从这个提交读(git cat-file),不读工作树 —— 执行者改了文件也换不掉要跑的脚本。
// port = 每个工作区一个端口(47100–48999),部分唯一索引防两个工作区拿到同一个;script_groups = 在跑脚本的进程组(同 writer_groups 的写法);
// setup_at = setup 跑完的时刻。workbench_script_approvals:主人批过的(仓库, 脚本内容哈希),内容一变就要重新批。
// 守表同 v75;批准表不依赖工作区表,照建。
export const migration: Migration = (db) => {
    if(hasTable(db,'workbench_worktrees')){
      const cols=new Set(db.query<{name:string},[]>("PRAGMA table_info('workbench_worktrees')").all().map(c=>c.name))
      if(!cols.has('script_sha'))db.exec('ALTER TABLE workbench_worktrees ADD COLUMN script_sha TEXT;')
      if(!cols.has('port'))db.exec('ALTER TABLE workbench_worktrees ADD COLUMN port INTEGER;')
      if(!cols.has('script_groups'))db.exec('ALTER TABLE workbench_worktrees ADD COLUMN script_groups TEXT;')
      if(!cols.has('setup_at'))db.exec('ALTER TABLE workbench_worktrees ADD COLUMN setup_at INTEGER;')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workbench_worktrees_port ON workbench_worktrees(port) WHERE port IS NOT NULL;')
    }
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_script_approvals (
      repo_key TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      PRIMARY KEY(repo_key, config_hash)
    );`)
  }
