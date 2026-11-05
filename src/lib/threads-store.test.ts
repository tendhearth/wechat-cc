import { describe, it, expect } from 'vitest'
import { openTestDb } from './db'
import { makeThreadsStore } from './threads-store'

describe('threads store', () => {
  it('create + list returns thread with parsed facets/tags', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'compass 排产', summary: '排产改造', facets: ['task'], tags: ['compass'], private: false, episodes: [{ from_ts: 'a', to_ts: 'b' }] })
    const all = await s.list('c1')
    expect(all.length).toBe(1)
    expect(all[0]).toMatchObject({ title: 'compass 排产', facets: ['task'], tags: ['compass'], status: 'active' })
  })

  it('a corrupt JSON column does not crash the query — defaults to empty', async () => {
    // Regression: rowToRecord JSON.parse'd facets/tags/episodes unguarded, so a
    // single corrupt row (truncated write / manual edit) threw and broke the
    // ENTIRE thread list (not just that row). conversation-store guards its
    // analogous parse; threads-store must too.
    const db = openTestDb()
    const s = makeThreadsStore(db)
    await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['task'], tags: ['x'], private: false, episodes: [{ from_ts: 'a', to_ts: 'b' }] })
    db.exec(`UPDATE threads SET facets = 'not-json{', tags = '[broken', episodes = 'xxx' WHERE chat_id = 'c1'`)
    const all = await s.list('c1')
    expect(all.length).toBe(1)        // row still returned, query did not throw
    expect(all[0]!.facets).toEqual([])
    expect(all[0]!.tags).toEqual([])
    expect(all[0]!.episodes).toEqual([])
    expect(all[0]!.title).toBe('t')   // intact fields preserved
  })

  it('update merges fields and bumps last_active', async () => {
    const s = makeThreadsStore(openTestDb())
    const id = await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['life'], tags: [], private: true, episodes: [] })
    await s.update(id, { status: 'done', tags: ['股票'], lastActive: '2026-06-12T00:00:00Z' })
    const t = (await s.list('c1'))[0]!
    expect(t.status).toBe('done')
    expect(t.tags).toEqual(['股票'])
    expect(t.private).toBe(true)
  })

  it('tagVocabulary returns tags by frequency across chats', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'a', summary: '', facets: ['task'], tags: ['compass', '排产'], private: false, episodes: [] })
    await s.create({ chatId: 'c2', title: 'b', summary: '', facets: ['task'], tags: ['compass'], private: false, episodes: [] })
    expect((await s.tagVocabulary(10))[0]).toBe('compass')
  })

  it('watermark get/set roundtrip', async () => {
    const s = makeThreadsStore(openTestDb())
    expect(await s.getWatermark('c1')).toBeNull()
    await s.setWatermark('c1', '2026-06-11T00:00:00Z')
    expect(await s.getWatermark('c1')).toBe('2026-06-11T00:00:00Z')
  })

  it('v104:条目一行一件事;承诺才留期限;按话题分好;只看还算数的', async () => {
    const db = openTestDb()
    const s = makeThreadsStore(db)
    const a = await s.create({ chatId: 'c1', title: 'bx', summary: '', facets: ['task'], tags: [], aliases: ['bx server'], private: false, episodes: [] })
    const b = await s.create({ chatId: 'c1', title: '服务器', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    await s.create({ chatId: 'c2', title: 'other', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    const e1 = await s.addEntry({ threadId: a, kind: 'fact', line: '  bx 装在\n mini 上 ', due: '2026-01-01', ts: '2026-06-11T00:00:00Z' })
    const e2 = await s.addEntry({ threadId: a, kind: 'commitment', line: '答应小王装 bx', due: '2026-06-20', ts: '2026-06-12T00:00:00Z' })
    await s.addEntry({ threadId: b, kind: 'fact', line: '91 是主力', source: 'work', matterId: 'm1' })
    expect(await s.getEntry(e1)).toMatchObject({ line: 'bx 装在 mini 上', due: null, status: 'live', source: 'chat' })
    expect((await s.get(a))!.aliases).toEqual(['bx server'])
    await s.updateEntry(e2, { status: 'done', ts: '2026-06-13T00:00:00Z' })
    expect((await s.entries(a)).map(e => e.id)).toEqual([e2, e1])
    expect((await s.entries(a, { live: true })).map(e => e.id)).toEqual([e1])
    const by = await s.entriesByThread('c1')
    expect([...by.keys()].sort()).toEqual([a, b].sort())
    expect((await s.entriesByThread('c2')).size).toBe(0)
  })

  it('v104:新水位两列;老水位照旧独立', async () => {
    const s = makeThreadsStore(openTestDb())
    expect(await s.getExtractState('c1')).toEqual({ entriesToTs: null, workCursor: 0, consolidatedToTs: null })
    await s.setExtractState('c1', { workCursor: 7 })
    expect(await s.getExtractState('c1')).toEqual({ entriesToTs: null, workCursor: 7, consolidatedToTs: null })
    await s.setExtractState('c1', { entriesToTs: '2026-06-11T00:00:00Z' })
    expect(await s.getExtractState('c1')).toEqual({ entriesToTs: '2026-06-11T00:00:00Z', workCursor: 7, consolidatedToTs: null })
    await s.setWatermark('c1', '2026-01-01T00:00:00Z')
    expect(await s.getWatermark('c1')).toBe('2026-01-01T00:00:00Z')
    expect((await s.getExtractState('c1')).entriesToTs).toBe('2026-06-11T00:00:00Z')
  })

  it('episodes 存的时候排序、合并重叠段', async () => {
    const s = makeThreadsStore(openTestDb())
    const id = await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['task'], tags: [], private: false,
      episodes: [{ from_ts: '2026-06-02T00:00:00Z', to_ts: '2026-06-03T00:00:00Z' }, { from_ts: '2026-06-01T00:00:00Z', to_ts: '2026-06-02T12:00:00Z' }] })
    expect((await s.get(id))!.episodes).toEqual([{ from_ts: '2026-06-01T00:00:00Z', to_ts: '2026-06-03T00:00:00Z' }])
    await s.update(id, { episodes: [...(await s.get(id))!.episodes, { from_ts: '2026-06-02T00:00:00Z', to_ts: '2026-06-02T01:00:00Z' }, { from_ts: '2026-06-05T00:00:00Z', to_ts: '2026-06-05T00:00:00Z' }] })
    expect((await s.get(id))!.episodes).toEqual([{ from_ts: '2026-06-01T00:00:00Z', to_ts: '2026-06-03T00:00:00Z' }, { from_ts: '2026-06-05T00:00:00Z', to_ts: '2026-06-05T00:00:00Z' }])
  })

  it('写进去之前去掉身份号 / 尾号 / 密钥位置(条目和摘要都是)', async () => {
    const s = makeThreadsStore(openTestDb())
    const id = await s.create({ chatId: 'c1', title: 'Nategu', summary: 'EIN 61-2390916', facets: ['task'], tags: [], private: false, episodes: [] })
    const e = await s.addEntry({ threadId: id, kind: 'fact', line: 'Airwallex 尾号 3419', body: '密钥在 ~/.private_keys/1in8b.env' })
    expect(await s.getEntry(e)).toMatchObject({ line: 'Airwallex 尾号 ****', body: '密钥在 [密钥文件]' })
    expect((await s.get(id))!.summary).toBe('EIN [EIN]')
    await s.updateEntry(e, { body: 'EIN 61-2390916' }); await s.update(id, { summary: '尾号 3419' })
    expect((await s.getEntry(e))!.body).toBe('EIN [EIN]')
    expect((await s.get(id))!.summary).toBe('尾号 ****')
  })
})
