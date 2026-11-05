import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { consolidateTopics, stripCommitHashes, hasCommitHash, parseConsolidate, sameSubject, topicWordsOf, duplicateFactGroups, similarity, mergedEntry, buildSummary } from './consolidate'

async function setup() {
  const threads = makeThreadsStore(openTestDb())
  const t = await threads.create({ chatId: 'o', title: '1in8b', summary: '历史模拟', facets: ['task'], tags: [], private: false, episodes: [], lastActive: '2026-11-04T00:00:00Z' })
  const ids: string[] = []
  for (const [kind, line, ts] of [
    ['progress', '1in8b 美洲板块上线 (commit b7ca7592),26 国', '2026-11-01T00:00:00Z'],
    ['progress', '1in8b 非洲板块上线 (commit a293d83a)', '2026-11-02T00:00:00Z'],
    ['progress', '1in8b 日韩板块上线 (commit e2aa78ba)', '2026-11-03T00:00:00Z'],
    ['commitment', '答应 11-20 前切到 Stripe 正式密钥', '2026-11-03T00:00:00Z'],
    ['decision', '翻译用 18 种语言', '2026-11-03T00:00:00Z'],
  ] as const) ids.push(await threads.addEntry({ threadId: t, kind, line, ts }))
  return { threads, t, ids }
}

describe('stripCommitHashes', () => {
  it('去掉提交号,版本号 / 日期 / 纯数字编号不动', () => {
    expect(stripCommitHashes('美洲板块上线 (commit b7ca7592),26 国')).toBe('美洲板块上线,26 国')
    expect(stripCommitHashes('科普功能完成 (commit 3897195):待部署')).toBe('科普功能完成:待部署')
    expect(stripCommitHashes('部署观察中 (1599b0b5),CI 全绿')).toBe('部署观察中,CI 全绿')
    expect(stripCommitHashes('合入 master (8953e4bf..831fb23d)')).toBe('合入 master')
    expect(stripCommitHashes('合入 PR #98 (squash 3513628c)')).toBe('合入 PR #98')
    for (const s of ['v0.5.18', '2026-11-04', '订单号 (12345678)', '17 页', 'sing-box 1.13.18']) expect(stripCommitHashes(s)).toBe(s)
    expect(hasCommitHash('x (commit 3897195)')).toBe(true)
    expect(hasCommitHash('v0.5.18')).toBe(false)
  })
})

const E = (id: string, kind: string, line: string, updatedTs: string, body = '') =>
  ({ id, threadId: 't', kind, line, body, due: null, status: 'live', source: 'chat', matterId: null, supersededBy: null, createdTs: updatedTs, updatedTs }) as never

describe('同一件事才并(代码核)', () => {
  const words = topicWordsOf({ title: 'Nategu 银行', aliases: ['Stripe'] })
  it('D-U-N-S / Mercury 两步验证 / 8822-B 不是一件事;Stripe 正式账户一路推进是一件事', () => {
    expect(sameSubject([
      E('a', 'progress', 'D-U-N-S 已分配(Nate Gu & Co LLC),Runbook 更新至 v1.2', '2026-11-01'),
      E('b', 'progress', 'Mercury 账户已开启两步验证', '2026-11-02'),
      E('c', 'progress', '8822-B 签字邮寄等待 Mercury 批准', '2026-11-03'),
    ], words)).toBe(false)
    expect(sameSubject([
      E('a', 'progress', 'Stripe 正式账户开户中:已填业务信息', '2026-11-01'),
      E('b', 'progress', 'Stripe 正式账户已激活:收款打款开启', '2026-11-02'),
    ], words)).toBe(true)
  })
  it('事实:几乎一样才并(代码判)', () => {
    const live = [E('a', 'fact', 'Airwallex 美元账户已获批,尾号 ****', '2026-11-01'), E('b', 'fact', 'Airwallex 美元账户已获批 尾号 ****', '2026-11-02'), E('c', 'fact', 'Airwallex 中国籍只收身份证', '2026-11-02')]
    expect(duplicateFactGroups(live).map(g => g.map((x: { id: string }) => x.id))).toEqual([['a', 'b']])
    expect(similarity('Mercury 申请被拒', 'Mercury 申请已提交')).toBeLessThan(0.8)
  })
  it('并出来的那条:最新那条的原话(去提交号),较旧几条原样折进细节;摘要由代码拼', () => {
    const m = mergedEntry([
      E('a', 'progress', '1in8b 美洲板块上线 (commit b7ca7592)', '2026-11-01'),
      E('b', 'progress', '1in8b 全部 172 国上线 (commit e2aa78ba)', '2026-11-03', '18 种语言'),
      E('c', 'progress', '1in8b 非洲板块上线', '2026-11-02'),
    ])
    expect(m).toMatchObject({ kind: 'progress', line: '1in8b 全部 172 国上线', ts: '2026-11-03' })
    expect(m.body).toBe('18 种语言\n之前:\n- 1in8b 非洲板块上线\n- 1in8b 美洲板块上线')
    expect(buildSummary([E('a', 'progress', '旧进展', '2026-11-01'), E('b', 'conclusion', '新结论 (commit e2aa78ba)', '2026-11-03'), E('c', 'decision', '定了用 Airwallex', '2026-11-02'), E('d', 'commitment', '答应 X', '2026-11-04')]))
      .toBe('新结论;定了用 Airwallex')
    expect(buildSummary([E('d', 'commitment', '答应 X', '2026-11-04')])).toBeNull()
  })
})

describe('parseConsolidate', () => {
  it('只认这批里的 progress、至少两条、一条只用一次、代码核过同一件事', () => {
    const words = topicWordsOf({ title: '1in8b' })
    const p = [E('a', 'progress', '美洲板块上线 26 国', '2026-11-01'), E('b', 'progress', '非洲板块上线 47 国', '2026-11-02'), E('c', 'progress', 'Stripe 正式密钥配好', '2026-11-03'), E('d', 'fact', '板块上线规则', '2026-11-03')]
    const g = parseConsolidate(JSON.stringify({ groups: [['a', 'b'], ['b', 'c'], ['c', 'nope'], ['a'], ['d', 'c']] }), p, words)
    expect(g!.map(x => x.map((e: { id: string }) => e.id))).toEqual([['a', 'b']])
    expect(parseConsolidate(JSON.stringify({ groups: [['a', 'c']] }), p, words)).toEqual([])
    expect(parseConsolidate('garbage', p, words)).toBeNull()
  })
})

describe('consolidateTopics(睡一觉)', () => {
  it('同一件事的进展并成一条:用最新那条原话、旧的标 superseded 不删;不同的事不并;承诺 / 决定不动;摘要代码拼;水位前移', async () => {
    const threads = makeThreadsStore(openTestDb())
    const t = await threads.create({ chatId: 'o', title: '1in8b', summary: '旧摘要', facets: ['task'], tags: [], private: false, episodes: [], lastActive: '2026-11-04T00:00:00Z' })
    const ids: string[] = []
    for (const [kind, line, ts] of [
      ['progress', '美洲板块上线 (commit b7ca7592),26 国', '2026-11-01T00:00:00Z'],
      ['progress', '非洲板块上线 (commit a293d83a)', '2026-11-02T00:00:00Z'],
      ['progress', '日韩板块上线 (commit e2aa78ba)', '2026-11-03T00:00:00Z'],
      ['progress', 'Stripe 正式密钥已配好', '2026-11-03T12:00:00Z'],
      ['commitment', '答应 11-20 前切到 Stripe 正式密钥', '2026-11-03T00:00:00Z'],
      ['decision', '翻译用 18 种语言', '2026-11-03T00:00:00Z'],
    ] as const) ids.push(await threads.addEntry({ threadId: t, kind, line, ts }))
    let prompt = ''
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, now: () => '2026-11-05T04:00:00Z',
      sdkEval: async q => { prompt = q; return JSON.stringify({ groups: [[ids[0], ids[1], ids[2]], [ids[2], ids[3]]] }) } })
    expect(prompt).toContain('只分组,不要改写文字')
    expect(r).toMatchObject({ topics: 1, merged: 3, failed: 0 })
    const live = await threads.entries(t, { live: true })
    const merged = live.find(e => e.kind === 'progress' && e.line.startsWith('日韩'))!
    expect(merged.line).toBe('日韩板块上线')
    expect(merged.body).toBe('之前:\n- 非洲板块上线\n- 美洲板块上线,26 国')
    expect(live.map(e => e.line).sort()).toEqual(['Stripe 正式密钥已配好', '日韩板块上线', '答应 11-20 前切到 Stripe 正式密钥', '翻译用 18 种语言'].sort())
    for (const id of ids.slice(0, 3)) expect(await threads.getEntry(id)).toMatchObject({ status: 'superseded', supersededBy: merged.id })
    expect((await threads.entries(t)).length).toBe(7)
    expect((await threads.get(t))!.summary).toBe('Stripe 正式密钥已配好;翻译用 18 种语言')
    expect((await threads.getExtractState('o')).consolidatedToTs).toBe('2026-11-05T04:00:00Z')
    let calls = 0
    await consolidateTopics({ chatId: 'o', threads, log: () => {}, now: () => '2026-11-06T04:00:00Z', sdkEval: async () => { calls++; return '{"groups":[]}' } })
    expect(calls).toBe(0)
  })

  it('条目少:不叫模型,只按规则去提交号;重复的事实照样并', async () => {
    const threads = makeThreadsStore(openTestDb())
    const t = await threads.create({ chatId: 'o', title: 'melu', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    const e = await threads.addEntry({ threadId: t, kind: 'progress', line: '科普功能完成 (commit 3897195)' })
    await threads.addEntry({ threadId: t, kind: 'fact', line: '事实库 46 条', ts: '2026-11-01T00:00:00Z' })
    await threads.addEntry({ threadId: t, kind: 'fact', line: '事实库 46 条。', ts: '2026-11-02T00:00:00Z' })
    let calls = 0
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, sdkEval: async () => { calls++; return '' } })
    expect(calls).toBe(0)
    expect(r).toMatchObject({ stripped: 1, merged: 2 })
    expect((await threads.getEntry(e))!.line).toBe('科普功能完成')
    expect((await threads.entries(t, { live: true })).filter(x => x.kind === 'fact').length).toBe(1)
  })

  it('模型失败 ⇒ 进展原样、水位不动;空输出重试一次', async () => {
    const threads = makeThreadsStore(openTestDb())
    const t = await threads.create({ chatId: 'o', title: 'x', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    for (const l of ['a 上线', 'b 上线', 'c 上线', 'd 上线']) await threads.addEntry({ threadId: t, kind: 'progress', line: l })
    let calls = 0
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, sdkEval: async () => { calls++; return '' } })
    expect(calls).toBe(2)
    expect(r.failed).toBe(1)
    expect((await threads.entries(t, { live: true })).length).toBe(4)
    expect((await threads.getExtractState('o')).consolidatedToTs).toBeNull()
  })
})
