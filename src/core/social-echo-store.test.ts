import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeEchoStore } from './social-echo-store'

describe('makeEchoStore', () => {
  it('creates pending echoes, lists by seek + all, and updates status', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我认识个老师傅', peerAgentId: 'ccb' })
    e.create({ id: 'e2', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: '我家布偶生了一窝', peerAgentId: 'ccc' })
    expect(e.get('e1')!.status).toBe('pending')
    expect(e.get('e1')!.peer_agent_id).toBe('ccb')
    expect(e.get('e1')!.self_revealed_at).toBeNull()
    expect(e.get('e1')!.peer_revealed_at).toBeNull()
    expect(e.listForSeek('k1').map(r => r.id).sort()).toEqual(['e1', 'e2'])
    e.setStatus('e1', 'revealed')
    expect(e.get('e1')!.status).toBe('revealed')
    expect(e.listAll().length).toBe(2)
  })

  it('records the two reveal timestamps + swaps the masked name for the real identity', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    e.create({ id: 'e1', seekId: 'k1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    e.setSelfRevealed('e1', '2026-07-15T00:00:00.000Z')
    e.setPeerRevealed('e1', '2026-07-15T00:01:00.000Z')
    e.setRevealedIdentity('e1', '小B')
    const r = e.get('e1')!
    expect(r.self_revealed_at).toBe('2026-07-15T00:00:00.000Z')
    expect(r.peer_revealed_at).toBe('2026-07-15T00:01:00.000Z')
    expect(r.peer_masked).toBe('小B')
  })

  it('creates a relay (degree-2) echo with a null peer + relay_via/relay_token, gettable by relay id', () => {
    const db = openDb({ path: ':memory:' })
    const e = makeEchoStore(db)
    // Relay echo id is intent_id:relay_via:relay_token; peer_agent_id is null.
    e.create({ id: 'i1:ccw:tok', seekId: 'i1', peerMasked: '第 2 度的某人', degree: 2, content: '经W转发的回声', peerAgentId: null, relayVia: 'ccw', relayToken: 'tok' })
    const r = e.get('i1:ccw:tok')!
    expect(r.peer_agent_id).toBeNull()
    expect(r.relay_via).toBe('ccw')
    expect(r.relay_token).toBe('tok')
    expect(r.degree).toBe(2)
    // A direct echo still stores relay_* as null.
    e.create({ id: 'i1:ccb', seekId: 'i1', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })
    const d = e.get('i1:ccb')!
    expect(d.peer_agent_id).toBe('ccb')
    expect(d.relay_via).toBeNull()
    expect(d.relay_token).toBeNull()
  })
})

/**
 * 与 social-pledge-store 同一个洞(2026-09-01 真机闭环发现,先在 pledge 上炸的)。
 * echo 的主键同样是确定性的(`intent:peerAgent` 或 `intent:relayVia:relayToken`),
 * 而 wire-social.ts:561 的注释白纸黑字写着「(possibly-duplicate) insert below」
 * —— 作者知道会重复,却让裸 INSERT 抛进 catch,于是每次信箱重放都留一条
 * 假的「echo record failed」。DO NOTHING(不是 DO UPDATE):status /
 * self_revealed_at / peer_revealed_at / peer_masked 都可能已经被更新过。
 */
describe('makeEchoStore 幂等性(信箱重放)', () => {
  it('同一个 id 再 create 一次不抛,不产生第二行,也不回卷已有状态', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeEchoStore(db)
    const row = { id: 'i9:ccx', seekId: 'i9', peerMasked: '一位朋友', degree: 1, content: '我认识一个', peerAgentId: 'ccx', relayVia: null, relayToken: null }
    s.create(row)
    s.setStatus('i9:ccx', 'revealed')
    s.setRevealedIdentity('i9:ccx', '老张')
    expect(() => s.create(row)).not.toThrow()
    expect(s.listForSeek('i9')).toHaveLength(1)
    const after = s.get('i9:ccx')!
    expect(after.status).toBe('revealed')
    expect(after.peer_masked).toBe('老张')
  })
})
