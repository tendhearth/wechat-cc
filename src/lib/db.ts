/**
 * SQLite connection + schema migration for the daemon's state stores.
 *
 * Single ~/.claude/channels/wechat/wechat-cc.db file owned by the daemon
 * process. Each table that used to live as a JSON/JSONL file under the
 * channel state dir is migrated here one-at-a-time across PR7 commits.
 *
 * Schema versioning: PRAGMA user_version. Each `migrations` entry below
 * advances the version by one and creates / alters the table for that
 * step. openDb() applies any missing migrations in order.
 *
 * Concurrency posture:
 *   - WAL journal mode → daemon is the single writer; dashboard / CLI
 *     read-only queries can run concurrently without blocking writes.
 *   - foreign_keys = ON for safety even though we don't currently model
 *     cross-table refs; cheap pragma, lets future schema use FKs.
 *
 * No ORM — call sites use db.prepare() / .query() with prepared
 * statements. bun:sqlite is API-compatible enough with better-sqlite3
 * that swapping later (if Bun ever drops the builtin) would be local.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Db = Database

/**
 * Each migration runs once, in order, when its index is greater than the
 * file's PRAGMA user_version. After it runs we set user_version = index+1.
 * NEVER reorder; NEVER edit a published migration in place — append a new
 * one. Doing otherwise will corrupt every existing user's database.
 */
type Migration = (db: Database) => void

/**
 * Exported for the position guard in migration-order.test.ts, which pins the
 * schema each released version produces. Do not run these directly — use
 * `runMigrations`, which owns the user_version bookkeeping.
 */
export const migrations: Migration[] = [
  // v1 — session_state. PR7 commit 1.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        bot_id TEXT PRIMARY KEY NOT NULL,
        first_seen_expired_at TEXT NOT NULL,
        last_reason TEXT
      ) STRICT;
    `)
  },
  // v2 — sessions (alias × provider → SDK session_id for resume). PR7 commit 2.
  // Composite PK so a single alias can hold one claude + one codex session
  // independently (legacy v0.x format collapsed both into a single row).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
  },
  // v3 — conversations (chatId → Mode). PR7 commit 3.
  // Mode is normalized into separate columns so future queries (e.g.
  // "all chats currently using codex") don't need JSON1 extension.
  // Only `solo` mode uses mode_provider; only `primary_tool` uses
  // mode_primary; `parallel` / `chatroom` use neither.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id TEXT PRIMARY KEY NOT NULL,
        mode_kind TEXT NOT NULL CHECK (mode_kind IN ('solo', 'primary_tool', 'parallel', 'chatroom')),
        mode_provider TEXT,
        mode_primary TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
  },
  // v4 — activity (per-chat per-day inbound message tally). PR7 commit 4.
  // One row per (chat_id, UTC date). Detector reads recent days to
  // evaluate the 7-day-streak milestone.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        chat_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- YYYY-MM-DD UTC
        first_msg_ts TEXT NOT NULL,    -- ISO 8601
        msg_count INTEGER NOT NULL,
        PRIMARY KEY (chat_id, date)
      ) STRICT;
    `)
  },
  // v5 — milestones (per-chat fires, id-deduped, permanent). PR7 commit 5.
  // event_id back-pointer mirrors the existing JSONL field; it's nullable
  // because demo seeding writes milestones without an associated event.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        event_id TEXT,
        PRIMARY KEY (chat_id, id)
      ) STRICT;
    `)
  },
  // v6 — observations (per-chat companion notes, archive flag). PR7 commit 6.
  // archived is INTEGER (0/1) per SQLite STRICT — no native bool type.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        tone TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        event_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS observations_chat_ts ON observations(chat_id, ts DESC);
    `)
  },
  // v7 — events (per-chat append-only decision log). PR7 commit 7.
  // The largest table by volume; introspect cron writes ~1 row per
  // tick × per chat × per day. Index on (chat_id, ts DESC) is what the
  // dashboard's "last N decisions" query hits.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v8 — tighten events.kind with a CHECK constraint mirroring the
  // closed EventKind TS union in src/daemon/events/store.ts. Posture-
  // aligned with conversations.mode_kind (which has had its CHECK since
  // v3). SQLite's ALTER TABLE can't add a CHECK on an existing column,
  // so we recreate the table; rows preserved via INSERT…SELECT, and the
  // events_chat_ts index has to be re-created (DROP TABLE drops it too).
  // If any pre-existing row has a kind outside the union, the CHECK will
  // fail this migration — that's the desired outcome (loud failure beats
  // silent drift; the store-side type only narrowed *new* writes).
  (db) => {
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v9 — identity columns on conversations (chatId → userId/accountId/lastUserName).
  // Surfaces WeChat identity alongside mode so the dashboard can primary-display
  // user (instead of opaque chatId) and the in-memory accountChatIndex from
  // v0.6 PR4 can be replaced by `WHERE account_id = ?`. SQLite's STRICT mode
  // doesn't allow ALTER TABLE...ADD COLUMN with constraints; nullable TEXT is
  // the simplest forward-compatible shape — older rows get NULL until next
  // inbound repopulates via the upcoming mw-identity middleware.
  (db) => {
    db.exec(`
      ALTER TABLE conversations ADD COLUMN user_id TEXT;
      ALTER TABLE conversations ADD COLUMN account_id TEXT;
      ALTER TABLE conversations ADD COLUMN last_user_name TEXT;
    `)
  },
  // v10 — per-chat session keys. Pre-tier sessions get chat_id='_legacy'
  // and are cleaned up if they're older than a day (most installs have
  // nothing newer; the 1-day grace handles fresh upgrades mid-conversation).
  // See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
  (db) => {
    // SQLite can't ALTER a PRIMARY KEY in place; rebuild the table.
    // The column add + table rebuild + delete happen inside this migration
    // function which runs in a single transaction in the runner.
    db.exec(`
      ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT '_legacy';
      CREATE TABLE sessions_v10 (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        -- DEFAULT '_legacy' keeps callers that don't yet supply chat_id from
        -- failing on INSERT. Task 8 rewrites session-store queries to always
        -- pass an explicit chat_id; the default becomes vestigial then, but
        -- harmless. Removing it later requires another migration.
        chat_id TEXT NOT NULL DEFAULT '_legacy',
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider, chat_id)
      ) STRICT;
      INSERT INTO sessions_v10(alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at)
        SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v10 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
    // Cleanup pre-tier rows older than 1 day. ISO 8601 string-comparable.
    const cutoff = new Date(Date.now() - 86_400_000).toISOString()
    db.exec(`DELETE FROM sessions WHERE chat_id = '_legacy' AND last_used_at < '${cutoff}'`)
  },
  // v11 — participants column on conversations (N-way modes, P3).
  // Nullable JSON-encoded TEXT array of provider ids. NULL on pre-v11 rows
  // (legacy 2-way parallel/chatroom); the coordinator's resolveParticipants
  // helper backfills these to the first-two-registered providers on first
  // dispatch under the new code so the user's "this chat was 2-way"
  // expectation is preserved. New explicit /chat <p1> <p2> ... commands
  // write the list directly.
  // See docs/superpowers/specs/2026-05-23-n-way-modes-design.md.
  (db) => {
    // Guard: unit-test harnesses that start from user_version=9 (sessions-only
    // schema) will reach this migration without a conversations table. The
    // guard keeps those pre-existing v10 tests green while still applying the
    // column in every real database that went through the full migration chain.
    const has = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='conversations'"
      )
      .get()
    if (has && has.cnt > 0) {
      db.exec(`ALTER TABLE conversations ADD COLUMN participants TEXT;`)
    }
  },
  // v12 — a2a_events: observability log for A2A inbound/outbound calls.
  // See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
  (db) => {
    db.exec(`
      CREATE TABLE a2a_events (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        urgency TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        http_status INTEGER
      ) STRICT;
      CREATE INDEX a2a_events_agent_ts ON a2a_events(agent_id, ts DESC);
    `)
  },
  // v13 — events: add `memory_deleted` kind + `memory_path` column for the
  // soft-delete audit log (see docs/specs/2026-05-21-memory-delete-safety-design.md).
  // Same posture as v8: SQLite can't widen a CHECK in place, so the table
  // is rebuilt and the chat-ts index re-created.
  (db) => {
    // Guard: some unit-test harnesses start from user_version=9 with only
    // a sessions table — no events table to migrate. Mirrors v11's
    // conversations guard so those targeted-scope tests stay green while
    // real production dbs (which went through v6/v7) take the rebuild path.
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_v13 (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_v13 (id, chat_id, ts, kind, trigger, reasoning,
                              push_text, observation_id, milestone_id, jsonl_session_id)
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id FROM events;
      DROP TABLE events;
      ALTER TABLE events_v13 RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v14 — dialogue real data: canonical messages store, topic threads,
  // extraction watermark; events gains 'threads_extracted' kind (CHECK
  // constraints can't be altered in SQLite → rebuild events in place).
  // Spec: docs/superpowers/specs/2026-06-11-dialogue-real-data-design.md
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY NOT NULL,
        chat_id   TEXT NOT NULL,
        ts        TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind      TEXT NOT NULL DEFAULT 'text',
        text      TEXT NOT NULL,
        provider  TEXT,
        source    TEXT NOT NULL DEFAULT 'live'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY NOT NULL,
        chat_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        facets      TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        private     INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','done')),
        episodes    TEXT NOT NULL DEFAULT '[]',
        created_ts  TEXT NOT NULL,
        last_active TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_id, last_active);

      CREATE TABLE IF NOT EXISTS thread_extract_state (
        chat_id         TEXT PRIMARY KEY NOT NULL,
        extracted_to_ts TEXT NOT NULL
      ) STRICT;
    `)
    // events CHECK rebuild: create new → copy → rename. Column set matches the existing schema; only the kind set widens.
    // Guard: some unit-test harnesses skip the full migration chain and may
    // not have an events table (mirrors v11/v13 guard posture).
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted', 'threads_extracted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_new
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id, memory_path
        FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v15 — turn_records: per-turn outcome log for daemon observability. One
  // row per dispatched turn (solo / each parallel participant / each chatroom
  // speaker turn). Survives restart so a daemon hang/crash is diagnosable
  // post-mortem ("why did chat X stop replying at HH:MM"). Pruned per-chat by
  // the store on append. Mirrors a2a_events (v12).
  (db) => {
    db.exec(`
      CREATE TABLE turn_records (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        alias TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reply_tool_called INTEGER NOT NULL,
        text_chunks INTEGER NOT NULL,
        error TEXT
      ) STRICT;
      CREATE INDEX turn_records_chat_ts ON turn_records(chat_id, ended_at DESC);
    `)
  },
  // v16 — handled_messages: dedup marker for inbound message processing.
  // One row per inbound message that has been FULLY processed (a reply was
  // sent, or it was consumed as a command) — written only after the pipeline
  // settles without throwing. On macOS sleep/wake the long-poll cursor can
  // regress (daemon restart / lock-steal loads a not-yet-persisted sync_buf),
  // making the ilink server redeliver already-answered messages. The mw-dedup
  // middleware consults this table to skip re-running the agent on a redelivery
  // while still re-processing messages whose first turn crashed before replying
  // (those never got marked here). Keyed by the same id as the messages table
  // (`userId:createTimeMs`, or a content hash when create_time_ms is absent).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handled_messages (
        id         TEXT PRIMARY KEY NOT NULL,
        handled_at TEXT NOT NULL
      ) STRICT;
    `)
  },
  // v17 — message_attempts: per-message processing-attempt counter, so a
  // "poison" message (one whose turn persistently throws) can't reprocess
  // forever across daemon restarts. mw-dedup increments this BEFORE running the
  // pipeline; after N attempts it gives up (marks the message handled) instead
  // of re-running. Separate from handled_messages because the row must exist
  // BEFORE the message is handled (handled_messages rows only appear on
  // success). Same id scheme as handled_messages / the messages table.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_attempts (
        id         TEXT PRIMARY KEY NOT NULL,
        attempts   INTEGER NOT NULL,
        first_seen TEXT NOT NULL
      ) STRICT;
    `)
  },
  // v18 — connection_heartbeat: records the timestamp of each successful
  // ilink getUpdates poll per account. Keyed by account.id (the directory
  // id, same key used for session_state and expiredBots). Used by the
  // doctor report (heartbeats field) and the dashboard "上次活动" display.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_heartbeat (
        account_id TEXT PRIMARY KEY NOT NULL,
        last_update_ok_at TEXT NOT NULL
      ) STRICT;
    `)
  },
  // agent-social 觅食台 state (M2 P1): persisted seeks + echoes so the
  // desktop forager's-desk has queryable state. See
  // docs/superpowers/specs/2026-07-15-forage-desk-agent-page-design.md.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_seek (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,          -- 'seek' | 'fun'
        topic        TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'foraging' | 'echoed' | 'connected' | 'closed'
        hop          INTEGER NOT NULL DEFAULT 1,
        peers_asked  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS social_echo (
        id           TEXT PRIMARY KEY,
        seek_id      TEXT NOT NULL,
        peer_masked  TEXT NOT NULL,          -- e.g. "第 1 度的某人"
        degree       INTEGER NOT NULL DEFAULT 1,
        content      TEXT NOT NULL,
        status       TEXT NOT NULL,          -- 'pending' | 'revealed' | 'declined'
        created_at   TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_echo_seek ON social_echo(seek_id);
    `)
  },
  // v20 — async foraging spine. Adds the reveal columns to social_echo (the
  // seeker's side) + the social_pledge table (the answerer's mirror side) so
  // dual-confirm can move OUT of the seek broker call into a durable, row-driven,
  // restart-survivable mutual reveal. Nullable-TEXT ADD COLUMN is safe on a
  // STRICT table; social_echo is created unconditionally by v19 above, so no
  // table-exists guard is needed even for the user_version=9 test harnesses.
  // See docs/superpowers/specs/2026-07-15-async-foraging-spine-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN peer_agent_id TEXT;
      ALTER TABLE social_echo ADD COLUMN self_revealed_at TEXT;
      ALTER TABLE social_echo ADD COLUMN peer_revealed_at TEXT;
      CREATE TABLE IF NOT EXISTS social_pledge (
        id                TEXT PRIMARY KEY,
        intent_id         TEXT NOT NULL,
        seeker_agent_id   TEXT NOT NULL,      -- who sought (POST back their /a2a/reveal)
        topic             TEXT NOT NULL,
        self_revealed_at  TEXT,               -- when THIS owner revealed (nullable)
        peer_revealed_at  TEXT,               -- when the seeker revealed (nullable)
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_pledge_intent ON social_pledge(intent_id);
    `)
  },
  // v21 — forwarding hop (spec #2). Two nullable relay columns on social_echo
  // (the seeker's degree-2 echoes) + the intermediary's social_relay table
  // (links the two proxied reveal legs) + social_seen_intent (loop-prevention
  // dedup). Nullable-TEXT ADD COLUMN is safe on STRICT; social_echo is created
  // unconditionally by v19, so the ALTER is safe even in user_version=9 harnesses.
  // See docs/superpowers/specs/2026-07-15-forwarding-hop-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_echo ADD COLUMN relay_via TEXT;
      ALTER TABLE social_echo ADD COLUMN relay_token TEXT;
      CREATE TABLE IF NOT EXISTS social_relay (
        id                     TEXT PRIMARY KEY,   -- intent_id:relay_token
        intent_id              TEXT NOT NULL,
        relay_token            TEXT NOT NULL,
        upstream_agent_id      TEXT NOT NULL,       -- who W received the card from (the seeker S)
        downstream_agent_id    TEXT NOT NULL,       -- who W forwarded to + got the yes from (Q)
        upstream_revealed_at   TEXT,                -- S revealed to W (nullable)
        downstream_revealed_at TEXT,                -- Q revealed to W (nullable)
        created_at             TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_social_relay_intent_downstream ON social_relay(intent_id, downstream_agent_id);
      CREATE TABLE IF NOT EXISTS social_seen_intent (
        intent_id     TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      ) STRICT;
    `)
  },
  // v22 — 匿名笔友通道 (sub-project A). The E2E pen-pal channel: penpal_channel
  // holds the per-connection X25519 keypair (my_privkey LOCAL-only) + the peer's
  // crossed handle (pubkey + channel id), nullable until mutual reveal opens the
  // channel. penpal_letter is the local correspondence thread — sealed ct+nonce+tag
  // on the wire, decrypted plaintext kept locally for the owner. social_relay gains
  // two nullable handle columns so the intermediary (W) can persist each endpoint's
  // presented pubkey handle to hand to the OTHER leg — W crosses pubkeys the
  // endpoints supplied, never a real identity. Nullable-TEXT ADD COLUMN is safe on
  // STRICT; social_relay is created unconditionally by v21, so the ALTER is safe
  // even in the user_version=9 test harnesses.
  // See docs/superpowers/specs/2026-07-18-anonymous-penpal-social-layer-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_relay ADD COLUMN upstream_handle TEXT;
      ALTER TABLE social_relay ADD COLUMN downstream_handle TEXT;
      CREATE TABLE IF NOT EXISTS penpal_channel (
        id                TEXT PRIMARY KEY,        -- = the echo/pledge/relay-leg id it opened from
        seek_id           TEXT NOT NULL,           -- the local seek (or intent) this channel belongs to
        my_privkey        TEXT NOT NULL,           -- LOCAL-only X25519 private (pkcs8 DER base64url)
        my_pubkey         TEXT NOT NULL,           -- crossed to the peer (spki DER base64url)
        my_channel_id     TEXT NOT NULL,           -- my inbound address; peer addresses letters TO me by it
        peer_pubkey       TEXT,                    -- crossed FROM the peer (nullable until reveal)
        peer_channel_id   TEXT,                    -- peer's inbound address (nullable until reveal)
        degree            INTEGER NOT NULL DEFAULT 1,
        relay_via         TEXT,                    -- the intermediary agent id for a 2-hop channel (nullable)
        peer_agent_id     TEXT,                    -- direct peer's agent id (nullable for relay channels)
        status            TEXT NOT NULL,           -- 'pending' | 'open'
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_penpal_channel_mychan ON penpal_channel(my_channel_id);
      CREATE TABLE IF NOT EXISTS penpal_letter (
        id                TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        direction         TEXT NOT NULL,           -- 'in' | 'out'
        sealed_ciphertext TEXT NOT NULL,           -- base64url AES-GCM ct (the ONLY thing on the wire)
        nonce             TEXT NOT NULL,           -- base64url 12-byte GCM nonce
        tag               TEXT NOT NULL,           -- base64url GCM auth tag
        plaintext         TEXT NOT NULL,           -- decrypted, kept LOCAL for the owner's thread
        created_at        TEXT NOT NULL,
        read_at           TEXT                     -- nullable; set when the owner has seen it
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_penpal_letter_channel ON penpal_letter(channel_id);
    `)
  },
  // v23 — mailbox plumbing (sub-project B, additive/GREEN checkpoint). Adds a
  // nullable peer_mailbox column to penpal_channel so the peer's relay-direct
  // mailbox coordinates (PeerMailbox: addr/enc_pub/relays, JSON) can ride the
  // pen-pal reveal alongside pubkey/channel_id. Nothing populates it yet —
  // setPeerHandle just carries handle.mailbox through when present; the C1
  // fix that actually crosses a mailbox at reveal is a separate task.
  // Nullable-TEXT ADD COLUMN is safe on STRICT; penpal_channel is created
  // unconditionally by v22, so the ALTER is safe even in older test harnesses.
  // See docs/superpowers/plans/2026-07-19-penpal-mailbox-B.md.
  (db) => {
    db.exec(`
      ALTER TABLE penpal_channel ADD COLUMN peer_mailbox TEXT;
    `)
  },
  // v24 — 派心愿 propose→confirm (P4). Two nullable columns on social_seek hold
  // the redacted wording the owner approved at PROPOSE time; confirmSeek forages
  // this stored string verbatim (WYSIWYG — no second gate). The status union
  // also gains 'proposed'/'cancelled' but the column has no CHECK constraint, so
  // that is a TypeScript-only change (no SQL here). Nullable-TEXT ADD COLUMN is
  // safe on the STRICT table; social_seek is created unconditionally by v19.
  // See docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md.
  (db) => {
    db.exec(`
      ALTER TABLE social_seek ADD COLUMN redacted_topic TEXT;
      ALTER TABLE social_seek ADD COLUMN redacted_city TEXT;
    `)
  },
  // v25 — async discovery (spec 2026-07-22-async-discovery-over-mailbox).
  // origin_agent_id on social_seen_intent: who SENT us this intent. A relay
  // (W) needs it to route a downstream echo onward after a restart — a
  // null-origin row (pre-v25) fails closed: the late echo is dropped.
  // Nullable-TEXT ADD COLUMN is safe on STRICT; social_seen_intent is
  // created unconditionally by v21.
  (db) => {
    db.exec(`ALTER TABLE social_seen_intent ADD COLUMN origin_agent_id TEXT;`)
  },
  // v26 — customer review tasks, grounded commitment candidates, evidence
  // references, and durable user feedback overlays. Raw WeChat message text is
  // deliberately NOT stored here; evidence rows only keep the app-generated
  // key, timestamp, sender side, and role so the UI can re-read source content
  // from wxvault on demand.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_reviews (
        id                   TEXT PRIMARY KEY NOT NULL,
        contact_id           TEXT NOT NULL,
        contact_display_name TEXT NOT NULL,
        range_from           TEXT NOT NULL,
        range_to             TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('queued','analyzing','ready','failed')),
        provider             TEXT NOT NULL,
        model                TEXT,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_first_at      TEXT,
        source_last_at       TEXT,
        error_code           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        completed_at         TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS customer_reviews_contact_created
        ON customer_reviews(contact_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS customer_review_items (
        review_id        TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        source_key       TEXT NOT NULL,
        commitment       TEXT NOT NULL,
        ai_status        TEXT NOT NULL CHECK (ai_status IN ('open','completed')),
        due_date         TEXT,
        confidence       TEXT NOT NULL CHECK (confidence IN ('medium','high')),
        review_status    TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected','ignored')),
        corrected_text   TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (review_id, source_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS customer_review_items_review_status
        ON customer_review_items(review_id, review_status);

      CREATE TABLE IF NOT EXISTS customer_review_evidence (
        review_id    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('commitment','completion','due_date')),
        message_time TEXT NOT NULL,
        sender_side  TEXT NOT NULL CHECK (sender_side IN ('me','contact')),
        PRIMARY KEY (review_id, source_key, evidence_key, role),
        FOREIGN KEY (review_id, source_key)
          REFERENCES customer_review_items(review_id, source_key) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS customer_review_feedback (
        contact_id     TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        review_status  TEXT NOT NULL
          CHECK (review_status IN ('confirmed','corrected','rejected','ignored')),
        corrected_text TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (contact_id, source_key)
      ) STRICT;
    `)
  },
  // v27 — a user can complete an otherwise-valid commitment through email,
  // phone, a client system, or offline. Keep that human fact separate from an
  // AI completion inference that has WeChat evidence.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_review_items_v27 (
        review_id        TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        source_key       TEXT NOT NULL,
        commitment       TEXT NOT NULL,
        ai_status        TEXT NOT NULL CHECK (ai_status IN ('open','completed')),
        due_date         TEXT,
        confidence       TEXT NOT NULL CHECK (confidence IN ('medium','high')),
        review_status    TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (review_status IN ('unreviewed','confirmed','corrected','completed_elsewhere','rejected','ignored')),
        corrected_text   TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (review_id, source_key)
      ) STRICT;
      INSERT INTO customer_review_items_v27
        SELECT review_id, source_key, commitment, ai_status, due_date, confidence,
               review_status, corrected_text, created_at, updated_at
        FROM customer_review_items;

      CREATE TABLE IF NOT EXISTS customer_review_evidence_v27 (
        review_id    TEXT NOT NULL,
        source_key   TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('commitment','completion','due_date')),
        message_time TEXT NOT NULL,
        sender_side  TEXT NOT NULL CHECK (sender_side IN ('me','contact')),
        PRIMARY KEY (review_id, source_key, evidence_key, role),
        FOREIGN KEY (review_id, source_key)
          REFERENCES customer_review_items_v27(review_id, source_key) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO customer_review_evidence_v27
        SELECT review_id, source_key, evidence_key, role, message_time, sender_side
        FROM customer_review_evidence;

      CREATE TABLE IF NOT EXISTS customer_review_feedback_v27 (
        contact_id     TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        review_status  TEXT NOT NULL
          CHECK (review_status IN ('confirmed','corrected','completed_elsewhere','rejected','ignored')),
        corrected_text TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (contact_id, source_key)
      ) STRICT;
      INSERT INTO customer_review_feedback_v27
        SELECT contact_id, source_key, review_status, corrected_text, updated_at
        FROM customer_review_feedback;

      DROP TABLE customer_review_evidence;
      DROP TABLE customer_review_items;
      DROP TABLE customer_review_feedback;
      ALTER TABLE customer_review_items_v27 RENAME TO customer_review_items;
      ALTER TABLE customer_review_evidence_v27 RENAME TO customer_review_evidence;
      ALTER TABLE customer_review_feedback_v27 RENAME TO customer_review_feedback;
      CREATE INDEX IF NOT EXISTS customer_review_items_review_status
        ON customer_review_items(review_id, review_status);
    `)
  },
  // v28 — analysis coverage metadata. Long histories can yield a grounded
  // partial result while one model window remains untrusted; persist only the
  // uncovered time span and safe error code, never raw chat text.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_review_analysis_issues (
        review_id    TEXT NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
        window_index INTEGER NOT NULL,
        range_from   TEXT NOT NULL,
        range_to     TEXT NOT NULL,
        error_code   TEXT NOT NULL,
        attempts     INTEGER NOT NULL CHECK (attempts >= 1 AND attempts <= 3),
        PRIMARY KEY (review_id, window_index)
      ) STRICT;
    `)
  },
  // v29 — reminders (ported from the June feat/reminders branch, dcbaf94b;
  // spec docs/superpowers/specs/2026-08-20-reminders-port-design.md).
  // Per-chat, minute-precise, one-shot reminders delivered by the reminder
  // sweeper (src/daemon/reminders). Unlike the companion agenda (day-granular,
  // operator-only), due_at is a full ISO 8601 timestamp, any chat_id, and
  // pending rows survive restarts. attempts/last_error/last_attempt_at track
  // delivery retries — last_attempt_at drives the sweeper's exponential
  // backoff (June's every-60s retry violated the no-retry-storm rule).
  // The June branch numbered this v15; it lands here as v29 because
  // user_version is a COUNT (#79) — body is IF NOT EXISTS, replay-safe.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id              TEXT PRIMARY KEY NOT NULL,
        chat_id         TEXT NOT NULL,
        due_at          TEXT NOT NULL,            -- ISO 8601, full timestamp
        text            TEXT NOT NULL,
        created_at      TEXT NOT NULL,            -- ISO 8601
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','cancelled','failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        last_attempt_at TEXT                      -- ISO 8601; drives retry backoff
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reminders_status_due ON reminders(status, due_at);
      CREATE INDEX IF NOT EXISTS reminders_chat ON reminders(chat_id, due_at);
    `)
  },
  // v30 — cross-session FTS (the "SQLite FTS upgrade tracked for v0.5" from
  // sessions/searcher.ts, landed by 2026-08-23-memory-upgrades). One FTS5
  // trigram row per session-jsonl line (trigram matches CJK the way
  // knowledge/semantic.db's chunks_fts already does); alias/session_id/
  // turn_index are UNINDEXED payload for hit resolution. session_fts_state
  // tracks the per-file incremental watermark (lines_indexed) plus byte_size
  // so a truncated/rewritten transcript triggers a from-scratch reindex.
  // FTS5 virtual tables cannot be STRICT; the state table is.
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_fts USING fts5(
        text, alias UNINDEXED, session_id UNINDEXED, turn_index UNINDEXED,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS session_fts_state (
        path          TEXT PRIMARY KEY NOT NULL,
        alias         TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        lines_indexed INTEGER NOT NULL,
        byte_size     INTEGER NOT NULL
      ) STRICT;
    `)
  },
  // v31 — widen events.kind CHECK with 'config_changed' (config-surface
  // audit: every successful config_set MCP write lands one row, mirroring
  // memory_deleted's audit posture). Same rebuild dance as v8: SQLite can't
  // widen a CHECK in place, so copy → drop → rename → reindex. Same
  // hasEvents guard as the previous widening — unit-test harnesses that
  // start mid-chain may not have an events table yet.
  (db) => {
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted', 'threads_extracted', 'config_changed'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_new
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id, memory_path
        FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v32 — 揭晓的「送达」与「同意」分家。social_echo / social_pledge 各加一列
  // self_reveal_delivered_at:self_revealed_at 记的是**我的 owner 同意了**,
  // 这一列记的是**我的揭晓真的送到对端了**。此前只有前者,于是投递失败
  // (信箱掉网)之后、对方的揭晓又恰好到达时,两个本地时间戳都齐了,重试
  // 直接短路报「已连接」,一次都不重发 —— 对端永远停在 awaiting_peer。
  // 2026-09-01 Mac↔Windows 真机上就是这样断的。
  //
  // 刻意**不回填**(不写 self_reveal_delivered_at = self_revealed_at):
  // 回填等于把毒继续留在库里。留成 NULL 的代价只是每条历史揭晓行被补投
  // 一次 —— onInboundReveal 对重复揭晓是无写入、无通知的,而真正卡住的行
  // 会因此自愈。
  // Nullable-TEXT ADD COLUMN 在 STRICT 表上安全。**表存在与否要问,不能假设**:
  // v19/v20 确实无条件建这两张表,但 db.test.ts 里有从 user_version=26 起跑的
  // 夹具,库里根本没有 social_*(和 v31 的 hasEvents 守卫同一类情况)。
  (db) => {
    for (const t of ['social_echo', 'social_pledge']) {
      const found = db
        .query<{ cnt: number }, [string]>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name = ?")
        .get(t)
      if (!found || found.cnt === 0) continue
      db.exec(`ALTER TABLE ${t} ADD COLUMN self_reveal_delivered_at TEXT;`)
    }
  },
  // v33 — 明信片的「欠账」。答话的一方 match:'yes' 之后建 pledge 行、发
  // 明信片给求助的人。发失败时以前只有一行日志(而信箱腿上连那行都不会打,
  // 见 social-post-seam.ts),没有任何人会再发一次:求助的一方什么都收不到,
  // 答话的一方却留着 pledge 行以为自己回过了。和 v32 是同一个病 —— 投递
  // 失败没人补 —— 只是发生在早一站。
  // echo_blurb/echo_degree 记「我欠什么」,echo_queued_at 是补投有界的起点,
  // echo_delivered_at 记「真的送到了」。同 v32 刻意不回填。
  // 同 v32 的 table-exists 守卫:db.test.ts 有从 user_version=26 起跑的夹具。
  (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='social_pledge'")
      .get()
    if (!found || found.cnt === 0) return
    db.exec(`
      ALTER TABLE social_pledge ADD COLUMN echo_blurb TEXT;
      ALTER TABLE social_pledge ADD COLUMN echo_degree INTEGER;
      ALTER TABLE social_pledge ADD COLUMN echo_queued_at TEXT;
      ALTER TABLE social_pledge ADD COLUMN echo_delivered_at TEXT;
    `)
  },
  // v34 — 介绍人(W)那一侧的欠账。W 在 2 跳连接里替两端跑腿,而它的**每一条
  // 外发都是 fire-and-forget、失败只留一行日志**:
  //   · 转发下游明信片给 S(social-echo-relay)—— 掉了 ⇒ Q 以为自己答过了、
  //     S 什么都没收到、W 留着一条谁也用不上的 relay 行。
  //   · 互揭达成后给两端的 complete 回投 —— 掉了 ⇒ 那一端永久停在
  //     awaiting_peer,而 W 的行说「两条腿都揭晓了」,重试还会走 legAlready
  //     分支直接返回,一个字节都不再发。跟 v32 是同一个形状,只是发生在 W。
  // 记下欠什么(echo_blurb/degree)、什么时候欠的(echo_queued_at,补投有界的
  // 起点)、以及三件事各自的送达时刻。同 v32/v33 刻意不回填。
  // 同款 table-exists 守卫:db.test.ts 有从 user_version=26 起跑的夹具。
  (db) => {
    const found = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='social_relay'")
      .get()
    if (!found || found.cnt === 0) return
    db.exec(`
      ALTER TABLE social_relay ADD COLUMN echo_blurb TEXT;
      ALTER TABLE social_relay ADD COLUMN echo_degree INTEGER;
      ALTER TABLE social_relay ADD COLUMN echo_queued_at TEXT;
      ALTER TABLE social_relay ADD COLUMN echo_delivered_at TEXT;
      ALTER TABLE social_relay ADD COLUMN upstream_completed_at TEXT;
      ALTER TABLE social_relay ADD COLUMN downstream_completed_at TEXT;
    `)
  },
]

export interface OpenDbOpts {
  /**
   * Filesystem path to the SQLite file. Use `:memory:` for tests. Parent
   * directory is created (recursively, mode 0700) if it doesn't exist.
   */
  path: string
}

/**
 * Convenience wrapper that resolves the daemon's canonical state file
 * (`<stateDir>/wechat-cc.db`) and opens it. Used by the CLI leaf commands
 * — every read-only `wechat-cc <noun> list` path goes through here so the
 * boilerplate isn't repeated 10× across cli.ts.
 *
 * For tests / non-canonical paths, use `openDb({ path })` directly.
 */
export function openWechatDb(stateDir: string): Database {
  return openDb({ path: join(stateDir, 'wechat-cc.db') })
}

function isLockedError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /database is locked|database is busy|SQLITE_BUSY/i.test(m)
}

/**
 * Run `fn`, retrying briefly on a SQLite "database is locked" error. Sync,
 * since openDb is sync. Survives the WAL-lock race when the daemon restarts
 * before the SIGKILLed old process released the lock — `busy_timeout` doesn't
 * cover the journal-mode switch, so that switch would otherwise crash the boot
 * with "database is locked". Non-lock errors rethrow immediately; `sleep` is
 * injectable for tests.
 */
export function withLockRetry<T>(
  fn: () => T,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => void } = {},
): T {
  const attempts = opts.attempts ?? 12
  const delayMs = opts.delayMs ?? 250
  const sleep = opts.sleep ?? ((ms: number) => { Bun.sleepSync(ms) })
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      lastErr = e
      if (!isLockedError(e)) throw e
      if (i < attempts - 1) sleep(delayMs)
    }
  }
  throw lastErr
}

export function openDb(opts: OpenDbOpts): Database {
  if (opts.path !== ':memory:') {
    const dir = dirname(opts.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Opening + switching to WAL takes a brief exclusive lock; on a daemon
  // restart the SIGKILLed old process may still hold it (busy_timeout doesn't
  // cover the journal-mode switch). Retry instead of crashing the boot.
  const db = withLockRetry(() => {
    const d = new Database(opts.path, { create: true })
    d.exec('PRAGMA journal_mode = WAL;')
    return d
  })
  db.exec('PRAGMA foreign_keys = ON;')
  // 5s busy_timeout — the CLI process and daemon may try to write the same
  // db simultaneously (e.g. `wechat-cc sessions delete` while the daemon
  // bumps last_used_at). With WAL the conflict window is short; the
  // timeout makes it transparent.
  db.exec('PRAGMA busy_timeout = 5000;')
  runMigrations(db)
  return db
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null
}

/**
 * Heal a database whose user_version was written by the customer-review
 * branch build (issue #79).
 *
 * That branch (45a52114, 2026-07-25) was cut from a tree whose migrations
 * ended at v18 and numbered its own three v19/v20/v21. Mainline already had
 * v19–v25 (social/penpal), so merging renumbered customer review to v26–v28.
 * A database that ran the branch build therefore stores user_version=21
 * meaning "customer-review analysis metadata applied", while this runner
 * reads 21 as "social forwarding hop applied" and resumes at v22 — whose
 * first statement ALTERs social_relay, a table that database never created.
 * Hence the crash-on-boot loop: `no such table: social_relay`.
 *
 * The fork point is exactly v18, and mainline v19–v28 are replay-safe against
 * such a database: v19 creates the social tables fresh, v20–v25 add their
 * columns to those fresh tables, v26/v28 are CREATE TABLE IF NOT EXISTS
 * no-ops, and v27 rebuilds the customer-review tables by copying from
 * themselves, which preserves the rows. So the whole repair is to put
 * user_version back to the fork point and let the normal loop run.
 *
 * The signature is deliberately narrow — user_version past the fork, customer
 * review present, social absent — because officially-released databases must
 * not be touched. v1–v21 are byte-identical between desktop-v1.3.2 and today
 * apart from one comment, so a real 1.3.2 install at user_version=21 has the
 * social tables and fails this check, as does any fully-migrated database.
 */
function repairBranchRenumberedSchema(db: Database, current: number): number {
  const FORK_POINT = 18
  // The branch's migration list ended at its own v21, so a database it touched
  // can only be at 19, 20 or 21. Bounding the top end matters: without it the
  // signature also matches synthetic test harnesses that build a customer-review
  // schema at a later user_version without any social tables, and rewinding
  // those would replay migrations they never meant to run.
  const BRANCH_TERMINAL = 21
  if (current <= FORK_POINT || current > BRANCH_TERMINAL) return current
  if (!hasTable(db, 'customer_reviews')) return current
  if (hasTable(db, 'social_echo')) return current
  console.error(
    `[db] user_version=${current} but the social schema is missing and customer-review tables are present — `
    + `this database came from the pre-merge customer-review build (issue #79). `
    + `Rewinding to v${FORK_POINT} and re-applying v${FORK_POINT + 1}+ to restore the missing tables.`,
  )
  db.exec(`PRAGMA user_version = ${FORK_POINT};`)
  return FORK_POINT
}

/**
 * Apply any migrations whose index is greater than the database's current
 * PRAGMA user_version. Exported so tests can drive the runner against a
 * pre-populated in-memory db (e.g. simulating an upgrade from v9).
 */
export function runMigrations(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const current = repairBranchRenumberedSchema(db, row?.user_version ?? 0)
  for (let i = current; i < migrations.length; i++) {
    const next = migrations[i]!
    db.transaction(() => {
      next(db)
      // PRAGMA user_version doesn't accept bound params; safe — value is
      // a literal integer index from our own array, not user input.
      db.exec(`PRAGMA user_version = ${i + 1};`)
    })()
  }
}

/** Test helper — opens a fresh in-memory db with all migrations applied. */
export function openTestDb(): Database {
  return openDb({ path: ':memory:' })
}

/**
 * Mark a legacy state file as imported by renaming it to `<file>.migrated`.
 *
 * Concurrent-first-boot safety: when daemon + CLI both boot against a
 * pre-PR7 install, both can pass the `existsSync` gate in their store
 * factories, both run their (idempotent) INSERT OR REPLACE/IGNORE
 * transactions, and both reach the rename. The first wins; the second's
 * `renameSync` would throw ENOENT and propagate as an unhelpful error
 * out of the store constructor. Swallow ENOENT here — the file being
 * gone IS the success state.
 *
 * Other errors (EACCES, ENOSPC, …) still propagate.
 */
export function renameMigrated(file: string): void {
  try {
    renameSync(file, `${file}.migrated`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}
