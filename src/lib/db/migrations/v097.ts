import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v97 — 对话的回合记录搬进这件对话的轮(2026-11-04,设计稿 2026-11-02-m3-chat-turns-design.md §M3b)。
// turn_records 每一行 = 这件对话(微信绑定 = chat_id)的一轮:做完 ⇒ completed,其余(超时 / 认证 / 出错)⇒ failed,错误码 = 结局。
// 那一行的其余各项(alias、模式、结局、调没调回复工具、文字段数、工具名、出错原文、送达、气泡、附件、旁白段数)记在这一轮的 policy 上,
// 读口(adapters/store/chat-turn-records.ts)从这里拼回同一个形状。null 的项不写(json_patch 去掉)。
// M3a 部署后新旧并行写的那几轮已经在了 ⇒ 一对一配对(同一件事、同一开始时刻、同一家里按结束先后同号相配),配上的不再搬、
// 用那一行把当时还没记的几项补上。
// 找不到这件对话的 chat_id 先补一件(真机 0 个,以防万一),绑上微信。
// 每件事里按开始时刻排 seq,游标接着往下数;轮的 id 是 'v97:<原 id>',重放不重复搬。turn_records 不删(回滚还要读),M3c 删。
export const migration: Migration = (db) => {
    if (!hasTable(db, 'turn_records')) return
    db.exec(`
      CREATE TEMP TABLE v97_chats AS
        SELECT DISTINCT r.chat_id,
          (SELECT m.id FROM matters m JOIN matter_bindings b ON b.matter_id = m.id
             WHERE m.kind = 'chat' AND b.surface = 'wechat' AND b.surface_key = r.chat_id ORDER BY m.updated_at DESC LIMIT 1) AS matter_id
        FROM turn_records r;
      UPDATE v97_chats SET matter_id = lower(hex(randomblob(4))) WHERE matter_id IS NULL;
      INSERT INTO matters(id, kind, initiator, title, state, status, owner_chat_id, created_at, updated_at)
        SELECT c.matter_id, 'chat', 'owner', '对话', 'open', 'open', c.chat_id,
               (SELECT MIN(started_at) FROM turn_records WHERE chat_id = c.chat_id), (SELECT MAX(ended_at) FROM turn_records WHERE chat_id = c.chat_id)
        FROM v97_chats c WHERE c.matter_id NOT IN (SELECT id FROM matters);
      INSERT OR IGNORE INTO matter_bindings(matter_id, surface, surface_key, last_seen_at)
        SELECT c.matter_id, 'wechat', c.chat_id, (SELECT MAX(ended_at) FROM turn_records WHERE chat_id = c.chat_id) FROM v97_chats c;

      -- 旧行与 M3a 并行写下的轮**一对一**配对:同一件事、同一开始时刻、同一家的那一组里,两边各按结束先后编号,同号的配成一对
      -- (同一毫秒的两轮 runner 是支持的,按「这三样」当唯一会把两行对到同一轮上 —— Codex 评审)。
      CREATE TEMP TABLE v97_legacy AS
        SELECT r.rowid AS rid, r.*, c.matter_id,
               ROW_NUMBER() OVER (PARTITION BY c.matter_id, r.started_at, r.provider ORDER BY r.ended_at, r.rowid) AS rn
        FROM turn_records r JOIN v97_chats c ON c.chat_id = r.chat_id;
      CREATE TEMP TABLE v97_pairs AS
        SELECT e.id AS turn_id, l.rid
        FROM (SELECT t.id, t.matter_id, t.started_at, t.executor,
                     ROW_NUMBER() OVER (PARTITION BY t.matter_id, t.started_at, t.executor ORDER BY t.ended_at, t.cursor) AS rn
              FROM matter_turns t WHERE t.matter_id IN (SELECT matter_id FROM v97_chats) AND t.id NOT LIKE 'v97:%') e
        JOIN v97_legacy l ON l.matter_id = e.matter_id AND l.started_at = e.started_at AND l.provider = e.executor AND l.rn = e.rn;
      -- 配上了的:那一轮当时还没记的几项用它那一行补上(只补还没记结局的;收轮时已经记全的不碰),旧行不再搬。
      UPDATE matter_turns SET policy_json = json_patch(COALESCE(policy_json, '{}'), (
          SELECT json_patch(json_object('alias', l.alias, 'mode', l.mode, 'outcome', l.outcome,
                                 'replyToolCalled', json(CASE WHEN l.reply_tool_called <> 0 THEN 'true' ELSE 'false' END),
                                 'textChunks', l.text_chunks, 'toolCalls', json(COALESCE(l.tool_calls, '[]'))),
                     json_object('error', l.error, 'delivery', l.delivery, 'bubbles', l.bubbles,
                                 'attachments', l.attachments, 'narrationSegments', l.narration_segments))
          FROM v97_legacy l JOIN v97_pairs p ON p.rid = l.rid WHERE p.turn_id = matter_turns.id))
        WHERE id IN (SELECT turn_id FROM v97_pairs)
          AND (policy_json IS NULL OR json_extract(policy_json, '$.outcome') IS NULL);

      CREATE TEMP TABLE v97_turns AS
        SELECT 'v97:' || l.id AS id, l.matter_id, l.provider AS executor,
               CASE WHEN l.outcome = 'completed' THEN 'completed' ELSE 'failed' END AS status,
               CASE WHEN l.outcome = 'completed' THEN NULL ELSE l.outcome END AS error_code,
               json_patch(json_object('alias', l.alias, 'mode', l.mode, 'outcome', l.outcome,
                                 'replyToolCalled', json(CASE WHEN l.reply_tool_called <> 0 THEN 'true' ELSE 'false' END),
                                 'textChunks', l.text_chunks, 'toolCalls', json(COALESCE(l.tool_calls, '[]'))),
                     json_object('error', l.error, 'delivery', l.delivery, 'bubbles', l.bubbles,
                                 'attachments', l.attachments, 'narrationSegments', l.narration_segments)) AS policy_json,
               l.started_at, l.ended_at,
               (SELECT COALESCE(MAX(seq), 0) FROM matter_turns WHERE matter_id = l.matter_id)
                 + ROW_NUMBER() OVER (PARTITION BY l.matter_id ORDER BY l.started_at, l.rid) AS seq,
               (SELECT value FROM matter_log_cursor WHERE id = 1) + ROW_NUMBER() OVER (ORDER BY l.ended_at, l.rid) AS cursor
        FROM v97_legacy l
        WHERE 'v97:' || l.id NOT IN (SELECT id FROM matter_turns)
          AND l.rid NOT IN (SELECT rid FROM v97_pairs);
      INSERT INTO matter_turns(id, matter_id, seq, run_id, executor, model, native_session_id, status, error_code, usage_json, policy_json, started_at, ended_at, cursor)
        SELECT id, matter_id, seq, NULL, executor, NULL, NULL, status, error_code, NULL, policy_json, started_at, ended_at, cursor FROM v97_turns ORDER BY cursor;
      UPDATE matter_log_cursor SET value = MAX(value, (SELECT COALESCE(MAX(cursor), 0) FROM matter_turns)) WHERE id = 1;
      UPDATE matters SET cursor = MAX(cursor, (SELECT COALESCE(MAX(t.cursor), 0) FROM matter_turns t WHERE t.matter_id = matters.id))
        WHERE id IN (SELECT matter_id FROM v97_chats);
      DROP TABLE v97_turns;
      DROP TABLE v97_pairs;
      DROP TABLE v97_legacy;
      DROP TABLE v97_chats;
    `)
  }
