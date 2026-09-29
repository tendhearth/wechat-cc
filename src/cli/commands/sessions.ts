// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { isCompiledBundle } from '../../lib/runtime-info'
import { emitJson } from '../output'
import { SessionsListProjectsOutput, SessionsListChatsOutput, SessionsReadJsonlOutput, SessionsDeleteOutput, SessionsSearchOutput } from '../schema'
// ── PR4 batch 3a — small-namespace state inspection / config commands ─
//
// 4 namespaces, 12 leaves total. All bounded: read-only or
// single-store / single-config-file writes. No daemon restart, no
// ilink, no contextToken. Same defineCommand pattern as batch 2.

const sessionsListProjectsCmd = defineCommand({
  meta: { name: 'list-projects', description: 'Project sessions with cached summaries' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
    chat: { type: 'string', description: 'Filter to one contact (chat_id)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('../../core/session-store')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const records = Object.values(store.all())
    let projects
    if (args.chat) {
      const { filterProjectsByChat } = await import('../sessions-helpers')
      projects = filterProjectsByChat(records, args.chat)
    } else {
      // Unchanged legacy behavior: one row per alias across all chats so
      // existing dashboards keep rendering.
      const byAlias: Record<string, typeof records[number]> = {}
      for (const rec of records) {
        const prev = byAlias[rec.alias]
        if (!prev || Date.parse(rec.last_used_at) > Date.parse(prev.last_used_at)) byAlias[rec.alias] = rec
      }
      projects = Object.values(byAlias).map(rec => ({
        alias: rec.alias,
        session_id: rec.session_id,
        last_used_at: rec.last_used_at,
        summary: rec.summary ?? null,
        summary_updated_at: rec.summary_updated_at ?? null,
      }))
    }
    if (args.json) emitJson(SessionsListProjectsOutput.parse({ ok: true, projects }), outFile)
    else console.log(projects.map(p => `${p.alias} ${p.last_used_at}`).join('\n'))

    // Fire-and-forget: refresh stale summaries in the background. The current
    // request returns immediately with whatever's cached; next list call will
    // pick up the fresh summaries. WECHAT_CC_DISABLE_SUMMARIZER=1 skips for
    // CI/e2e where SDK calls are undesirable.
    if (process.env.WECHAT_CC_DISABLE_SUMMARIZER !== '1') {
      void (async () => {
        try {
          // Guardrail #1 (2026-07-23-daemon-owns-llm-memory-ops, Task 3): this
          // is fire-and-forget background work, not a user-facing command, so
          // there's no result to delegate/print — a compiled sidecar just
          // skips the inline query() spawn and logs once. The next `list-
          // projects` call (possibly against a running daemon) picks summaries
          // back up; this path never had a hard freshness guarantee anyway.
          if (isCompiledBundle()) {
            console.error('[summarizer] skip inline refresh in compiled sidecar (daemon-owned LLM ops)')
            return
          }
          const { triggerStaleSummaryRefresh } = await import('../../daemon/sessions/summarizer-runtime')
          // resolveIntrospectChatId is named for its first caller (introspect)
          // but it's actually a generic "default chat" resolver that reads
          // companion config. Reusing it here avoids extracting yet another
          // helper for what is, today, the same v0.4.x single-chat lookup.
          const { resolveIntrospectChatId } = await import('../../daemon/companion/introspect-runtime')
          const { query } = await import('@anthropic-ai/claude-agent-sdk')
          await triggerStaleSummaryRefresh({
            stateDir: STATE_DIR,
            db,
            resolveChatId: () => resolveIntrospectChatId(STATE_DIR),
            sdkEval: async (prompt) => {
              let text = ''
              const q = query({ prompt, options: { model: 'claude-haiku-4-5', maxTurns: 1 } })
              for await (const raw of q as AsyncGenerator<import('@anthropic-ai/claude-agent-sdk').SDKMessage>) {
                const msg = raw as unknown as { type: string; message?: { content?: unknown } }
                if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
                  for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
                    if (part.type === 'text' && typeof part.text === 'string') text += part.text
                  }
                }
              }
              return text
            },
          })
        } catch { /* swallow — summary is non-critical */ }
      })()
    }
  },
})

const sessionsReadJsonlCmd = defineCommand({
  meta: { name: 'read-jsonl', description: "Read all turns from the alias's session jsonl" },
  args: {
    alias: { type: 'positional', required: true, description: 'Session alias', valueHint: 'alias' },
    chat: { type: 'string', description: 'Scope to one contact (chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('../../core/session-store')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    // v0.6 Task 8: the store is now triple-keyed (alias, provider, chatId).
    // The legacy CLI takes only an alias — pick the most-recent row across
    // every provider/chat under that alias so existing scripts keep working.
    // With --chat, scope to that contact's row instead.
    const { pickReadRecord } = await import('../sessions-helpers')
    const rec = pickReadRecord(Object.values(store.all()), args.alias, args.chat)
    if (!rec) {
      // v0.5.11 — error paths must also honour --out-file. Without this,
      // the dashboard's via-file shim path reads ENOENT instead of an
      // error envelope.
      if (args.json) emitJson(SessionsReadJsonlOutput.parse({ ok: false, error: 'no such alias' }), outFile)
      else console.log('no such alias')
      return
    }
    // v0.5.12 — codex sessions: read codex's rollout jsonl (sharded by
    // date under ~/.codex/sessions/<YYYY>/<MM>/<DD>/) and convert events
    // into claude-shape turns so the dashboard's existing renderer works
    // unchanged. Skipping is no longer the right answer; users who tested
    // /chat or /codex want to see their conversation just like with claude.
    if (rec.provider === 'codex') {
      const { findCodexRollout, readCodexJsonlAsClaudeTurns } = await import('../../lib/codex-jsonl')
      const { homedir } = await import('node:os')
      const codexRoot = join(homedir(), '.codex', 'sessions')
      const path = findCodexRollout(codexRoot, rec.session_id)
      if (!path) {
        if (args.json) emitJson(SessionsReadJsonlOutput.parse({ ok: false, error: 'codex rollout not found', codex_root: codexRoot }), outFile)
        else console.log('codex rollout not found')
        return
      }
      const turns = readCodexJsonlAsClaudeTurns(path)
      if (args.json) emitJson(SessionsReadJsonlOutput.parse({ ok: true, alias: args.alias, session_id: rec.session_id, provider: 'codex', turns }), outFile)
      else console.log(`${turns.length} turns (codex)`)
      return
    }
    const { resolveProjectJsonlPath } = await import('../../daemon/sessions/path-resolver')
    const path = resolveProjectJsonlPath(args.alias, rec.session_id)
    const { existsSync, readFileSync } = await import('node:fs')
    if (!existsSync(path)) {
      if (args.json) emitJson(SessionsReadJsonlOutput.parse({ ok: false, error: 'jsonl missing', path }), outFile)
      else console.log('jsonl missing')
      return
    }
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    const turns = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(t => t !== null)
    if (args.json) emitJson(SessionsReadJsonlOutput.parse({ ok: true, alias: args.alias, session_id: rec.session_id, turns }), outFile)
    else console.log(`${turns.length} turns`)
  },
})

const sessionsDeleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Remove the sessions table entry (jsonl on disk untouched)' },
  args: {
    alias: { type: 'positional', required: true, description: 'Session alias', valueHint: 'alias' },
    chat: { type: 'string', description: 'Delete only this contact\'s session under the alias' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeSessionStore } = await import('../../core/session-store')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const { chatsToDelete } = await import('../sessions-helpers')
    const chats = chatsToDelete(Object.values(store.all()), args.alias, args.chat)
    for (const chatId of chats) store.delete({ alias: args.alias, chatId })
    await store.flush()
    console.log(args.json ? JSON.stringify(SessionsDeleteOutput.parse({ ok: true, deleted: args.alias }), null, 2) : `deleted ${args.alias}`)
  },
})

const sessionsSearchCmd = defineCommand({
  meta: { name: 'search', description: 'Naive case-insensitive substring search across all session jsonls' },
  args: {
    query: { type: 'positional', required: true, description: 'Search query', valueHint: 'query' },
    limit: { type: 'string', description: 'Max hits (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) ? limitNum : 50
    const outFile = args['out-file']
    const { searchAcrossSessions } = await import('../../daemon/sessions/searcher')
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    const hits = await searchAcrossSessions(args.query, { limit, stateDir: STATE_DIR, db })
    if (args.json) emitJson(SessionsSearchOutput.parse({ ok: true, query: args.query, hits }), outFile)
    else console.log(hits.map(h => `${h.alias} · ${h.snippet}`).join('\n'))
  },
})

const sessionsListChatsCmd = defineCommand({
  meta: { name: 'list-chats', description: 'Contacts (chats) that have sessions, for the pane sidebar' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe truncation in compiled binaries)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('../../core/session-store')
    const { makeConversationStore } = await import('../../core/conversation-store')
    const { openWechatDb } = await import('../../lib/db')
    const { groupChats } = await import('../sessions-helpers')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const convs = makeConversationStore(db)
    const records = Object.values(store.all())
    const chats = groupChats(
      records,
      id => convs.getIdentity(id)?.last_user_name ?? null,
      id => convs.getIdentity(id)?.account_id ?? null,
    )
    if (args.json) emitJson(SessionsListChatsOutput.parse({ ok: true, chats }), outFile)
    else console.log(chats.map(c => `${c.user_name ?? c.chat_id} (${c.session_count})`).join('\n'))
  },
})

export const sessionsCmd = defineCommand({
  meta: { name: 'sessions', description: 'Per-project session inspection (resume-id store + jsonl readers)' },
  subCommands: {
    'list-chats': sessionsListChatsCmd,
    'list-projects': sessionsListProjectsCmd,
    'read-jsonl': sessionsReadJsonlCmd,
    delete: sessionsDeleteCmd,
    search: sessionsSearchCmd,
  },
})
