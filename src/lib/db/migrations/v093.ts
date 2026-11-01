import type { Migration } from './types'

// v93 — 一起做的时间线搬进 matter_items(2026-11-01,设计稿 2026-10-31 §4 M2)。任务与它的那件事同 id;每条 workbench_events
// 变成一步,id 原样保留(桌面 / 手机手里记着的事件 id、交接记的那条请求都不变),每件事里按 id 排 seq。payload 只存有的字段
// (text、v = 写这条时任务的版本号、sourceId、runId、activity、attachments),和 src/adapters/store/workbench/timeline-events.ts
// 写出来的一模一样。步的状态跟着工具调用自己的状态走(还在跑 ⇒ started;做完 ⇒ completed;失败 / 取消 / 中断 ⇒ failed)。
// 同一个执行者 item 的 key 带上 run(搬家前是 (task_id, run_id, event_key) 唯一)。游标按 id 顺序接着往下数。
// 先给没挂 matter 的老任务补一件事(真机 0 条,照 v60 / v92 的推法以防万一)。
// workbench_handoffs.request_event_id 的外键改指 matter_items(id)(重建表;它没有子表,外键开着重建即可)。
// workbench_events 本身留着、不再写 —— self deploy 回滚到上一版时它还要读;M2c 再删。
// 可重放:只搬还没搬过的(matter_items 里没有同 id 的),外键已经改过就不再重建。
export const migration: Migration = (db) => {
    // 「同 id 已经在 matter_items 里」只在它就是这条事件搬过去的那一步时才算搬过(重放);属于别的事 ⇒ 两边的 id 撞了,
    // 悄悄跳过会让交接记的请求指到一条无关的步上 —— 直接报错,整条回滚(Codex 评审 P1;v92 发布的版本里没人写步,真机不会撞)。
    const clash = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workbench_events e JOIN matter_items i ON i.id=e.id WHERE i.matter_id<>e.task_id').get()!.n
    if (clash) throw new Error(`v93: ${clash} workbench_events ids collide with matter_items of other matters`)
    db.exec(`
      INSERT INTO matters(id,kind,initiator,title,project_path,state,archived_at,status,owner_chat_id,created_at,updated_at)
        SELECT t.id,'task','owner',t.title,t.path,
               CASE WHEN t.status IN ('queued','running','cancelling') THEN 'working'
                    WHEN t.status='completed' THEN 'done'
                    WHEN t.status IN ('failed','interrupted') THEN 'failed'
                    ELSE 'cancelled' END,
               t.archived_at,
               CASE WHEN t.archived_at IS NOT NULL THEN 'archived'
                    WHEN t.status IN ('completed','failed','cancelled') THEN 'done'
                    ELSE 'open' END,
               t.owner_chat_id,t.created_at,t.updated_at
        FROM workbench_tasks t WHERE t.id NOT IN (SELECT id FROM matters);
      UPDATE workbench_tasks SET matter_id=id WHERE matter_id IS NULL;

      INSERT INTO matter_items(id,matter_id,turn_id,seq,kind,status,item_key,message_id,payload_json,created_at,updated_at,cursor)
        SELECT e.id, e.task_id, NULL,
               (SELECT COALESCE(MAX(seq),0) FROM matter_items WHERE matter_id=e.task_id) + ROW_NUMBER() OVER (PARTITION BY e.task_id ORDER BY e.id),
               CASE e.kind WHEN 'user' THEN 'user_message' WHEN 'text' THEN 'agent_message' ELSE e.kind END,
               CASE WHEN e.kind<>'tool_call' OR e.activity_json IS NULL THEN 'completed'
                    WHEN json_extract(e.activity_json,'$.status')='running' THEN 'started'
                    WHEN json_extract(e.activity_json,'$.status')='completed' THEN 'completed'
                    ELSE 'failed' END,
               CASE WHEN e.event_key IS NULL THEN NULL ELSE json_array(e.run_id, e.event_key) END,
               NULL,
               json_patch(json_object('text',e.text,'v',e.seq),
                          json_object('sourceId',e.source_id,'runId',e.run_id,'activity',json(e.activity_json),
                                      'attachments',CASE WHEN e.attachments_json='[]' THEN NULL ELSE json(e.attachments_json) END)),
               e.created_at, e.created_at,
               (SELECT value FROM matter_log_cursor WHERE id=1) + ROW_NUMBER() OVER (ORDER BY e.id)
        FROM workbench_events e WHERE e.id NOT IN (SELECT id FROM matter_items);
      UPDATE matter_log_cursor SET value=MAX(value,(SELECT COALESCE(MAX(cursor),0) FROM matter_items)) WHERE id=1;
    `)
    const handoffs = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='workbench_handoffs'").get()
    if (handoffs && !handoffs.sql.includes('REFERENCES matter_items(id)')) db.exec(`
      CREATE TABLE workbench_handoffs_v93 (
        id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        target_task_id TEXT NOT NULL REFERENCES workbench_tasks(id),
        purpose TEXT NOT NULL CHECK(purpose IN ('review','revision')), request TEXT NOT NULL,
        packet_sha256 TEXT NOT NULL, artifact_refs_json TEXT NOT NULL, quote_json TEXT,
        created_at INTEGER NOT NULL, request_event_id INTEGER REFERENCES matter_items(id),
        source_native_id TEXT, target_native_id TEXT,
        packet_json TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE
      ) STRICT;
      INSERT INTO workbench_handoffs_v93(id,source_task_id,target_task_id,purpose,request,packet_sha256,artifact_refs_json,quote_json,created_at,request_event_id,source_native_id,target_native_id,packet_json,token_hash)
        SELECT id,source_task_id,target_task_id,purpose,request,packet_sha256,artifact_refs_json,quote_json,created_at,request_event_id,source_native_id,target_native_id,packet_json,token_hash FROM workbench_handoffs;
      DROP TABLE workbench_handoffs;
      ALTER TABLE workbench_handoffs_v93 RENAME TO workbench_handoffs;
      CREATE INDEX workbench_handoffs_source ON workbench_handoffs(source_task_id,created_at);
      CREATE INDEX workbench_handoffs_target ON workbench_handoffs(target_task_id,created_at);
    `)
  }
