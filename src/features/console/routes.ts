/**
 * 桌面控制台的读写(架构终态 F6):以前桌面起 `wechat-cc <命令> --json` 读的那些,现在 daemon 直接回。
 * **每条 = 一条 CLI 命令**:调的是那条命令调的同一个函数 / store,回的是同一个形状(`src/cli/schema.ts` 的契约原样 parse),
 * 桌面那一侧形状一个字没变。CLI 命令本身照旧在(终端里的人、脚本还用)。
 *
 *   GET  /v1/conversations/list         = conversations list --json
 *   GET  /v1/observations/list?chat_id  = observations list <chat> --json
 *   POST /v1/observations/archive       = observations archive <chat> <id> --json      { chat_id, id }
 *   GET  /v1/milestones/list?chat_id    = milestones list <chat> --json
 *   GET  /v1/events/list?chat_id&limit  = events list <chat> --limit N --json
 *   GET  /v1/access/list                = access list --json
 *   GET  /v1/avatar/info?key            = avatar info <key> --json
 *   POST /v1/avatar/set                 = avatar set <key> --base64 … --json           { key, base64 }
 *   POST /v1/avatar/remove              = avatar remove <key> --json                   { key }
 *   GET  /v1/sessions/projects?chat     = sessions list-projects [--chat C] --json
 *   GET  /v1/sessions/chats             = sessions list-chats --json
 *   POST /v1/sessions/delete            = sessions delete <alias> [--chat C] --json    { alias, chat? }
 *   GET  /v1/dialogue/timeline?chat_id&limit&before   = dialogue timeline …
 *   GET  /v1/dialogue/threads?chat_id&facet&include_private=1 = dialogue threads …
 *   GET  /v1/dialogue/thread?id         = dialogue thread-detail <id>
 *   GET  /v1/dialogue/search?chat_id&q&limit = dialogue search …
 *   POST /v1/dialogue/unlock            = dialogue unlock --passphrase …               { passphrase }
 *
 * CLI 那边「退出码非 0」的几处(头像设置失败、线索不存在)这里回 4xx + `{ error }`:宿主代理把它变成 invoke 失败,
 * 和以前 CLI 非 0 退出时桌面看到的一样。全部 admin + operator,经宿主代理(理由见路由表文件头)。
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import type { RouteTable } from '../../daemon/internal-api/types'
import type { ConversationStore } from '../../ports/conversation-store'
import { loadAccess } from '../../lib/access'
import { dialogueSearch, dialogueThreadDetail, dialogueThreads, dialogueTimeline, dialogueUnlock } from '../../lib/dialogue'
import { avatarInfo, removeAvatar, setAvatar } from '../../adapters/store/avatar-store'
import { makeSessionStore } from '../../adapters/store/session-store'
import { makeObservationsStore } from '../../daemon/observations/store'
import { makeMilestonesStore } from '../../daemon/milestones/store'
import { makeEventsStore } from '../../daemon/events/store'
import { chatsToDelete, filterProjectsByChat, groupChats } from '../../cli/sessions-helpers'
import {
  AvatarInfoOutput, AvatarRemoveOutput, AvatarSetOutput, ConversationsListOutput, EventsListOutput, MilestonesListOutput,
  ObservationsArchiveOutput, ObservationsListOutput, SessionsDeleteOutput, SessionsListChatsOutput, SessionsListProjectsOutput,
} from '../../cli/schema'

export interface ConsoleRoutesDeps {
  stateDir: string
  db: Db
  /** daemon 那一份(地基里造的;CLI 每次新开一份,读到的是同一张表)。 */
  conversationStore: ConversationStore
}

const msgOf = (err: unknown) => err instanceof Error ? err.message : String(err)
const str = (v: unknown) => typeof v === 'string' ? v : ''
/** CLI 的 `Number.parseInt(x, 10)`,不是有限数 / 不是正数时用缺省值(各命令自己的那个缺省)。 */
function intOr(raw: string | null, fallback: number, positive: boolean): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && (!positive || n > 0) ? n : fallback
}

export function consoleRoutes(deps: ConsoleRoutesDeps): RouteTable {
  const memoryRoot = join(deps.stateDir, 'memory')
  const sessions = () => makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })
  const chatParam = (q: URLSearchParams) => q.get('chat_id') ?? ''
  return {
    'GET /v1/conversations/list': () => {
      const store = deps.conversationStore
      const conversations = Object.entries(store.all()).map(([chat_id, rec]) => {
        const id = store.getIdentity(chat_id)
        return { chat_id, user_id: id?.user_id ?? null, account_id: id?.account_id ?? null, user_name: id?.last_user_name ?? null, mode: rec.mode }
      })
      return { status: 200, body: ConversationsListOutput.parse({ ok: true, conversations }) }
    },

    'GET /v1/observations/list': async (q) => {
      const chatId = chatParam(q)
      const store = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
      const list = q.get('include_archived') === '1' ? await store.listArchived() : await store.listActive()
      return { status: 200, body: ObservationsListOutput.parse({ ok: true, observations: list }) }
    },
    'POST /v1/observations/archive': async (_q, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const chatId = str(b.chat_id), id = str(b.id)
      const store = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
      await store.archive(id)
      return { status: 200, body: ObservationsArchiveOutput.parse({ ok: true, archived: id }) }
    },
    'GET /v1/milestones/list': async (q) => {
      const chatId = chatParam(q)
      const store = makeMilestonesStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'milestones.jsonl') })
      return { status: 200, body: MilestonesListOutput.parse({ ok: true, milestones: await store.list() }) }
    },
    'GET /v1/events/list': async (q) => {
      const chatId = chatParam(q)
      const store = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
      const list = await store.list({ limit: intOr(q.get('limit'), 50, false) })
      return { status: 200, body: EventsListOutput.parse({ ok: true, events: list }) }
    },

    'GET /v1/access/list': () => {
      const a = loadAccess()
      return { status: 200, body: { ok: true, dmPolicy: a.dmPolicy, admins: a.admins ?? [], trusted: a.trusted ?? [], allowFrom: a.allowFrom } }
    },

    'GET /v1/avatar/info': (q) => ({ status: 200, body: AvatarInfoOutput.parse({ ok: true, ...avatarInfo(deps.stateDir, q.get('key') ?? '') }) }),
    'POST /v1/avatar/set': (_q, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      try { return { status: 200, body: AvatarSetOutput.parse(setAvatar(deps.stateDir, str(b.key), str(b.base64))) } }
      catch (err) { return { status: 400, body: { ok: false, error: msgOf(err) } } }
    },
    'POST /v1/avatar/remove': (_q, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      return { status: 200, body: AvatarRemoveOutput.parse(removeAvatar(deps.stateDir, str(b.key))) }
    },

    'GET /v1/sessions/projects': (q) => {
      const records = Object.values(sessions().all())
      const chat = q.get('chat')
      let projects
      if (chat) projects = filterProjectsByChat(records, chat)
      else {
        // 和 CLI 一样:不带 --chat ⇒ 每个别名一行(跨对话取最近用过的那条)。
        const byAlias: Record<string, typeof records[number]> = {}
        for (const rec of records) {
          const prev = byAlias[rec.alias]
          if (!prev || Date.parse(rec.last_used_at) > Date.parse(prev.last_used_at)) byAlias[rec.alias] = rec
        }
        projects = Object.values(byAlias).map(rec => ({
          alias: rec.alias, session_id: rec.session_id, last_used_at: rec.last_used_at,
          summary: rec.summary ?? null, summary_updated_at: rec.summary_updated_at ?? null,
        }))
      }
      return { status: 200, body: SessionsListProjectsOutput.parse({ ok: true, projects }) }
    },
    'GET /v1/sessions/chats': () => {
      const records = Object.values(sessions().all())
      const convs = deps.conversationStore
      const chats = groupChats(records, id => convs.getIdentity(id)?.last_user_name ?? null, id => convs.getIdentity(id)?.account_id ?? null)
      return { status: 200, body: SessionsListChatsOutput.parse({ ok: true, chats }) }
    },
    'POST /v1/sessions/delete': async (_q, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const alias = str(b.alias)
      const store = sessions()
      for (const chatId of chatsToDelete(Object.values(store.all()), alias, typeof b.chat === 'string' && b.chat ? b.chat : undefined)) store.delete({ alias, chatId })
      await store.flush()
      return { status: 200, body: SessionsDeleteOutput.parse({ ok: true, deleted: alias }) }
    },

    'GET /v1/dialogue/timeline': async (q) => {
      const before = q.get('before')
      return { status: 200, body: await dialogueTimeline(deps.db, chatParam(q), { limit: intOr(q.get('limit'), 100, true), ...(before ? { beforeTs: before } : {}) }) }
    },
    'GET /v1/dialogue/threads': async (q) => {
      const facet = q.get('facet') as 'task' | 'knowledge' | 'life' | null
      return { status: 200, body: await dialogueThreads(deps.db, chatParam(q), { ...(facet ? { facet } : {}), includePrivate: q.get('include_private') === '1' }) }
    },
    'GET /v1/dialogue/thread': async (q) => {
      const id = q.get('id') ?? ''
      const result = await dialogueThreadDetail(deps.db, id)
      if (result === null) return { status: 404, body: { ok: false, error: `thread not found: ${id}` } }
      return { status: 200, body: result }
    },
    'GET /v1/dialogue/search': async (q) => ({
      status: 200, body: await dialogueSearch(deps.db, chatParam(q), q.get('q') ?? '', intOr(q.get('limit'), 50, true)),
    }),
    'POST /v1/dialogue/unlock': (_q, body) => ({
      status: 200, body: dialogueUnlock(deps.stateDir, str(((body ?? {}) as Record<string, unknown>).passphrase)),
    }),
  }
}
