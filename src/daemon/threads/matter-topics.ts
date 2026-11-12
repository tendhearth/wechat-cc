/**
 * 一件事挂话题(话题 T3,设计稿 docs/superpowers/specs/2026-11-05-topics-t1-t3-design.md §T3)。
 *
 *  - brief:派活时从话题生成简报交给执行者(工作台任务 / delegate)。只用索引、不叫模型;私密的话题永远不进。
 *  - writeBack:一轮做完,把结论写回挂着的话题(一条 conclusion,matter_id 指回),推进 written_back_cursor。
 *  - delegate 那一路没有 matter:writeDelegate 直接给碰到的话题记一条。
 * 只给主人自己的对话做;一切失败只记一行,不影响派活 / 收尾。
 */
import { localTopicContext, topicMatterAccess } from '../../lib/topic-provenance'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import type { Db } from '../../lib/db'
import type { ThreadsStore } from '../../lib/threads-store'
import { loadMatchTopics, resolveTopicRecall } from './recall'
import { readMatterConclusion } from './work-results'

export const BRIEF_HEAD = 'CC 记得的相关背景(来自和主人聊过的话题与以前做过的活,可能过时;和任务要求冲突时以任务为准):'
const LINE_MAX = 60
const BODY_MAX = 600

export interface MatterTopicsDeps {
  db: Db
  threads: ThreadsStore
  /** 主人的对话(现问);没配 ⇒ 什么都不做。 */
  ownerChatId: () => string | null
  log: (tag: string, line: string) => void
  now?: () => Date
}

export interface Brief { text: string; topicIds: string[] }

function firstLine(s: string, max: number): string {
  const l = (s.split('\n').map(x => x.trim()).find(x => x.length > 0) ?? '').replace(/\s+/g, ' ')
  return [...l].length > max ? [...l].slice(0, max).join('') + '…' : l
}

export function makeMatterTopics(d: MatterTopicsDeps) {
  const now = () => (d.now ? d.now() : new Date()).toISOString()

  /** 主人的对话里、不私密的话题里,和这段文字碰得上的(只用索引)。 */
  async function match(chatId: string | null | undefined, text: string): Promise<Brief | null> {
    const owner = d.ownerChatId()
    if (!owner || chatId !== owner || !text.trim()) return null
    const all = await d.threads.list(owner)
    const open = new Set(all.filter(t => !t.private).map(t => t.id))
    const topics = (await loadMatchTopics(d.threads, owner)).filter(t => open.has(t.id))
    // 只用索引、不叫模型;简报只带索引行,不带细节(细节里常有账号、地址,执行者用不着)
    const r = await resolveTopicRecall(text, topics, { cheapEval: null, bodies: false })
    if (d.ownerChatId() !== owner || d.threads.contextAllowed?.(owner, topics, topics.flatMap(t=>t.entries.map(e=>e.id))) === false) return null
    return r ? { text: `${BRIEF_HEAD}\n${r.block}`, topicIds: r.topicIds } : null
  }

  return {
    /** 工作台任务起执行者那一刻:有简报就记一行 matter_topics(结论从这件事此刻已有的条目之后算起)。 */
    async briefForMatter(m: { matterId: string; ownerChatId: string | null; title: string; text: string }): Promise<string | null> {
      try {
        const b = await match(m.ownerChatId, `${m.title}\n${m.text}`)
        if (!b) return null
        const top = d.db.query<{ c: number | null }, [string]>('SELECT MAX(cursor) AS c FROM matter_items WHERE matter_id = ?').get(m.matterId)?.c ?? 0
        const ts = now()
        for (const id of b.topicIds) {
          d.db.query('INSERT INTO matter_topics(matter_id, thread_id, attached_ts, written_back_cursor) VALUES (?, ?, ?, ?) ON CONFLICT(matter_id, thread_id) DO NOTHING')
            .run(m.matterId, id, ts, top)
        }
        makeTopicBubbles(d.db).matterChanged(m.matterId)
        d.log('TOPICS', `brief matter=${m.matterId} topics=${b.topicIds.join(',')} chars=${b.text.length}`)
        return b.text
      } catch (err) {
        d.log('TOPICS', `brief failed for ${m.matterId}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    /** 一轮真的做完了:把结论写回这件事挂着的每个话题。返回写了几条。 */
    async writeBack(matterId: string): Promise<number> {
      try {
        const owner = d.ownerChatId()
        if (!owner) return 0
        const links = d.db.query<{ thread_id: string; written_back_cursor: number }, [string]>(
          'SELECT thread_id, written_back_cursor FROM matter_topics WHERE matter_id = ?',
        ).all(matterId)
        if (links.length === 0) return 0
        let n = 0
        for (const l of links) {
          const c = readMatterConclusion(d.db, matterId, l.written_back_cursor, localTopicContext(owner))
          if (!c) continue
          const target = await d.threads.get(l.thread_id)
          if (!target || target.chatId !== owner || d.ownerChatId() !== owner || !d.db.query('SELECT id FROM threads WHERE id=? AND chat_id=?').get(l.thread_id,owner) || !topicMatterAccess(d.db, localTopicContext(owner), [matterId]).entryAllowed.has(matterId)) continue
          await d.threads.addEntry({ threadId: l.thread_id, kind: 'conclusion', line: firstLine(`${c.title}:${firstLine(c.result, LINE_MAX)}`, LINE_MAX + 20),
            body: c.result.slice(0, BODY_MAX),workCursor:c.cursor, source: 'work', matterId, ts: c.at })
          d.db.query('UPDATE matter_topics SET written_back_cursor = MAX(written_back_cursor, ?) WHERE matter_id = ? AND thread_id = ?').run(c.cursor, matterId, l.thread_id)
          const t = await d.threads.get(l.thread_id)
          if (t && c.at > t.lastActive) await d.threads.update(l.thread_id, { lastActive: c.at })
          n++
        }
        if (n > 0) d.log('TOPICS', `write-back matter=${matterId} entries=${n}`)
        return n
      } catch (err) {
        d.log('TOPICS', `write-back failed for ${matterId}: ${err instanceof Error ? err.message : String(err)}`)
        return 0
      }
    },

    /** delegate:只有主人自己的会话发起的才给简报。 */
    async briefForDelegate(callerChatId: string | undefined, prompt: string): Promise<Brief | null> {
      try { return await match(callerChatId, prompt) } catch (err) {
        d.log('TOPICS', `delegate brief failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    /** delegate 回答成功:给碰到的话题各记一条。 */
    async writeDelegate(topicIds: readonly string[], peer: string, prompt: string, response: string): Promise<void> {
      try {
        for (const id of topicIds) {
          await d.threads.addEntry({ threadId: id, kind: 'conclusion', line: `问 ${peer}:${firstLine(prompt, LINE_MAX)}`, body: response.trim().slice(0, BODY_MAX), source: 'delegate' })
        }
      } catch (err) {
        d.log('TOPICS', `delegate write-back failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export type MatterTopics = ReturnType<typeof makeMatterTopics>
