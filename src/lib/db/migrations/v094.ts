import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v94 — 一起做的执行设置与用量搬进 matter_turns(2026-11-02,设计稿 2026-10-31 §4 M2b)。任务与它的那件事同 id。
// ① 每行 workbench_turn_usage(一个带用量的 result)= 一轮,做完了(completed):执行者 = 那行记的 provider_id,用量只存有的项
//    (json_patch 把 null 去掉,和 src/domain/turn-usage.ts 写出来的一样);一条 run 的第一轮从接受那一刻算起(lastExecution.createdAt
//    照旧),其余从 at − duration_ms 算起,到 at 结束。
// ② 每条 workbench_run_execution(接受过的一条 run)的执行设置抄进它每一轮的 policy:{choice, effective?, observedAt?};模型取实际的,
//    没报过就取选的。一条 run 一行用量都没有(这家不报用量,或没跑到回应)⇒ 补一轮:任务最后一条 run 的结局跟着任务的状态
//    (还在跑的记中断 —— 开机 recover 本来也要把它记成中断),更早的 run 记做完。
// 每件事里按(接受时刻, run, 第几轮)排 seq;游标接着往下数。轮的 id 是 'v94:<run>:<第几轮>',所以重放不重复搬。
// 两张旧表留着、不再写 —— self deploy 回滚到上一版时它还要读;M2c 再删。
export const migration: Migration = (db) => {
    if (!hasTable(db, 'workbench_run_execution') || !hasTable(db, 'workbench_turn_usage')) return
    db.exec(`
      CREATE TEMP TABLE v94_turns AS
      WITH runs AS (
        SELECT r.*, t.provider_id, t.status AS task_status, t.updated_at AS task_updated_at,
               ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.created_at DESC, r.rowid DESC) AS recency
        FROM workbench_run_execution r JOIN workbench_tasks t ON t.id = r.task_id
      ),
      usage_turns AS (
        SELECT u.task_id, u.run_id, u.turn_seq, u.provider_id AS executor,
               COALESCE(json_extract(r.effective_json,'$.model'), json_extract(r.choice_json,'$.model')) AS model,
               'completed' AS status,
               json_patch('{}', json_object('input',u.input_tokens,'output',u.output_tokens,'cacheRead',u.cache_read_tokens,
                                            'cacheWrite',u.cache_write_tokens,'reasoning',u.reasoning_tokens,'costUsd',u.cost_usd)) AS usage_json,
               r.choice_json, r.effective_json, r.observed_at,
               CASE WHEN r.run_id IS NOT NULL AND ROW_NUMBER() OVER (PARTITION BY u.run_id ORDER BY u.turn_seq) = 1 THEN r.created_at
                    ELSE u.at - COALESCE(u.duration_ms, 0) END AS started_at,
               u.at AS ended_at,
               COALESCE(r.created_at, u.at) AS run_at
        FROM workbench_turn_usage u LEFT JOIN workbench_run_execution r ON r.run_id = u.run_id AND r.task_id = u.task_id
      ),
      bare_runs AS (
        SELECT r.task_id, r.run_id, 0 AS turn_seq, r.provider_id AS executor,
               COALESCE(json_extract(r.effective_json,'$.model'), json_extract(r.choice_json,'$.model')) AS model,
               CASE WHEN r.recency > 1 THEN 'completed'
                    WHEN r.task_status IN ('completed','failed','cancelled','interrupted') THEN r.task_status
                    ELSE 'interrupted' END AS status,
               NULL AS usage_json, r.choice_json, r.effective_json, r.observed_at,
               r.created_at AS started_at,
               CASE WHEN r.recency = 1 THEN MAX(r.task_updated_at, r.created_at) ELSE COALESCE(r.observed_at, r.created_at) END AS ended_at,
               r.created_at AS run_at
        FROM runs r WHERE NOT EXISTS (SELECT 1 FROM workbench_turn_usage u WHERE u.run_id = r.run_id AND u.task_id = r.task_id)
      ),
      everything AS (SELECT * FROM usage_turns UNION ALL SELECT * FROM bare_runs)
      SELECT 'v94:' || e.run_id || ':' || e.turn_seq AS id, e.task_id AS matter_id, e.run_id, e.executor, e.model, e.status, e.usage_json,
             CASE WHEN e.choice_json IS NULL THEN NULL
                  ELSE json_patch(json_object('choice', json(e.choice_json)),
                                  json_object('effective', json(e.effective_json), 'observedAt', e.observed_at)) END AS policy_json,
             e.started_at, e.ended_at,
             (SELECT COALESCE(MAX(seq),0) FROM matter_turns WHERE matter_id = e.task_id)
               + ROW_NUMBER() OVER (PARTITION BY e.task_id ORDER BY e.run_at, e.run_id, e.turn_seq) AS seq,
             (SELECT value FROM matter_log_cursor WHERE id = 1)
               + ROW_NUMBER() OVER (ORDER BY e.run_at, e.task_id, e.run_id, e.turn_seq) AS cursor
      FROM everything e WHERE 'v94:' || e.run_id || ':' || e.turn_seq NOT IN (SELECT id FROM matter_turns);

      INSERT INTO matter_turns(id,matter_id,seq,run_id,executor,model,native_session_id,status,error_code,usage_json,policy_json,started_at,ended_at,cursor)
        SELECT id,matter_id,seq,run_id,executor,model,NULL,status,NULL,usage_json,policy_json,started_at,ended_at,cursor FROM v94_turns ORDER BY cursor;
      UPDATE matter_log_cursor SET value = MAX(value, (SELECT COALESCE(MAX(cursor),0) FROM matter_turns)) WHERE id = 1;
      DROP TABLE v94_turns;
    `)
  }
