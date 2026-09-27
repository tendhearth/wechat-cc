// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
// ── dialogue — backfill + (future) query commands ────────────────────
//
// Task 5: `wechat-cc dialogue backfill` imports agent session JSONLs into
// the messages table. Task 9 will add query/search subcommands here.

const dialogueTimelineCmd = defineCommand({
  meta: { name: 'timeline', description: 'Paged conversation timeline for a chat' },
  args: {
    'chat-id': { type: 'string', required: true, description: 'WeChat chat id' },
    limit: { type: 'string', description: 'page size (default 100)' },
    before: { type: 'string', description: 'page upward: only messages strictly before this ISO ts' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 100
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 100
    const { dialogueTimeline } = await import('../../lib/dialogue')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const result = await dialogueTimeline(db, args['chat-id'], {
      limit,
      ...(args.before ? { beforeTs: args.before } : {}),
    })
    console.log(JSON.stringify(result))
  },
})

const dialogueThreadsCmd = defineCommand({
  meta: { name: 'threads', description: 'List topic threads for a chat' },
  args: {
    'chat-id': { type: 'string', required: true, description: 'WeChat chat id' },
    facet: { type: 'string', description: 'Filter by facet: task | knowledge | life' },
    'include-private': { type: 'boolean', default: false, description: 'Include private threads (default false)' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const { dialogueThreads } = await import('../../lib/dialogue')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const facetArg = args.facet as 'task' | 'knowledge' | 'life' | undefined
    const result = await dialogueThreads(db, args['chat-id'], {
      ...(facetArg ? { facet: facetArg } : {}),
      includePrivate: Boolean(args['include-private']),
    })
    console.log(JSON.stringify(result))
  },
})

const dialogueSearchCmd = defineCommand({
  meta: { name: 'search', description: 'Substring search over messages for a chat' },
  args: {
    'chat-id': { type: 'string', required: true, description: 'WeChat chat id' },
    query: { type: 'positional', required: true, description: 'Search query', valueHint: 'query' },
    limit: { type: 'string', description: 'Max hits (default 50)' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 50
    const { dialogueSearch } = await import('../../lib/dialogue')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const result = await dialogueSearch(db, args['chat-id'], args.query, limit)
    console.log(JSON.stringify(result))
  },
})

const dialogueThreadDetailCmd = defineCommand({
  meta: { name: 'thread-detail', description: 'Full thread detail with per-episode messages' },
  args: {
    id: { type: 'positional', required: true, description: 'Thread id (thr_…)', valueHint: 'id' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const { dialogueThreadDetail } = await import('../../lib/dialogue')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const result = await dialogueThreadDetail(db, args.id)
    if (result === null) {
      console.log(JSON.stringify({ ok: false, error: `thread not found: ${args.id}` }))
      process.exit(1)
    }
    console.log(JSON.stringify(result))
  },
})

const dialogueBackfillCmd = defineCommand({
  meta: { name: 'backfill', description: 'Import history from agent session JSONLs into the messages table' },
  args: {
    'chat-id': { type: 'string', description: 'Attribute history to this chat (default: sole admin in access.json)' },
    'dry-run': { type: 'boolean', default: false, description: 'Scan and count without writing' },
  },
  async run({ args }) {
    // Resolve chat-id: use --chat-id if provided, else sole admin from access.json
    let chatId = args['chat-id']
    if (!chatId) {
      const accessPath = join(STATE_DIR, 'access.json')
      let access: { admins?: string[]; allowFrom?: string[] } = {}
      try {
        access = readJsonFile(accessPath)
      } catch {
        // file missing or corrupt — will fail below
      }
      const admins = access.admins ?? []
      if (admins.length === 1) {
        chatId = admins[0]!
      } else {
        console.error(
          admins.length === 0
            ? 'No admins in access.json — pass --chat-id explicitly'
            : `Multiple admins in access.json (${admins.join(', ')}) — pass --chat-id explicitly`,
        )
        process.exit(1)
      }
    }

    const dryRun = Boolean(args['dry-run'])
    const { homedir } = await import('node:os')
    const home = homedir()

    const { backfillKnownClaudeSessions, backfillKnownCodexSessions } = await import('../../lib/dialogue')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)

    // ── Collect known Claude session ids from the daemon DB ──────────────
    // Primary source: sessions table (provider='claude').
    // Secondary source: events.jsonl_session_id (historical introspect references).
    const claudeIdRows = db
      .query<{ session_id: string }, []>(
        "SELECT session_id FROM sessions WHERE provider='claude'",
      )
      .all()
    const eventIdRows = db
      .query<{ jsonl_session_id: string }, []>(
        'SELECT DISTINCT jsonl_session_id FROM events WHERE jsonl_session_id IS NOT NULL',
      )
      .all()
    const knownClaudeIds = new Set<string>([
      ...claudeIdRows.map(r => r.session_id),
      ...eventIdRows.map(r => r.jsonl_session_id),
    ])

    const projectsRoot = join(home, '.claude', 'projects')
    const claudeResult = await backfillKnownClaudeSessions(
      db, projectsRoot, knownClaudeIds, chatId, dryRun,
    )

    // ── Collect known Codex thread ids from the daemon DB ────────────────
    const codexIdRows = db
      .query<{ session_id: string }, []>(
        "SELECT session_id FROM sessions WHERE provider='codex'",
      )
      .all()
    const knownCodexIds = new Set<string>(codexIdRows.map(r => r.session_id))

    const codexRoot = join(home, '.codex', 'sessions')
    const codexResult = await backfillKnownCodexSessions(
      db, codexRoot, knownCodexIds, chatId, dryRun,
    )

    const result = {
      chatId,
      dryRun,
      claude: {
        knownSessions: claudeResult.knownSessions,
        filesFound: claudeResult.filesFound,
        scanned: claudeResult.scanned,
        inserted: claudeResult.inserted,
      },
      codex: {
        knownSessions: codexResult.knownSessions,
        filesFound: codexResult.filesFound,
        scanned: codexResult.scanned,
        inserted: codexResult.inserted,
      },
    }
    console.log(JSON.stringify(result, null, 2))
  },
})

const dialogueLockSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set the dialogue private-thread passphrase (scrypt hash stored in agent-config.json)' },
  args: {
    passphrase: { type: 'string', required: true, description: 'Passphrase to lock private threads behind' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const { dialogueLockSet } = await import('../../lib/dialogue')
    dialogueLockSet(STATE_DIR, args.passphrase)
    console.log(JSON.stringify({ ok: true }))
  },
})

const dialogueLockCmd = defineCommand({
  meta: { name: 'lock', description: 'Manage the dialogue private-thread passphrase' },
  subCommands: {
    set: dialogueLockSetCmd,
  },
})

const dialogueUnlockCmd = defineCommand({
  meta: { name: 'unlock', description: 'Verify the dialogue private-thread passphrase' },
  args: {
    passphrase: { type: 'string', required: true, description: 'Candidate passphrase' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const { dialogueUnlock } = await import('../../lib/dialogue')
    const result = dialogueUnlock(STATE_DIR, args.passphrase)
    console.log(JSON.stringify(result))
  },
})

export const dialogueCmd = defineCommand({
  meta: { name: 'dialogue', description: 'Dialogue page data — backfill + query commands' },
  subCommands: {
    backfill: dialogueBackfillCmd,
    timeline: dialogueTimelineCmd,
    threads: dialogueThreadsCmd,
    search: dialogueSearchCmd,
    'thread-detail': dialogueThreadDetailCmd,
    lock: dialogueLockCmd,
    unlock: dialogueUnlockCmd,
  },
})
