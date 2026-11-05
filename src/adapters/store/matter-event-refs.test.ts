import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMatterEventRefs } from './matter-event-refs'

describe('matter-event-refs(S3a):同一个事件从 matter_turns 读出同一个键', () => {
  const seeded = () => {
    const db = openTestDb()
    db.exec(`INSERT INTO matters(id,kind,title,state,created_at,updated_at,cursor) VALUES('m1','task','t','open',1,1,0);
      INSERT INTO matter_turns(id,matter_id,seq,run_id,executor,status,started_at,cursor) VALUES
        ('t1','m1',1,'run-a','codex','completed',100,1),
        ('t2','m1',2,'run-a','codex','completed',200,2),
        ('t3','m1',3,'run-b','codex','running',300,3);`)
    return db
  }
  it('最新那一轮 / 某个 run 的最后一轮', () => {
    const db = seeded()
    try {
      const r = makeMatterEventRefs(db)
      expect(r.latestTurn('m1')).toBe('turn:m1:3')
      expect(r.lastTurnOfRun('m1', 'run-a')).toBe('turn:m1:2')
    } finally { db.close() }
  })
  it('读不到 ⇒ null(调用方就不带键)', () => {
    const db = seeded()
    try {
      const r = makeMatterEventRefs(db)
      expect(r.latestTurn('nope')).toBeNull()
      expect(r.lastTurnOfRun('m1', 'run-z')).toBeNull()
      db.close()
      expect(r.latestTurn('m1')).toBeNull()
    } finally { try { db.close() } catch { /* 已关 */ } }
  })
})
