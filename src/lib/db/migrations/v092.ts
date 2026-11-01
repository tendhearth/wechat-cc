import type { Migration } from './types'

// v92 — 一件事 → 一轮 → 一步(2026-11-01,设计稿 docs/superpowers/specs/2026-10-31-one-companion-one-skeleton-design.md
// §3.1、M1)。三处:
// ① matters 重建:kind 收成 chat / task / terminal / act(从没建过 companion 这种 matter,有就算 CC 自己做的 act);
//    加 initiator(owner / cc / peer —— 陪伴和干活的区别只在这一个字段)、统一状态 state(open → working ⇄ waiting →
//    done / failed / cancelled)和正交的 archived_at。旧 status 列原样留着,读它的出口到 M6 才切走、那时删。
//    state 按来源推:任务看 workbench_tasks 的状态(正在跑 ⇒ working;中断算没做成),对话看旧 status。
//    SQLite 改不了 CHECK ⇒ 建新表、搬行、换名;matters 被五张表的外键指着 ⇒ withoutForeignKeys(runner 关外键跑、跑完核)。
//    v77 的来源不可改触发器、两条索引一起重建。
// ② matter_turns:一轮 = 执行者的一个回合(一次输入 → 一次回应);一起做的 run 用 run_id 分组;用量按轮记。
// ③ matter_items:一步(你说的话 / CC 说的话 / 工具调用 / 权限卡 / 提问 / 成果 / 送达 / 系统 / 错误)。seq 每件事单调;
//    item_key 给同一步的 started → completed 合成一行;正文在 messages 的只引 message_id。
// 游标:matter_log_cursor 一行一个计数,轮与步每写一次取下一个值 ⇒ 全库单调,订阅按 cursor > since 拿变化(P1)。
// 写口只有 src/adapters/store/matter-log.ts。
// 可重放:#79 的修复会把整串迁移从 v19 再跑一遍 ⇒ matters 已经有 initiator 就不再重建(重建会把 state / initiator 抹回推算值),
// 新表 IF NOT EXISTS,游标行 OR IGNORE。
export const migration: Migration = Object.assign((db: Parameters<Migration>[0]) => {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(matters)').all()
    if (!columns.some(column => column.name === 'initiator')) db.exec(`
      CREATE TABLE matters_v92 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat','task','terminal','act')),
        initiator TEXT NOT NULL DEFAULT 'owner' CHECK(initiator IN ('owner','cc','peer')),
        title TEXT NOT NULL, project_path TEXT,
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','working','waiting','done','failed','cancelled')),
        archived_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('open','replied','done','archived')),
        owner_chat_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        origin_matter_id TEXT REFERENCES matters(id), origin_message_id TEXT,
        origin_surface TEXT CHECK(origin_surface IN ('wechat','desktop','app','web','cli','companion'))
      ) STRICT;
      INSERT INTO matters_v92(id,kind,initiator,title,project_path,state,archived_at,status,owner_chat_id,created_at,updated_at,origin_matter_id,origin_message_id,origin_surface)
        SELECT m.id,
               CASE m.kind WHEN 'companion' THEN 'act' ELSE m.kind END,
               CASE m.kind WHEN 'companion' THEN 'cc' ELSE 'owner' END,
               m.title, m.project_path,
               CASE
                 WHEN t.status IN ('queued','running','cancelling') THEN 'working'
                 WHEN t.status='completed' THEN 'done'
                 WHEN t.status IN ('failed','interrupted') THEN 'failed'
                 WHEN t.status='cancelled' THEN 'cancelled'
                 WHEN m.status='done' THEN 'done'
                 ELSE 'open' END,
               COALESCE(t.archived_at, CASE WHEN m.status='archived' THEN m.updated_at END),
               m.status, m.owner_chat_id, m.created_at, m.updated_at, m.origin_matter_id, m.origin_message_id, m.origin_surface
        FROM matters m LEFT JOIN workbench_tasks t ON t.id=m.id;
      DROP TABLE matters;
      ALTER TABLE matters_v92 RENAME TO matters;
      CREATE INDEX matters_updated ON matters(updated_at);
      CREATE INDEX matters_origin ON matters(origin_matter_id);
      CREATE TRIGGER matters_origin_surface_once BEFORE UPDATE OF origin_surface ON matters
        WHEN NEW.origin_surface IS NOT OLD.origin_surface
        BEGIN SELECT RAISE(ABORT,'matter_origin_immutable'); END;
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_turns (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters(id),
        seq INTEGER NOT NULL,
        run_id TEXT,
        executor TEXT NOT NULL, model TEXT, native_session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
        error_code TEXT,
        usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
        policy_json TEXT CHECK(policy_json IS NULL OR json_valid(policy_json)),
        started_at INTEGER NOT NULL, ended_at INTEGER,
        cursor INTEGER NOT NULL UNIQUE,
        UNIQUE(matter_id, seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matter_turns_run ON matter_turns(run_id) WHERE run_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS matter_items (
        id INTEGER PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters(id),
        turn_id TEXT REFERENCES matter_turns(id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('user_message','agent_message','tool_call','permission','question','artifact','delivery','system','error')),
        status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
        item_key TEXT,
        message_id TEXT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        cursor INTEGER NOT NULL UNIQUE,
        UNIQUE(matter_id, seq)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS matter_items_key ON matter_items(matter_id, item_key) WHERE item_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS matter_items_turn ON matter_items(turn_id, seq) WHERE turn_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS matter_log_cursor (
        id INTEGER PRIMARY KEY CHECK(id=1),
        value INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO matter_log_cursor(id,value) VALUES(1,0);
    `)
  }, { withoutForeignKeys: ['matters'] as const })
