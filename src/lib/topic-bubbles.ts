import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Db } from './db'
import { hintWrite } from './write-hints'

export interface BubbleRow {
  thread_id: string; state: 'open' | 'closed'; opened_at: string | null
  last_recalled_at: string | null; last_opened_by_owner_at: string | null
  activity_revision: number; closed_sleep_id: string | null
}
export interface TopicMatter { id: string; title: string; state: string; archived_at: number | null; kind: string; project_path: string | null; owner_chat_id: string | null }

/** 临时目录里的实验 / 自检不是主人事项。看结构化来源,不按标题猜。 */
export function temporary(path: string | null): boolean {
  if (!path) return false
  return [tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].some(root => {
    const canonical = (s: string) => resolve(s).replace(/^\/private\/(tmp|var)(?=\/|$)/, '/$1')
    const rel = relative(canonical(root), canonical(path))
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
}
export function topicMatters(db: Db, owner: string, id: string, includeActs=false): TopicMatter[] {
  return db.query<TopicMatter, [string, string]>(`SELECT m.id,m.title,m.state,m.archived_at,m.kind,m.project_path,m.owner_chat_id
    FROM matters m JOIN matter_topics l ON l.matter_id=m.id WHERE l.thread_id=? AND m.owner_chat_id=? AND ${includeActs?"m.kind IN ('task','terminal','act')":"m.kind!='act'"} ORDER BY m.id`).all(id, owner)
    .filter(m => !temporary(m.project_path))
}
export const blocksBubble = (m: TopicMatter) => m.archived_at === null && (m.state === 'working' || m.state === 'waiting')

export function makeTopicBubbles(db: Db) {
  const owned = (owner: string, id: string) => !!db.query('SELECT id FROM threads WHERE id=? AND chat_id=?').get(id, owner)
  const row = (id: string) => db.query<BubbleRow, [string]>('SELECT * FROM topic_bubbles WHERE thread_id=?').get(id)
  const openOne = (id: string, at: string, column?: 'last_recalled_at' | 'last_opened_by_owner_at') => {
    db.query(`INSERT INTO topic_bubbles(thread_id,state,opened_at,activity_revision${column ? `,${column}` : ''}) VALUES(?,'open',?,1${column ? ',?' : ''})
      ON CONFLICT(thread_id) DO UPDATE SET state='open',opened_at=CASE WHEN state='closed' THEN excluded.opened_at ELSE opened_at END,
      activity_revision=activity_revision+1${column ? `,${column}=excluded.${column}` : ''}`).run(id, at, ...(column ? [at] : []))
  }
  return {
    get: row,
    /** 稳定 request 收据不删除:旧轮重试不能在下一觉之后重新打开。引用只保留每话题最近 8 轮。 */
    adopt(owner: string, requestId: string, kind: 'recall' | 'search' | 'owner', refs: Array<{ id: string; entryIds?: string[]; messageIds?: string[] }>, at = new Date().toISOString()) {
      return db.transaction(() => {
        if (!refs.length || refs.some(r => !owned(owner, r.id))) return false
        const inserted = db.query('INSERT OR IGNORE INTO topic_bubble_requests VALUES(?,?,?,?)').run(owner, requestId, kind, at)
        if (!inserted.changes) return false
        for (const ref of refs) {
          openOne(ref.id, at, kind === 'owner' ? 'last_opened_by_owner_at' : 'last_recalled_at')
          if (kind !== 'owner') {
            const entries = (ref.entryIds ?? []).filter(id => !!db.query("SELECT id FROM topic_entries WHERE id=? AND thread_id=? AND status='live'").get(id, ref.id)).slice(0, 6)
            // App 的消息在回合结束后持久化;这里只存内部给的稳定 id,展示仍 JOIN 主人 chat。
            const messages = [...new Set(ref.messageIds ?? [])].slice(0, 8)
            db.query('INSERT OR IGNORE INTO topic_recall_refs VALUES(?,?,?,?,?,?)').run(owner, requestId, ref.id, JSON.stringify(entries), JSON.stringify(messages), at)
            db.query('DELETE FROM topic_recall_refs WHERE thread_id=? AND rowid NOT IN (SELECT rowid FROM topic_recall_refs WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 8)').run(ref.id, ref.id)
          }
        }
        hintWrite(db, { kind: 'topics', chatId: owner, mapping:false })
        return true
      })()
    },
    beginSleep(owner: string, sleepId: string) {
      return { owner, sleepId, candidates: db.query<{ thread_id: string; activity_revision: number }, [string]>(`SELECT b.thread_id,b.activity_revision FROM topic_bubbles b JOIN threads t ON t.id=b.thread_id WHERE t.chat_id=? AND b.state='open'`).all(owner) }
    },
    closeAfterSleep(snapshot: { owner: string; sleepId: string; candidates: Array<{ thread_id: string; activity_revision: number }> }, blocked: ReadonlySet<string> = new Set()) {
      return db.transaction(() => {
        let closed = 0
        for (const c of snapshot.candidates) {
          if (blocked.has(c.thread_id) || !owned(snapshot.owner, c.thread_id) || topicMatters(db, snapshot.owner, c.thread_id).some(blocksBubble)) continue
          closed += db.query("UPDATE topic_bubbles SET state='closed',closed_sleep_id=? WHERE thread_id=? AND activity_revision=? AND state='open' AND closed_sleep_id IS NOT ? RETURNING thread_id")
            .all(snapshot.sleepId, c.thread_id, c.activity_revision, snapshot.sleepId).length
        }
        if (closed) hintWrite(db, { kind: 'topics', chatId: snapshot.owner, mapping:false })
        return closed
      })()
    },
    /** 在事项状态写口同步调用;和睡眠收起同一 SQLite 串行边界。 */
    matterChanged(matterId: string, activity = true) {
      // 旧迁移也复用 MatterLog 搬历史轮;v106 以前没有泡泡。
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='topic_bubbles'").get()) return
      const links = db.query<{ id: string; chat_id: string }, [string]>('SELECT t.id,t.chat_id FROM threads t JOIN matter_topics l ON l.thread_id=t.id WHERE l.matter_id=?').all(matterId)
      for (const l of links) {
        const matter = topicMatters(db, l.chat_id, l.id).find(m => m.id === matterId)
        const bubble = row(l.id)
        if (matter && blocksBubble(matter) && (activity || bubble?.state !== 'open')) openOne(l.id, new Date().toISOString())
        else if (matter && activity && bubble?.state === 'open') {
          // 睡眠期间刚收工也要先留结论到下一觉;心跳不算新的活动。
          db.query('UPDATE topic_bubbles SET activity_revision=activity_revision+1 WHERE thread_id=?').run(l.id)
        }
        hintWrite(db, { kind: 'topics', chatId: l.chat_id, mapping:false,topicId:l.id })
      }
    },
  }
}

/** 稳定、owner 范围的内容版本:包含详情,无当前时间,重启后可继续比较。 */
export function topicRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
