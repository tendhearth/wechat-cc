/**
 * 记忆文件的读 / 写 / 列 / 删(RFC 03 P1.B B2;wechat MCP 的 memory_read / memory_write / memory_list / memory_delete
 * 走的就是这四条)。原来在 internal-api 的总表里,记忆搬进功能目录时跟过来(架构终态 A5),路由表标了 module: 'memory'。
 *
 * 两层授权都在这里:会话只能碰自己那个对话的子目录(memoryScopeDenied);每晚整理的那几份只归 daemon(curatedMemoryDenied)。
 * 路径逃出记忆根目录由 MemoryFS 自己的 resolveSafe 拦。
 */
import { posix } from 'node:path'
import type { Db } from '../../lib/db'
import type { UserTier } from '../../domain/user-tier'
import type { MemoryFS } from '../../adapters/store/memory-fs'
import { makeEventsStore } from '../../daemon/events/store'
import { errMsg, type RouteTable } from '../../daemon/internal-api/types'
import type { MemoryReadRequestT, MemoryWriteRequestT, MemoryDeleteRequestT } from '../../daemon/internal-api/schema'
import { chatOfProfilePath, recordProfileWrite } from './today-draft'

export interface MemoryFsRoutesDeps {
  /** 整个记忆目录那一份(地基里造的,layout 'all-chats')。 */
  memory: MemoryFS
  /** 删记忆时往那个对话的事件流里记一笔审计(daemon 里总有;测试不给 ⇒ 删除回 503 db_not_wired)。 */
  db?: Db
  log?: (tag: string, line: string) => void
}

/**
 * Non-admin SESSION callers may only touch their own chat's memory subtree
 * (`<chatId>/...`) — closes the cross-chat write path that let any trusted
 * chat inject into another chat's persona.md (which broadcasts into every
 * chat's system prompt — persona design §2). File-origin tokens (the
 * operator CLI, which reads the daemon-wide token file) and admin sessions
 * are unrestricted — same trust posture as before this hardening.
 *
 * This is an AUTHORIZATION layer on top of, not instead of, MemoryFS's own
 * resolveSafe traversal guard (adapters/store/memory-fs.ts) — that guard stops path escapes
 * off the memory root; this stops in-bounds cross-chat access.
 */
function memoryScopeDenied(path: string, caller?: { tier: UserTier; origin: string; chatId?: string }): boolean {
  if (!caller || caller.origin !== 'session' || caller.tier === 'admin') return false
  if (!caller.chatId) return true                      // session with unknown chat ⇒ deny (fail closed)
  const norm = path.replace(/\\/g, '/')
  if (norm.split('/').some(seg => seg === '..')) return true
  return !(norm === caller.chatId || norm.startsWith(`${caller.chatId}/`))
}

/**
 * 每晚整理的长期记忆由 daemon 独管:会话(任何 tier)不许写 / 删 `<chat>/memory.md`;
 * CLI / 桌面(非 session 来源)照常。
 *
 * Must match the RESOLVED path, not the raw one — MemoryFS's resolveSafe
 * (adapters/store/memory-fs.ts) normalizes via `resolve(root, relPath)` before touching disk,
 * so `./ownerchat/memory.md`, `ownerchat//memory.md`, and
 * `ownerchat/x/../memory.md` all land on the same file as `ownerchat/
 * memory.md` and must be caught too (fix round 1, 2026-09-25). Also
 * case-insensitive: default macOS APFS is case-insensitive, so
 * `ownerchat/Memory.md` is the same file on disk there. And trailing
 * slash(es) — `resolve()` strips them (`ownerchat/memory.md/` resolves to
 * the same file) but `posix.normalize` keeps one, so they must be stripped
 * separately before the `$`-anchored match (fix round 2, 2026-09-25).
 */
function curatedMemoryDenied(path: string, caller?: { origin: string }): boolean {
  if (!caller || caller.origin !== 'session') return false
  const n = posix.normalize(path.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  // today-draft.md(今天的草稿,2026-10-01)同样只归 daemon:它由 profile.md 写入派生、每晚被整理消费,
  // 会话手写进去会被每次对话当成「主人今天说过的话」注入。
  // corrections.md(主人纠正过的条目,2026-10-10)同理:会话整份重写会把纠正抹掉,第二晚又被写回。
  return /^[^/]+\/(?:memory|today-draft|corrections)\.md$/i.test(n)
}
const CURATED_READONLY = {
  status: 200 as const,
  body: { ok: false, error: 'curated_memory_readonly', hint: 'memory.md、today-draft.md 和 corrections.md 由后台维护,白天别直接改:新情况记到 profile.md(新增的行会自动进今天的草稿)或 notes/,今晚会整理进去。' },
}

export function memoryFsRoutes(deps: MemoryFsRoutesDeps): RouteTable {
  return {
    'POST /v1/memory/read': (_q, body, caller) => {
      // Body is pre-validated by index.ts via MemoryReadRequest schema.
      const { path } = body as MemoryReadRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        const content = deps.memory.read(path)
        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/write': (_q, body, caller) => {
      // Body is pre-validated by index.ts via MemoryWriteRequest schema.
      const { path, content } = body as MemoryWriteRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      if (curatedMemoryDenied(path, caller)) return CURATED_READONLY
      try {
        // 同日失忆(2026-10-01):CC 写 <chat>/profile.md 时,新冒出来的行进今天的草稿,别的会话马上看得到。
        const draftChat = caller?.origin === 'session' ? chatOfProfilePath(path) : null
        const before = draftChat ? deps.memory.read(path) : null
        // CC 自己记笔记 ⇒ 生成物只是不全('added');别的来路(主人在桌面 / 设置里写)⇒ 缺省 'retracted'。
        deps.memory.write(path, content, caller?.origin === 'session' ? { reason: 'added' } : undefined)
        if (draftChat) {
          try { recordProfileWrite(deps.memory, draftChat, before, content) }
          catch (err) { deps.log?.('MEMORY', `today-draft append failed: ${errMsg(err)}`) }
        }
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'GET /v1/memory/list': (q, _body, caller) => {
      let dir = q.get('dir')
      // The system prompt's default recall flow ("回复前: memory_list + 读相关
      // .md") calls this with no `dir` at all. For a scoped (non-admin
      // session) caller that used to fail scope-denial on the root — every
      // trusted/guest chat's default recall silently 403'd. The correct
      // meaning of "list my memory" for a scoped caller IS its own subtree,
      // so default to that instead of evaluating the root. Explicit `dir`
      // still goes through the normal scope check below (own subtree ok,
      // others 403); unscoped callers (file token / admin) are unaffected.
      if (dir === null && caller?.origin === 'session' && caller.tier !== 'admin' && caller.chatId) {
        dir = caller.chatId
      }
      if (memoryScopeDenied(dir ?? '', caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        return { status: 200, body: { files: deps.memory.list(dir ?? undefined) } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/delete': async (_q, body, caller) => {
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      // Body is pre-validated by index.ts via MemoryDeleteRequest schema.
      const { chat_id, path, reason } = body as MemoryDeleteRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      if (curatedMemoryDenied(path, caller)) return CURATED_READONLY
      try {
        const tombstone = deps.memory.softDelete(path)
        if (tombstone === null) {
          return { status: 200, body: { ok: true, existed: false } }
        }
        // Per-chat audit log. Constructed per-call — prepared-statement
        // cache lives on db, not store, so this is cheap.
        // 会话来的:审计记到它自己的 chat(路径已被 memoryScopeDenied 限在那里),
        // 不信模型填的 chat_id —— 否则能往别人的事件流里写一条伪造的「删了记忆」。
        const auditChat = caller?.origin === 'session' && caller.chatId ? caller.chatId : chat_id
        await makeEventsStore(deps.db, auditChat).append({
          kind: 'memory_deleted',
          trigger: 'mcp_tool_call',
          reasoning: reason,
          memory_path: tombstone,
        })
        return { status: 200, body: { ok: true, existed: true, tombstone } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
  }
}
