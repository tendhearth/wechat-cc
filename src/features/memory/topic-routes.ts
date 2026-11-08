import { makeTopicBubbles, topicRevision } from '../../lib/topic-bubbles'
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
    'POST /v1/memory/topics/search': async (_q, body, caller, ctx) => {
      // 路由表已经把门设在 admin;这里再兜一层(直连本机端口的调用也一样)
      if (caller && caller.tier !== 'admin') return { status: 403, body: { ok: false, error: 'forbidden' } }
      const b = (body ?? {}) as { query?: unknown; limit?: unknown }
      if (typeof b.query !== 'string' || !b.query.trim() || b.query.length > 500) return { status: 400, body: { ok: false, error: 'query 要是 1–500 字的字符串' } }
      const limit = typeof b.limit === 'number' && Number.isInteger(b.limit) ? b.limit : 3
      const topics = await search(caller?.chatId, b.query, limit)
      const owner = d.ownerChatId()
      // 只有主人当前对话里正在跑的轮,且 HTTP 成功交回后才算采用;file/operator/后台检索不算。
      const key = caller?.sessionKey?.split('/')
      const scopedOwner = caller?.chatId === owner || (caller?.sharedTurn === 'bound' && caller.turnChatId === owner)
      const executor = key?.[0] === 'agy-static' ? 'agy' : key?.[0]
      const alias = key?.[1]
      const turn = owner && caller?.origin === 'session' && scopedOwner && executor
        ? d.db.query<{ id: string }, [string, string, string | null, string | null]>(`SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id
          WHERE m.kind='chat' AND m.owner_chat_id=? AND t.executor=? AND t.status='running'
          AND (? IS NULL OR json_extract(t.policy_json,'$.alias')=?) ORDER BY t.started_at DESC LIMIT 1`).get(owner, executor, alias ?? null, alias ?? null) : null
      if (turn && owner && topics.length && ctx) ctx.onSent(() => {
        try {
          if (d.ownerChatId() !== owner || !d.db.query("SELECT id FROM matter_turns WHERE id=? AND status='running'").get(turn.id)) return
          makeTopicBubbles(d.db).adopt(owner, `${turn.id}:search:${topicRevision([b.query, limit])}`, 'search', topics.map(t => ({ id: t.id, entryIds: t.entries.map(e => e.id) })))
        } catch { /* 泡泡写入失败不能阻塞正常工具响应 */ }
      })
      return { status: 200, body: { ok: true, topics } }
    },
  }
}
