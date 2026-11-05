/**
 * topic_search 工具的路由(话题 T2 后续 ①):主模型自己搜主人那条对话的话题(索引 + 条目)。只读、只给 admin 会话;
 * 私密话题只有从主人自己的对话里搜才给(daemon/threads/recall 的 makeTopicSearch 判)。
 */
import type { Db } from '../../lib/db'
import type { RouteTable } from '../../daemon/internal-api/types'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeTopicSearch } from '../../daemon/threads/recall'

export function topicRoutes(d: { db: Db; ownerChatId: () => string | null }): RouteTable {
  const search = makeTopicSearch({ threads: makeThreadsStore(d.db), ownerChatId: d.ownerChatId })
  return {
    'POST /v1/memory/topics/search': async (_q, body, caller) => {
      // 路由表已经把门设在 admin;这里再兜一层(直连本机端口的调用也一样)
      if (caller && caller.tier !== 'admin') return { status: 403, body: { ok: false, error: 'forbidden' } }
      const b = (body ?? {}) as { query?: unknown; limit?: unknown }
      if (typeof b.query !== 'string' || !b.query.trim() || b.query.length > 500) return { status: 400, body: { ok: false, error: 'query 要是 1–500 字的字符串' } }
      const limit = typeof b.limit === 'number' && Number.isInteger(b.limit) ? b.limit : 3
      return { status: 200, body: { ok: true, topics: await search(caller?.chatId, b.query, limit) } }
    },
  }
}
