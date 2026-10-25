import type { SqlDatabase as Database } from '../runtime/sqlite'

// 迁移和 db.ts 共用的几样(第三批 3e 从 db.ts 原样搬出来):迁移文件不能 import db.ts(会成环)。
/**
 * 工作台表的建表语句 —— 放在这里而不是各自模块里,是因为 `src/lib` 是依赖树的底,
 * 不能反向依赖上面的层(adapters / app / features …)(depcruise `lib-must-not-depend-on-anything-internal`)。
 * 迁移阶梯本来就在本文件,v46 起的工作台表也都写在这儿;这三个只是补齐同一处。
 * 模块侧按原名再导出,单测照旧可以只建自己那几张表,不跑整条阶梯。
 */
export function initializeWechatNotificationSchema(db: Database):void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_wechat_subscriptions (
      task_id TEXT PRIMARY KEY NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      owner_chat_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      generation INTEGER NOT NULL CHECK(generation >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workbench_wechat_notices (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      subscription_generation INTEGER NOT NULL CHECK(subscription_generation >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('permission','question','completed','failed','interrupted','cancelled')),
      request_id TEXT,
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
      status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','unknown','suppressed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reason TEXT,
      next_attempt_at INTEGER,
      defer_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id,run_id,kind,request_id,subscription_generation)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_wechat_notices_pending ON workbench_wechat_notices(status,next_attempt_at,created_at);
    CREATE INDEX IF NOT EXISTS workbench_wechat_notices_task ON workbench_wechat_notices(task_id,created_at,id);
    CREATE TABLE IF NOT EXISTS workbench_wechat_notice_intents (
      id TEXT PRIMARY KEY NOT NULL,
      notice_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      subscription_generation INTEGER NOT NULL CHECK(subscription_generation >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('permission','question','completed','failed','interrupted','cancelled')),
      request_id TEXT,
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
      status TEXT NOT NULL CHECK(status IN ('pending','materialized','suppressed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reason TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workbench_wechat_notice_intents_pending ON workbench_wechat_notice_intents(status,created_at,id);
  `)
}
export function initializeArtifactDeliverySchema(db: Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_artifact_deliveries (
    id TEXT PRIMARY KEY,
    command_hash TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
    artifact_id TEXT NOT NULL REFERENCES workbench_artifacts(id),
    artifact_sha256 TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size>=0 AND size<=8388608),
    owner_chat_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','uploading','uploaded','sending','accepted','unknown','blocked')),
    media_item_json TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workbench_artifact_deliveries_task ON workbench_artifact_deliveries(task_id,created_at);`)
}
export function initializeApiSessionSchema(db: Database):void{
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_api_sessions(
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
    owner TEXT NOT NULL,
    path TEXT NOT NULL,
    directory_identity TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0),
    messages_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','ready','interrupted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_workbench_api_sessions_task ON workbench_api_sessions(task_id);`)
}
export function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null
}
