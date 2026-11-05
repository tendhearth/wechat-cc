import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { consolidateTopics, stripCommitHashes, hasCommitHash, parseConsolidate } from './consolidate'

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

describe('parseConsolidate', () => {
  it('只认这一批里、能并的种类、至少两条、一条只用一次', async () => {
    const { threads, t, ids } = await setup()
    const live = await threads.entries(t, { live: true })
    const p = parseConsolidate(JSON.stringify({ merge: [
      { ids: [ids[0], ids[1]], kind: 'progress', line: 'ok' },
      { ids: [ids[1], ids[2]], kind: 'progress', line: '重复用 id' },
      { ids: [ids[2], ids[3]], kind: 'progress', line: '带承诺' },
      { ids: [ids[2], 'ent_nope'], kind: 'progress', line: '编的 id' },
      { ids: [ids[2]], kind: 'progress', line: '只有一条' },
    ], summary: ' 现状 ' }), live)
    expect(p).toEqual({ merge: [{ ids: [ids[0], ids[1]], kind: 'progress', line: 'ok' }], summary: '现状' })
    expect(parseConsolidate('garbage', live)).toBeNull()
  })
})

describe('consolidateTopics(睡一觉)', () => {
  it('重复的进展并成一条;旧的标 superseded 指向新的、不删;承诺 / 决定不动;提交号去掉;水位前移', async () => {
    const { threads, t, ids } = await setup()
    let prompt = ''
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, now: () => '2026-11-05T04:00:00Z',
      sdkEval: async p => { prompt = p; return JSON.stringify({ merge: [{ ids: ids.slice(0, 3), kind: 'progress', line: '1in8b 美洲 / 非洲 / 日韩三块已上线 (commit e2aa78ba)', body: '- 美洲 26 国\n- 非洲\n- 日韩' }], summary: '三大块上线,待切 Stripe' }) } })
    expect(prompt).toContain('不并**:承诺、决定')
    expect(r).toMatchObject({ topics: 1, merged: 3, failed: 0 })
    const live = await threads.entries(t, { live: true })
    expect(live.map(e => e.kind).sort()).toEqual(['commitment', 'decision', 'progress'])
    const merged = live.find(e => e.kind === 'progress')!
    expect(merged.line).toBe('1in8b 美洲 / 非洲 / 日韩三块已上线')
    const all = await threads.entries(t)
    expect(all.length).toBe(6)
    for (const id of ids.slice(0, 3)) expect(await threads.getEntry(id)).toMatchObject({ status: 'superseded', supersededBy: merged.id })
    expect((await threads.get(t))!.summary).toBe('三大块上线,待切 Stripe')
    expect((await threads.getExtractState('o')).consolidatedToTs).toBe('2026-11-05T04:00:00Z')
    // 第二晚没改过 ⇒ 不叫模型
    let calls = 0
    await consolidateTopics({ chatId: 'o', threads, log: () => {}, now: () => '2026-11-06T04:00:00Z', sdkEval: async () => { calls++; return '{"merge":[]}' } })
    expect(calls).toBe(0)
  })

  it('条目少:不叫模型,只按规则去提交号', async () => {
    const threads = makeThreadsStore(openTestDb())
    const t = await threads.create({ chatId: 'o', title: 'melu', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    const e = await threads.addEntry({ threadId: t, kind: 'progress', line: '科普功能完成 (commit 3897195)' })
    let calls = 0
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, sdkEval: async () => { calls++; return '' } })
    expect(calls).toBe(0)
    expect(r.stripped).toBe(1)
    expect((await threads.getEntry(e))!.line).toBe('科普功能完成')
  })

  it('模型失败 ⇒ 这个话题原样、水位不动;空输出重试一次', async () => {
    const { threads, t } = await setup()
    let calls = 0
    const r = await consolidateTopics({ chatId: 'o', threads, log: () => {}, sdkEval: async () => { calls++; return '' } })
    expect(calls).toBe(2)
    expect(r.failed).toBe(1)
    expect((await threads.entries(t, { live: true })).length).toBe(5)
    expect((await threads.getExtractState('o')).consolidatedToTs).toBeNull()
  })
})
