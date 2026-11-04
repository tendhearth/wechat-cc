import type { Migration } from './types'

// v100 — cli_sessions 收成指针(2026-11-04,设计稿 2026-11-04-m4-terminal-matter-design.md §M4d 第 2 步)。
// 状态、最近一句、等你那一项从这件事(kind='terminal',matter_bindings surface='cli')推(M4d 第 1 步起读就不看这几列了),
// 删掉 status / last_summary / pending_tool / pending_summary / pending_at;留会话 id、来源、cwd、机器、记录路径、
// origin_agent、最近一次事件 / 发问的时间、建的时间。
//
// 删之前,还没有那件事的老会话(M4a 之前、之后再没来过钩子)按这几列补建那件事,读出来和删列前一样:
//   ended ⇒ 这件事 done;其余 ⇒ open(歇着;列说在跑 / 等你的,真库里都是几天前的,登记处早按 30 分钟折成歇着了,
//   不开轮、不挂卡 —— 权限码只在内存里,重启就作废了);有 last_summary ⇒ 记一步 agent_message(最近一句)。
// 已经有那件事、却还没有一步最后一句的:列里那一句(第 1 步读时 COALESCE 用它)也记成一步。
// 标题 / 项目 / 出生地同钩子第一次建它时(adapters/store/terminal-turns.ts)。真库副本(11-04):121 行里 100 行没有那件事。
//
// 回滚到这之前的版本:老代码要写 status(NOT NULL)会失败 —— 不回滚。没有表指着 cli_sessions,直接重建;
// 索引跟着 DROP 没了,重建。可重放:没有 status 列 ⇒ 已经重建过,跳过。
export const migration: Migration = (db) => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(cli_sessions)').all()
    if (!columns.some(column => column.name === 'status')) return
    const orphans = db.query<{ session_id: string; source: string; cwd: string; status: string; last_summary: string | null; last_event_at: number; created_at: number }, []>(`
      SELECT c.session_id, c.source, c.cwd, c.status, c.last_summary, c.last_event_at, c.created_at FROM cli_sessions c
      WHERE NOT EXISTS (SELECT 1 FROM matter_bindings b JOIN matters m ON m.id = b.matter_id AND m.kind = 'terminal'
                        WHERE b.surface = 'cli' AND b.surface_key = c.session_id)
      ORDER BY c.created_at, c.session_id`).all()
    const freshId = (): string => {
      for (;;) {
        const id = db.query<{ id: string }, []>('SELECT lower(hex(randomblob(4))) AS id').get()!.id
        if (!db.query('SELECT 1 FROM matters WHERE id = ?').get(id)) return id
      }
    }
    const nextCursor = (matterId: string): number => {
      const value = db.query<{ value: number }, []>('UPDATE matter_log_cursor SET value = value + 1 WHERE id = 1 RETURNING value').get()!.value
      db.query('UPDATE matters SET cursor = MAX(cursor, ?) WHERE id = ?').run(value, matterId)
      return value
    }
    for (const row of orphans) {
      const id = freshId()
      const parts = row.cwd.split(/[\\/]+/).filter(Boolean)
      const title = parts[parts.length - 1] || row.source
      db.query(`INSERT INTO matters(id,kind,initiator,title,project_path,state,archived_at,status,owner_chat_id,origin_matter_id,origin_message_id,origin_surface,created_at,updated_at)
        VALUES(?,'terminal','owner',?,?,?,NULL,'open',NULL,NULL,NULL,'cli',?,?)`)
        .run(id, title, row.cwd || null, row.status === 'ended' ? 'done' : 'open', row.created_at, row.last_event_at)
      db.query("INSERT INTO matter_bindings(matter_id,surface,surface_key,last_seen_at) VALUES(?,'cli',?,?)").run(id, row.session_id, row.last_event_at)
      if (row.last_summary) {
        db.query(`INSERT INTO matter_items(matter_id,turn_id,seq,kind,status,item_key,message_id,payload_json,created_at,updated_at,cursor)
          VALUES(?,NULL,1,'agent_message','completed',NULL,NULL,?,?,?,?)`)
          .run(id, JSON.stringify({ text: row.last_summary }), row.last_event_at, row.last_event_at, nextCursor(id))
      }
    }
    // 已经有那件事、可这件事里还没有一句「最后一句」的(老会话后来又发问,轮还没答完):删列前读的是列里那一句(COALESCE),
    // 也记成一步,排在最后(Codex 评审)
    const unsaid = db.query<{ matter_id: string; last_summary: string; last_event_at: number }, []>(`
      SELECT b.matter_id, c.last_summary, c.last_event_at FROM cli_sessions c
      JOIN matter_bindings b ON b.surface = 'cli' AND b.surface_key = c.session_id
      JOIN matters m ON m.id = b.matter_id AND m.kind = 'terminal'
      WHERE c.last_summary IS NOT NULL AND c.last_summary <> ''
        AND NOT EXISTS (SELECT 1 FROM matter_items i WHERE i.matter_id = b.matter_id AND i.kind = 'agent_message' AND json_extract(i.payload_json, '$.text') IS NOT NULL)
      ORDER BY c.created_at, c.session_id`).all()
    for (const row of unsaid) {
      const seq = db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM matter_items WHERE matter_id = ?').get(row.matter_id)!.seq
      db.query(`INSERT INTO matter_items(matter_id,turn_id,seq,kind,status,item_key,message_id,payload_json,created_at,updated_at,cursor)
        VALUES(?,NULL,?,'agent_message','completed',NULL,NULL,?,?,?,?)`)
        .run(row.matter_id, seq, JSON.stringify({ text: row.last_summary }), row.last_event_at, row.last_event_at, nextCursor(row.matter_id))
    }
    db.exec(`
      CREATE TABLE cli_sessions_v100 (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        cwd TEXT NOT NULL,
        machine TEXT,
        transcript_path TEXT,
        origin_agent TEXT,
        last_event_at INTEGER NOT NULL,
        last_prompt_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO cli_sessions_v100(session_id,source,cwd,machine,transcript_path,origin_agent,last_event_at,last_prompt_at,created_at)
        SELECT session_id,source,cwd,machine,transcript_path,origin_agent,last_event_at,last_prompt_at,created_at FROM cli_sessions;
      DROP TABLE cli_sessions;
      ALTER TABLE cli_sessions_v100 RENAME TO cli_sessions;
      CREATE INDEX IF NOT EXISTS idx_cli_sessions_last_event ON cli_sessions(last_event_at);
    `)
  }
