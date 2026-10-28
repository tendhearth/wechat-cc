/**
 * 主人在桌面记忆页上看 / 改的那一份(架构终态 F6):以前桌面起 `wechat-cc memory list|read|write|profile-read|profile status|projects`,
 * 现在走这六条。每条调的是那条 CLI 命令调的同一个函数(lib/memory、lib/memory-synthesis),回的也是同一个形状
 * (`src/cli/schema.ts` 里那几个 zod 契约原样 parse)—— 桌面那一侧一个字没改形状。
 *
 * 为什么不是已有的 `/v1/memory/list|read|write`:那四条是 CC 自己(MCP 记忆工具)看到的那一份 —— 过期的总览藏起来、
 * 读的时候加过期标签、只给路径不给大小 / 时间、会话只能碰自己那个对话;桌面要的是主人看到的原样文件(带大小、时间、
 * 主人原话 owner.md 不许整份覆盖、生成物整份写要先过 wholeFileWriteRefusal)。两份是两件事,不硬合。
 *
 * admin + operator,经宿主代理(路由表里打了 tauri / devProxy):这些是所有对话的记忆,trusted 的 file token 别人对话的会话也有。
 */
import type { Db } from '../../lib/db'
import type { RouteTable } from '../../daemon/internal-api/types'
import { listAllMemory, readMemoryFile, writeMemoryFile, readMemoryProfileFile } from '../../lib/memory'
import { wholeFileWriteRefusal } from '../../lib/memory-edit'
import { memoryArtifactKind } from '../../lib/memory-artifacts'
import { loadCompanionConfig } from '../../lib/companion-config'
import { getMemoryProfileStatus, summarizeProjectMemories } from '../../lib/memory-synthesis'
import { makeLifeStoresReader } from '../../daemon/life-stores'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import { makeMemoryWriter, synthesisMemoryFor } from './memory-export'
import { parseMemoryDoc } from './curated-doc'
import { MemoryListOutput, MemoryReadOutput, MemoryWriteOutput, MemoryProfileStatusOutput } from '../../cli/schema'

export interface MemoryOwnerRoutesDeps {
  stateDir: string
  db: Db
  /** 没写 chat_id ⇒ access.json 里唯一的 admin(和 CLI 不带 --chat-id 时一样)。 */
  resolveAdminChatId?: () => string | null
  /** 测试用:本机项目记忆的根(缺省 ~/.claude/projects,和 CLI 一样)。 */
  projectsRoot?: string
}

const msgOf = (err: unknown) => err instanceof Error ? err.message : String(err)
const str = (v: unknown) => typeof v === 'string' ? v : ''

export function memoryOwnerRoutes(deps: MemoryOwnerRoutesDeps): RouteTable {
  const chatOf = (q: URLSearchParams) => q.get('chat_id') || deps.resolveAdminChatId?.() || null
  return {
    // = `memory list --json`
    'GET /v1/memory/files': () => ({ status: 200, body: MemoryListOutput.parse(listAllMemory(deps.stateDir)) }),

    // = `memory read <userId> <path> --json`(失败也是 200 + { ok: false, error },CLI 也是退出码 0)
    'GET /v1/memory/file': (q) => {
      const userId = q.get('user_id') ?? '', path = q.get('path') ?? ''
      try {
        // G6:memory.md / owner.md 从主库的表读(经导出器);别的文件照旧读磁盘
        const norm = path.split('\\').join('/').replace(/^(\.\/)+/, '').toLowerCase()
        const facts = norm === 'memory.md' || norm === 'owner.md' ? makeMemoryWriter({ store: makeMemoryFactsStore(deps.db), stateDir: deps.stateDir }) : null
        const fromTable = facts ? (norm === 'memory.md' ? facts.memoryMd(userId) : (facts.ownerMd(userId) || null)) : null
        if (facts && fromTable === null) throw new Error(`file not found: ${userId}/${path}`)
        const content = fromTable ?? readMemoryFile(deps.stateDir, userId, path)
        return { status: 200, body: MemoryReadOutput.parse({ ok: true, userId, path, content }) }
      } catch (err) {
        return { status: 200, body: MemoryReadOutput.parse({ ok: false, error: msgOf(err) }) }
      }
    },

    // = `memory write <userId> <path> --body-base64 … --json`(正文直接是字符串,不再 base64)
    'POST /v1/memory/file/write': (_q, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const userId = str(b.userId), path = str(b.path)
      try {
        if (typeof b.content !== 'string') throw new Error('content must be a string')
        // daemon 自己就在跑,所以只回那句拒绝(CLI 会再补一句「守护进程没在跑」)。
        const refusal = wholeFileWriteRefusal(path, memoryArtifactKind(path), userId, loadCompanionConfig(deps.stateDir).default_chat_id ?? null)
        if (refusal) throw new Error(refusal)
        // 架构终态 G4:搬进表的对话,memory.md 只经导出器写(先落表、再导出)—— 直接写文件就成了「手改」,下次开机才被
        // 存档、照文件同步。主人那一份上面已经拒了(要在记忆页逐行改)。
        const norm = path.split('\\').join('/').replace(/^(\.\/)+/, '').toLowerCase()
        const writer = makeMemoryWriter({ store: makeMemoryFactsStore(deps.db), stateDir: deps.stateDir })
        if (norm === 'memory.md' && writer.isOnTable(userId)) {
          const created = writer.memoryMd(userId) === null
          writer.fence(userId).invalidate('retracted')
          writer.commitMemory(userId, parseMemoryDoc(b.content), { actor: 'owner', ts: Date.now() }, new Date().toISOString())
          return { status: 200, body: MemoryWriteOutput.parse({ ok: true, userId, path, bytesWritten: Buffer.byteLength(b.content, 'utf8'), created }) }
        }
        const result = writeMemoryFile(deps.stateDir, userId, path, b.content, writer.fence(userId))
        return { status: 200, body: MemoryWriteOutput.parse({ ok: true, userId, path, ...result }) }
      } catch (err) {
        return { status: 200, body: MemoryWriteOutput.parse({ ok: false, error: msgOf(err) }) }
      }
    },

    // = `memory profile-read <chatId> --json`
    'GET /v1/memory/profile': (q) => {
      const chatId = chatOf(q) ?? ''
      try {
        const content = readMemoryProfileFile(deps.stateDir, chatId, makeMemoryFactsStore(deps.db).fence(chatId))
        return { status: 200, body: MemoryReadOutput.parse({ ok: true, userId: chatId, path: '_profile.json', content }) }
      } catch (err) {
        return { status: 200, body: MemoryReadOutput.parse({ ok: false, error: msgOf(err) }) }
      }
    },

    // = `memory profile status --chat-id <chatId> --json`
    'GET /v1/memory/profile/status': async (q) => {
      const chatId = chatOf(q)
      if (!chatId) return { status: 200, body: MemoryProfileStatusOutput.parse({ ok: false, error: 'No admins in access.json — pass --chat-id explicitly' }) }
      try {
        const status = await getMemoryProfileStatus({ memory: synthesisMemoryFor(deps.db, deps.stateDir, chatId), stateDir: deps.stateDir, adminChatId: chatId, lifeStores: makeLifeStoresReader(deps.db, deps.stateDir) })
        return { status: 200, body: MemoryProfileStatusOutput.parse({ ok: true, ...status }) }
      } catch (err) {
        return { status: 200, body: MemoryProfileStatusOutput.parse({ ok: false, error: msgOf(err) }) }
      }
    },

    // = `memory projects --json`(主人本机 ~/.claude/projects 下的项目记忆,只读)
    'GET /v1/memory/projects': () => ({ status: 200, body: { ok: true, projects: summarizeProjectMemories(deps.projectsRoot) } }),
  }
}
