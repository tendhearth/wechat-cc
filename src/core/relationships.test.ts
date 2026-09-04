import { describe, it, expect } from 'vitest'
import { buildRelationships, type RelationshipInputs } from './relationships'

const base: RelationshipInputs = {
  peers: [{ id: 'cc-b', name: '老王的 bot', transport: 'mailbox', paused: false }],
  channels: [{ id: 'ch1', peer_agent_id: 'cc-b', degree: 1, status: 'open', created_at: '2026-09-01T00:00:00Z' }],
  visitsByChannel: { ch1: { ids: 2, lastAt: '2026-09-03T00:00:00Z', peerReplied: true } },
  neighbors: [{ id: 'ayou', name: '阿柚' }],
  neighborMemory: { lastId: 'ayou', notes: { ayou: { at: '2026-09-02T00:00:00Z', note: '聊了豆子', visits: 3 } } },
  humans: [{ chatId: 'w@im.wechat', name: '小王', visits: 1, lastAt: '2026-09-04T00:00:00Z' }],
}

describe('buildRelationships —— 四种对方,一张表', () => {
  it('四个来源各出一条,id 稳定', () => {
    const r = buildRelationships(base)
    expect(r.map(x => x.id).sort()).toEqual(['anon:ch1', 'human:w@im.wechat', 'neighbor:ayou', 'peer:cc-b'].filter(id => id !== 'anon:ch1'))
  })

  it('有信道且 registry 认识对端 → peer,带名字;对端回过串门 → autoVisit', () => {
    const p = buildRelationships(base).find(x => x.id === 'peer:cc-b')!
    expect(p.kind).toBe('peer'); expect(p.label).toBe('老王的 bot'); expect(p.channel).toBe('ch1')
    expect(p.familiarity.visits).toBe(2); expect(p.autoVisit).toBe(true)
  })

  it('**经介绍人的信道不知道对端 → anon,标「第 N 度的某人」,永远不露 id**', () => {
    const r = buildRelationships({ ...base, channels: [{ id: 'ch2', peer_agent_id: null, degree: 2, status: 'open', created_at: '' }], visitsByChannel: {} })
    const a = r.find(x => x.kind === 'anon')!
    expect(a.id).toBe('anon:ch2'); expect(a.label).toBe('第 2 度的某人'); expect(a.autoVisit).toBe(false)
  })

  it('registry 有、没开信道 → peer 但 channel=null,说明还去不了', () => {
    const r = buildRelationships({ ...base, channels: [], visitsByChannel: {} })
    const p = r.find(x => x.id === 'peer:cc-b')!
    expect(p.channel).toBeNull()
    // 只说「还没开信道」等于把死胡同摆给主人:2026-09-04 起配对即开信道,
    // 这一类只剩历史遗留行,顺手告诉他怎么修。
    expect(p.origin).toBe('配对(还没开信道 · 重新配对一次即可)')
  })

  it('邻居永远 autoVisit,带上次的笔记和次数', () => {
    const n = buildRelationships(base).find(x => x.kind === 'neighbor')!
    expect(n.autoVisit).toBe(true); expect(n.familiarity.visits).toBe(3); expect(n.familiarity.note).toBe('聊了豆子')
  })

  it('人类朋友没名字时给个能读的说法', () => {
    const r = buildRelationships({ ...base, humans: [{ chatId: 'o9cq800sObd3@im.wechat', name: null, visits: 0, lastAt: null }] })
    expect(r.find(x => x.kind === 'human')!.label).toBe('「o9cq80…」那位')
  })

  it('最近有往来的在前', () => {
    expect(buildRelationships(base)[0]!.id).toBe('human:w@im.wechat') // 9/4 最近
  })

  it('同一对端两条 open 信道(重新配对留下的)→ 只出一条,认最新的那条', () => {
    const r = buildRelationships({
      ...base,
      channels: [
        { id: 'ch-old', peer_agent_id: 'cc-b', degree: 1, status: 'open', created_at: '2026-09-01T00:00:00Z' },
        { id: 'ch-new', peer_agent_id: 'cc-b', degree: 1, status: 'open', created_at: '2026-09-04T00:00:00Z' },
      ],
      visitsByChannel: {},
    })
    expect(r.filter(x => x.id === 'peer:cc-b')).toHaveLength(1)
    expect(r.find(x => x.id === 'peer:cc-b')!.channel).toBe('ch-new')   // 「串门」去的就是这条
  })

  it('关闭的信道不算', () => {
    const r = buildRelationships({ ...base, channels: [{ ...base.channels[0]!, status: 'pending' }] })
    expect(r.find(x => x.id === 'peer:cc-b')!.channel).toBeNull()
  })
})
