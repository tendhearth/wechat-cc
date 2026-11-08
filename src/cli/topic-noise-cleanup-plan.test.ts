import { describe, expect, it } from 'vitest'
import { openTestDb } from '../lib/db'
import { makeThreadsStore } from '../lib/threads-store'
import { planTopicNoiseCleanup, applyTopicNoiseCleanup } from './topic-noise-cleanup-plan'

async function seed() {
  const db = openTestDb(), threads = makeThreadsStore(db)
  const id = await threads.create({ chatId: 'owner', title: 'wechat-cc', description: '个人 AI 项目', summary: '个人 AI 项目。现状:Codex升至0.167.0自检过', facets: ['task'], tags: [], private: false, episodes: [] })
  const noise = await threads.addEntry({ threadId: id, kind: 'progress', line: 'Codex升至0.167.0自检过', ts: '2026-11-08T10:00:00Z', source: 'work' })
  const demo = await threads.addEntry({ threadId: id, kind: 'progress', line: 'CC桌宠录制完成43秒9核心动作演示', ts: '2026-11-08T09:00:00Z' })
  const promise = await threads.addEntry({ threadId: id, kind: 'commitment', line: '答应周五补 self deploy 验收' })
  const foreign = await threads.create({ chatId: 'foreign', title: 'cc', summary: '', facets: [], tags: [], private: false, episodes: [] })
  const foreignNoise = await threads.addEntry({ threadId: foreign, kind: 'progress', line: 'Codex升至0.167.0自检过' })
  return { db, threads, id, noise, demo, promise, foreignNoise }
}

describe('one-shot topic noise cleanup', () => {
  it('plans without writes; existing wrong semantics and exact rollback preserve all other records', async () => {
    const s = await seed()
    try {
      const before = s.db.query('SELECT * FROM topic_entries ORDER BY id').all()
      const topicBefore = await s.threads.get(s.id)
      const plan = planTopicNoiseCleanup(s.db, 'owner', '2026-11-08T12:00:00Z')
      expect(s.db.query('SELECT * FROM topic_entries ORDER BY id').all()).toEqual(before)
      expect(plan.topics).toHaveLength(1)
      expect(applyTopicNoiseCleanup(s.db, plan)).toBe(1)
      expect(await s.threads.getEntry(s.noise)).toMatchObject({ status: 'superseded', supersededBy: null })
      for (const id of [s.demo, s.promise, s.foreignNoise]) expect((await s.threads.getEntry(id))?.status).toBe('live')
      expect((await s.threads.get(s.id))?.summary).toContain('43秒9核心动作演示')
      expect((await s.threads.get(s.id))?.summary).not.toContain('0.167.0')
      expect(planTopicNoiseCleanup(s.db, 'owner').topics).toHaveLength(0)
      expect(applyTopicNoiseCleanup(s.db, plan, true)).toBe(1)
      expect(s.db.query('SELECT * FROM topic_entries ORDER BY id').all()).toEqual(before)
      expect(await s.threads.get(s.id)).toEqual(topicBefore)
    } finally { s.db.close() }
  })
  it('stale retained entries or later corrections reject the whole transaction', async () => {
    const s = await seed()
    try {
      const stale = planTopicNoiseCleanup(s.db, 'owner')
      await s.threads.updateEntry(s.demo, { line: '录制后发现仍需补权限镜头' })
      expect(() => applyTopicNoiseCleanup(s.db, stale)).toThrow(/changed/)
      expect((await s.threads.getEntry(s.noise))?.status).toBe('live')
      const plan = planTopicNoiseCleanup(s.db, 'owner')
      applyTopicNoiseCleanup(s.db, plan)
      await s.threads.updateEntry(s.noise, { body: '主人后来纠正过' })
      expect(() => applyTopicNoiseCleanup(s.db, plan, true)).toThrow(/changed/)
      expect((await s.threads.getEntry(s.noise))?.status).toBe('superseded')
    } finally { s.db.close() }
  })
  it('only noise left: summary falls back to description; prior supersession chain is untouched', async () => {
    const s = await seed()
    try {
      await s.threads.updateEntry(s.demo, { status: 'done' })
      const old = await s.threads.addEntry({ threadId: s.id, kind: 'progress', line: 'Codex升至0.166.0自检过' })
      await s.threads.updateEntry(old, { status: 'superseded', supersededBy: s.noise })
      const before = await s.threads.getEntry(old)
      applyTopicNoiseCleanup(s.db, planTopicNoiseCleanup(s.db, 'owner'))
      expect((await s.threads.get(s.id))?.summary).toBe('个人 AI 项目')
      expect(await s.threads.getEntry(old)).toEqual(before)
    } finally { s.db.close() }
  })
  it('database write failure rolls back every candidate and summary atomically', async () => {
    const s = await seed()
    try {
      const second = await s.threads.addEntry({ threadId: s.id, kind: 'progress', line: 'CC 数据库迁移至 v109' })
      const before = s.db.query('SELECT * FROM topic_entries ORDER BY id').all()
      const topicBefore = await s.threads.get(s.id)
      s.db.query(`CREATE TRIGGER fail_cleanup BEFORE UPDATE ON topic_entries WHEN NEW.id='${second}' BEGIN SELECT RAISE(ABORT,'injected_failure'); END`).run()
      expect(() => applyTopicNoiseCleanup(s.db, planTopicNoiseCleanup(s.db, 'owner'))).toThrow('injected_failure')
      expect(s.db.query('SELECT * FROM topic_entries ORDER BY id').all()).toEqual(before)
      expect(await s.threads.get(s.id)).toEqual(topicBefore)
    } finally { s.db.close() }
  })
})
