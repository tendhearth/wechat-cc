import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makePledgeStore } from './social-pledge-store'

describe('makePledgeStore', () => {
  it('creates pledges, lists newest-first, gets by id, and records reveal timestamps', () => {
    const db = openDb({ path: ':memory:' })
    const p = makePledgeStore(db)
    p.create({ id: 'i1:cca', intentId: 'i1', seekerAgentId: 'cca', topic: '找摄影搭子' })
    p.create({ id: 'i2:ccd', intentId: 'i2', seekerAgentId: 'ccd', topic: '找球友' })
    expect(p.list().map(r => r.id)).toEqual(['i2:ccd', 'i1:cca'])   // newest first
    const row = p.get('i1:cca')!
    expect(row.intent_id).toBe('i1')
    expect(row.seeker_agent_id).toBe('cca')
    expect(row.self_revealed_at).toBeNull()
    expect(row.peer_revealed_at).toBeNull()
    p.setSelfRevealed('i1:cca', '2026-07-15T00:00:00.000Z')
    p.setPeerRevealed('i1:cca', '2026-07-15T00:01:00.000Z')
    const after = p.get('i1:cca')!
    expect(after.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(after.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(p.get('nope')).toBeNull()
  })
})

/**
 * WHY(2026-09-01,Mac↔Windows 真机闭环第一次真跑就撞上):
 * `UNIQUE constraint failed: social_pledge.id`。
 *
 * 主键刻意是 `${intent_id}:${agent_id}` —— **确定性的,就是为了幂等**。
 * 而信箱传输是 at-least-once:取件之后、ack 之前 daemon 一重启,下次开机
 * 必然重放同一封信。裸 INSERT 于是必抛,而调用方(wire-social 的
 * answerLocally)只是 catch+记一行日志 —— 于是每次重放都留一条「失败」,
 * 看起来像坏了,实际上该发生的都发生过了。
 *
 * DO NOTHING 而不是 DO UPDATE:重放带来的字段和原来完全一样,但
 * self_revealed_at / peer_revealed_at 可能已经写过了 —— UPDATE 会把真实
 * 发生过的揭晓抹回 NULL。
 */
describe('makePledgeStore 幂等性(信箱重放)', () => {
  it('同一个 id 再 create 一次不抛,也不产生第二行', () => {
    const db = openDb({ path: ':memory:' })
    const p = makePledgeStore(db)
    const row = { id: 'i9:ccx', intentId: 'i9', seekerAgentId: 'ccx', topic: '修胶片相机' }
    p.create(row)
    expect(() => p.create(row)).not.toThrow()
    expect(p.list().filter(r => r.id === 'i9:ccx')).toHaveLength(1)
  })

  it('重放不会抹掉已经写下的揭晓时间', () => {
    const db = openDb({ path: ':memory:' })
    const p = makePledgeStore(db)
    const row = { id: 'i9:ccx', intentId: 'i9', seekerAgentId: 'ccx', topic: '修胶片相机' }
    p.create(row)
    p.setSelfRevealed('i9:ccx', '2026-09-01T07:00:00.000Z')
    p.create(row)
    expect(p.get('i9:ccx')!.self_revealed_at).toBe('2026-09-01T07:00:00.000Z')
  })
})
