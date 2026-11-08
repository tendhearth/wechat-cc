import type { Migration } from './types'

// v102 — 删掉 matters.status(2026-11-05,设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md §M6e)。
// 线上的旧 status 从 M6b 起就由 domain/matters/legacy-status.ts 现算,只剩「答完了、闲着」(replied)那一位还读列;
// M6e 前半起它同时落成这件事最近一轮上的一步(system / ready:<turnId>,settleQuiet 双写),这一版起只读那一步,列就没人读了。
// **不可逆**:删了就回不到 v101 以前的版本(那一版的 matters-store 写 status 列)。
// 删之前先把只记在列里、state / archived_at / 步里还没有的那几样搬过去(真库 11-05 副本上三样都是 0 行,守着以防万一):
//   ① 列 = archived、archived_at 是空的 ⇒ archived_at = updated_at(同 v92 的推法);
//   ② 列 = done、统一状态还是 open ⇒ state = done(同 v92:对话 / 没有任务行的那件看旧 status);
//   ③ 列 = replied、最近一轮已收、那一轮上还没有 ready 步 ⇒ 补一步 ready(同 store.markReady:seq 接着排、游标取下一个、
//      这件事的 cursor 跟上);别的 replied(最近一轮在跑 / 没收成 / 没有轮)按列的式子本来也不算 replied,不补。
// 再按 v92 的路子重建:SQLite 改不了表结构里的 CHECK 列 ⇒ 建新表、搬行、换名;matters 被一堆表的外键指着 ⇒ withoutForeignKeys。
// v77 的来源不可改触发器、两条索引一起重建。可重放:没有 status 列就什么都不做。
export const migration: Migration = Object.assign((db: Parameters<Migration>[0]) => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(matters)').all()
    if (!columns.some(column => column.name === 'status')) return
    db.exec(`
      UPDATE matters SET archived_at = updated_at WHERE status = 'archived' AND archived_at IS NULL;
      UPDATE matters SET state = 'done' WHERE status = 'done' AND state = 'open';
    `)
    const owed = db.query<{ matter_id: string; turn_id: string }, []>(`
      SELECT m.id AS matter_id, t.id AS turn_id FROM matters m
        JOIN matter_turns t ON t.id = (SELECT x.id FROM matter_turns x WHERE x.matter_id = m.id ORDER BY x.seq DESC LIMIT 1)
      WHERE m.status = 'replied' AND t.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM matter_items i WHERE i.matter_id = m.id AND i.item_key = 'ready:' || t.id)
      ORDER BY m.id`).all()
    for (const { matter_id: matterId, turn_id: turnId } of owed) {
      const cursor = db.query<{ value: number }, []>('UPDATE matter_log_cursor SET value = value + 1 WHERE id = 1 RETURNING value').get()!.value
      const seq = db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM matter_items WHERE matter_id = ?').get(matterId)!.seq
      const ts = Date.now()
      db.query(`INSERT INTO matter_items(matter_id,turn_id,seq,kind,status,item_key,message_id,payload_json,created_at,updated_at,cursor)
        VALUES(?,?,?,'system','completed',?,NULL,'{"ready":true}',?,?,?)`).run(matterId, turnId, seq, 'ready:' + turnId, ts, ts, cursor)
      db.query('UPDATE matters SET cursor = MAX(cursor, ?) WHERE id = ?').run(cursor, matterId)
    }
    db.exec(`
      CREATE TABLE matters_v102 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat','task','terminal','act')),
        initiator TEXT NOT NULL DEFAULT 'owner' CHECK(initiator IN ('owner','cc','peer')),
        title TEXT NOT NULL, project_path TEXT,
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','working','waiting','done','failed','cancelled')),
        archived_at INTEGER,
        owner_chat_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        origin_matter_id TEXT REFERENCES matters(id), origin_message_id TEXT,
        origin_surface TEXT CHECK(origin_surface IN ('wechat','desktop','app','web','cli','companion')),
        cursor INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO matters_v102(id,kind,initiator,title,project_path,state,archived_at,owner_chat_id,created_at,updated_at,origin_matter_id,origin_message_id,origin_surface,cursor)
        SELECT id,kind,initiator,title,project_path,state,archived_at,owner_chat_id,created_at,updated_at,origin_matter_id,origin_message_id,origin_surface,cursor
        FROM matters;
      DROP TABLE matters;
      ALTER TABLE matters_v102 RENAME TO matters;
      CREATE INDEX matters_updated ON matters(updated_at);
      CREATE INDEX matters_origin ON matters(origin_matter_id);
      CREATE TRIGGER matters_origin_surface_once BEFORE UPDATE OF origin_surface ON matters
        WHEN NEW.origin_surface IS NOT OLD.origin_surface
        BEGIN SELECT RAISE(ABORT,'matter_origin_immutable'); END;
    `)
  }, { withoutForeignKeys: ['matters'] as const })
