import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from './db'
import { makeThreadsStore } from './threads-store'
import { makeTopicBubbles } from './topic-bubbles'

async function setup() {
  const db = openTestDb(), threads = makeThreadsStore(db), bubbles = makeTopicBubbles(db)
  const id = await threads.create({ chatId: 'owner', title: '服务器', summary: '', facets: [], tags: [], private: true, episodes: [] })
  return { db, threads, bubbles, id }
}
describe('T4 bubble storage', () => {
  it('历史默认 closed;引用只收真实 live 条目;同轮重试不能在睡后重开', async () => {
    const { db, threads, bubbles, id } = await setup()
    expect(bubbles.get(id)).toBeNull()
    const e = await threads.addEntry({ threadId: id, kind: 'decision', line: '每天备份' })
    bubbles.adopt('owner', 'r1', 'recall', [{ id, entryIds: [e, 'unknown'] }])
    expect(bubbles.get(id)?.state).toBe('open')
    expect(db.query('SELECT entry_ids FROM topic_recall_refs').get()).toEqual({ entry_ids: JSON.stringify([e]) })
    const sleep = bubbles.beginSleep('owner', 'sleep1')
    expect(bubbles.closeAfterSleep(sleep)).toBe(1)
    expect(bubbles.closeAfterSleep(sleep)).toBe(0)
    expect(bubbles.adopt('owner', 'r1', 'recall', [{ id }])).toBe(false)
    expect(bubbles.get(id)?.state).toBe('closed')
    expect(bubbles.adopt('guest', 'r2', 'owner', [{ id }])).toBe(false)
    db.query('DELETE FROM threads WHERE id=?').run(id)
    expect(db.query('SELECT * FROM topic_recall_refs').all()).toEqual([])
    expect(bubbles.get(id)).toBeNull()
    db.close()
  })
  it('睡眠期间主人再打开会改变 revision;旧快照不关;失败不调用 close', async () => {
    const { db, bubbles, id } = await setup()
    bubbles.adopt('owner', 'r1', 'owner', [{ id }])
    const sleep = bubbles.beginSleep('owner', 'sleep')
    bubbles.adopt('owner', 'r2', 'owner', [{ id }])
    expect(bubbles.closeAfterSleep(sleep)).toBe(0)
    expect(bubbles.get(id)?.state).toBe('open')
    db.close()
  })
  it('主人可见事项 running/waiting 保留;act、他人、临时、归档不保留;结束留到下一觉', async () => {
    const { db, bubbles, id } = await setup()
    const add = (mid: string, kind: string, owner: string, path: string | null, archived: number | null = null) => {
      db.query("INSERT INTO matters(id,kind,title,owner_chat_id,project_path,state,archived_at,created_at,updated_at) VALUES(?,?,'test',?,?,'working',?,1,1)").run(mid, kind, owner, path, archived)
      db.query('INSERT INTO matter_topics VALUES(?,?,?,0)').run(mid, id, '2026-11-06T00:00:00Z')
    }
    add('act', 'act', 'owner', null)
    add('guest', 'task', 'guest', null)
    add('temp', 'task', 'owner', join(tmpdir(), 'wechat-cc-selftest', 'project'))
    add('archived', 'task', 'owner', null, 1)
    bubbles.adopt('owner', 'r1', 'recall', [{ id }])
    expect(bubbles.closeAfterSleep(bubbles.beginSleep('owner', 's1'))).toBe(1)
    add('real', 'task', 'owner', null)
    bubbles.matterChanged('real')
    expect(bubbles.get(id)?.state).toBe('open')
    expect(bubbles.closeAfterSleep(bubbles.beginSleep('owner', 's2'))).toBe(0)
    db.query("UPDATE matters SET state='waiting' WHERE id='real'").run()
    expect(bubbles.closeAfterSleep(bubbles.beginSleep('owner', 's3'))).toBe(0)
    db.query("UPDATE matters SET state='done' WHERE id='real'").run()
    bubbles.matterChanged('real')
    expect(bubbles.get(id)?.state).toBe('open')
    expect(bubbles.closeAfterSleep(bubbles.beginSleep('owner', 's4'))).toBe(1)
    db.close()
  })
})
