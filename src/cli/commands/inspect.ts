// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { EventsListOutput, ObservationsListOutput, ObservationsArchiveOutput, MilestonesListOutput, ConversationsListOutput } from '../schema'
// ── PR4 batch 2 — read-only inspection commands ─────────────────────
//
// Same defineCommand pattern as batch 1 (status / list / etc.) but with
// nested subCommands for namespaces that have multiple verbs
// (`events list`, `observations list|archive`, etc.). Citty's `--help`
// auto-generates per-level usage so users get correct help on either
// `wechat-cc events --help` or `wechat-cc events list --help`.
//
// Each leaf does the same work the legacy switch did — preserved
// verbatim so behavior diff is zero. Only argv parsing moves.

const eventsListCmd = defineCommand({
  meta: { name: 'list', description: 'Tail Companion decisions log (push/skip/observation/milestone)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    limit: { type: 'string', description: 'Max events to return (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) ? limitNum : 50
    const { makeEventsStore } = await import('../../daemon/events/store')
    const { openWechatDb } = await import('../../lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeEventsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'events.jsonl'),
    })
    const list = await store.list({ limit })
    console.log(args.json ? JSON.stringify(EventsListOutput.parse({ ok: true, events: list }), null, 2) : list.map(e => `${e.ts} ${e.kind} ${e.trigger}`).join('\n'))
  },
})

export const eventsCmd = defineCommand({
  meta: { name: 'events', description: 'Companion decisions log' },
  subCommands: { list: eventsListCmd },
})

const observationsListCmd = defineCommand({
  meta: { name: 'list', description: 'List observations (active by default; --include-archived for the archive)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    'include-archived': { type: 'boolean', description: 'Show archived items instead of active' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const includeArchived = Boolean(args['include-archived'])
    const { makeObservationsStore } = await import('../../daemon/observations/store')
    const { openWechatDb } = await import('../../lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    const list = includeArchived ? await store.listArchived() : await store.listActive()
    console.log(args.json ? JSON.stringify(ObservationsListOutput.parse({ ok: true, observations: list }), null, 2) : list.map(o => `${o.ts} ${o.body}`).join('\n'))
  },
})

const observationsArchiveCmd = defineCommand({
  meta: { name: 'archive', description: 'Mark an observation archived (user "ignore")' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    obsId: { type: 'positional', required: true, description: 'Observation id (obs_…)', valueHint: 'obs-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeObservationsStore } = await import('../../daemon/observations/store')
    const { openWechatDb } = await import('../../lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    await store.archive(args.obsId)
    console.log(args.json ? JSON.stringify(ObservationsArchiveOutput.parse({ ok: true, archived: args.obsId }), null, 2) : `archived ${args.obsId}`)
  },
})

export const observationsCmd = defineCommand({
  meta: { name: 'observations', description: 'Companion observations (per chat)' },
  subCommands: {
    list: observationsListCmd,
    archive: observationsArchiveCmd,
  },
})

const milestonesListCmd = defineCommand({
  meta: { name: 'list', description: 'Per-chat milestones (id-deduped)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeMilestonesStore } = await import('../../daemon/milestones/store')
    const { openWechatDb } = await import('../../lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeMilestonesStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'milestones.jsonl'),
    })
    const list = await store.list()
    console.log(args.json ? JSON.stringify(MilestonesListOutput.parse({ ok: true, milestones: list }), null, 2) : list.map(m => `${m.ts} ${m.body}`).join('\n'))
  },
})

export const milestonesCmd = defineCommand({
  meta: { name: 'milestones', description: 'Per-chat milestone fires' },
  subCommands: { list: milestonesListCmd },
})

const conversationsListCmd = defineCommand({
  meta: { name: 'list', description: 'Read-only snapshot of conversations + identities' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Read-only snapshot of conversations. Used by the desktop dashboard
    // (P5.2) to display per-chat mode badges. PR5 Task 22: identity now
    // sources from conversationStore.getIdentity (user_names.json was
    // deprecated in Task 21); envelope grows user_id/account_id alongside
    // user_name so the dashboard table can render account/user columns.
    const { makeConversationStore } = await import('../../core/conversation-store')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeConversationStore(db, { migrateFromFile: join(STATE_DIR, 'conversations.json') })
    const conversations = Object.entries(store.all()).map(([chat_id, rec]) => {
      const id = store.getIdentity(chat_id)
      return {
        chat_id,
        user_id: id?.user_id ?? null,
        account_id: id?.account_id ?? null,
        user_name: id?.last_user_name ?? null,
        mode: rec.mode,
      }
    })
    if (args.json) console.log(JSON.stringify(ConversationsListOutput.parse({ ok: true, conversations }), null, 2))
    else console.log(conversations.map(c => `${c.chat_id} ${c.user_name ?? ''} ${c.mode.kind}`).join('\n'))
  },
})

export const conversationsCmd = defineCommand({
  meta: { name: 'conversations', description: 'Per-chat conversation modes (RFC 03)' },
  subCommands: { list: conversationsListCmd },
})
