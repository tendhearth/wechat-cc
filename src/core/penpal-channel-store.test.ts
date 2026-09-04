import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeChannelStore, primaryChannels } from './penpal-channel-store'

describe('makeChannelStore', () => {
  it('creates a pending channel, looks it up by id + my_channel_id, opens it on peer handle', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeChannelStore(db)
    s.create({ id: 'i1:ccb', seekId: 'i1', myPrivkey: 'PRIV', myPubkey: 'PUB', myChannelId: 'chan-A', degree: 1, peerAgentId: 'ccb' })
    const row = s.get('i1:ccb')!
    expect(row.status).toBe('pending')
    expect(row.peer_pubkey).toBeNull()
    expect(row.my_channel_id).toBe('chan-A')
    expect(s.getByMyChannelId('chan-A')!.id).toBe('i1:ccb')

    s.setPeerHandle('i1:ccb', { pubkey: 'PEERPUB', channel_id: 'chan-B' })
    // 2026-08-30:存 handle 与开通道已拆开 —— 对端先揭晓时 handle 要落盘,
    // 但在我同意之前通道不能是 open(信箱面按 open 过滤)。
    s.setStatus('i1:ccb', 'open')
    const opened = s.get('i1:ccb')!
    expect(opened.status).toBe('open')
    expect(opened.peer_pubkey).toBe('PEERPUB')
    expect(opened.peer_channel_id).toBe('chan-B')
  })

  it('getByMyChannelId returns null for an unknown address', () => {
    const s = makeChannelStore(openDb({ path: ':memory:' }))
    expect(s.getByMyChannelId('nope')).toBeNull()
  })
})

describe('primaryChannels —— 一个对方只留最新的一条 open 信道', () => {
  const row = (id: string, peer: string | null, created: string, status = 'open') =>
    ({ id, peer_agent_id: peer, created_at: created, status })

  it('同一个 peer 的多条 open 行 → 只留 created_at 最新的那条', () => {
    const rows = [row('pair:new', 'cc-b', '2026-09-04T00:00:00Z'), row('pair:old', 'cc-b', '2026-09-01T00:00:00Z')]
    expect(primaryChannels(rows).map(r => r.id)).toEqual(['pair:new'])
  })

  it('不管输入什么顺序,留下的都是最新那条;输入顺序本身保持不变', () => {
    const rows = [row('pair:old', 'cc-b', '2026-09-01T00:00:00Z'), row('a', null, '2026-09-02T00:00:00Z'), row('pair:new', 'cc-b', '2026-09-04T00:00:00Z')]
    expect(primaryChannels(rows).map(r => r.id)).toEqual(['a', 'pair:new'])
  })

  it('pending / 关掉的行不算,哪怕它更新', () => {
    const rows = [row('pair:pending', 'cc-b', '2026-09-09T00:00:00Z', 'pending'), row('pair:open', 'cc-b', '2026-09-01T00:00:00Z')]
    expect(primaryChannels(rows).map(r => r.id)).toEqual(['pair:open'])
  })

  it('peer_agent_id 为空的匿名信道全留 —— 它们不是「同一个人」', () => {
    const rows = [row('anon1', null, '2026-09-01T00:00:00Z'), row('anon2', null, '2026-09-02T00:00:00Z')]
    expect(primaryChannels(rows).map(r => r.id)).toEqual(['anon1', 'anon2'])
  })

  it('created_at 相同 → 留先出现的那条(store 的 list() 是 created_at DESC,先出现的就是新的)', () => {
    const rows = [row('first', 'cc-b', ''), row('second', 'cc-b', '')]
    expect(primaryChannels(rows).map(r => r.id)).toEqual(['first'])
  })

  it('真的 store 出来的行也吃得下(ChannelRow 全字段)', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeChannelStore(db)
    for (const id of ['pair:a', 'pair:b']) {
      s.create({ id, seekId: id, myPrivkey: 'P', myPubkey: 'p', myChannelId: `c-${id}`, degree: 1, peerAgentId: 'cc-b' })
      s.setStatus(id, 'open')
    }
    expect(primaryChannels(s.list())).toHaveLength(1)
  })
})
