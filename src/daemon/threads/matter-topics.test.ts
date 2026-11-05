import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterTopics, BRIEF_HEAD } from './matter-topics'
import { readWorkResults } from './work-results'

const T0 = Date.UTC(2026, 10, 5)
async function setup() {
  const db = openTestDb()
  const threads = makeThreadsStore(db)
  const bx = await threads.create({ chatId: 'owner', title: 'bx', summary: '网络工具', facets: ['task'], tags: [], aliases: ['透明代理'], private: false, episodes: [] })
  await threads.addEntry({ threadId: bx, kind: 'decision', line: 'UDP 走 hysteria2' })
  const mom = await threads.create({ chatId: 'owner', title: '妈妈', summary: '家里的事', facets: ['life'], tags: [], private: true, episodes: [] })
  await threads.addEntry({ threadId: mom, kind: 'fact', line: '妈妈下周体检' })
  let cursor = 0, seq = 0
  db.query(`INSERT INTO matters(id, kind, title, project_path, state, created_at, updated_at) VALUES ('m1','task','修 bx 的 UDP','/Users/o/bx','open',?,?)`).run(T0, T0)
  const item = (kind: string, text: string) => { seq++; cursor++; db.query(`INSERT INTO matter_items(matter_id, seq, kind, status, payload_json, created_at, updated_at, cursor) VALUES ('m1', ?, ?, 'completed', ?, ?, ?, ?)`).run(seq, kind, JSON.stringify({ text }), T0 + seq, T0 + seq, cursor) }
  const logs: string[] = []
  const mt = makeMatterTopics({ db, threads, ownerChatId: () => 'owner', log: (_t, l) => logs.push(l), now: () => new Date(T0) })
  return { db, threads, bx, mom, item, mt, logs }
}

describe('makeMatterTopics (话题 T3)', () => {
  it('主人的任务:简报带话题条目,记一行 matter_topics;别人的任务 / 碰不到 ⇒ null', async () => {
    const { db, bx, item, mt } = await setup()
    item('user_message', '早先的一句')
    const b = await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'owner', title: '修 bx 的 UDP', text: '看下延迟' })
    expect(b!.startsWith(BRIEF_HEAD)).toBe(true)
    expect(b).toContain('UDP 走 hysteria2')
    expect(db.query('SELECT matter_id, thread_id, written_back_cursor FROM matter_topics').all()).toEqual([{ matter_id: 'm1', thread_id: bx, written_back_cursor: 1 }])
    expect(await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'guest', title: 'bx', text: '' })).toBeNull()
    expect(await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'owner', title: '写个周报', text: '' })).toBeNull()
  })

  it('简报只带索引行,不带细节', async () => {
    const { threads, bx, mt } = await setup()
    await threads.addEntry({ threadId: bx, kind: 'fact', line: 'bx 服务器在 166', body: 'root 密码在钥匙串 bx-166 里' })
    const b = await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'owner', title: 'bx 服务器', text: '' })
    expect(b).toContain('bx 服务器在 166')
    expect(b).not.toContain('钥匙串')
  })

  it('私密的话题永远不进简报', async () => {
    const { mt } = await setup()
    expect(await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'owner', title: '妈妈体检的事查一下', text: '' })).toBeNull()
    expect(await mt.briefForDelegate('owner', '妈妈下周体检要准备什么')).toBeNull()
  })

  it('一轮做完:结论写回挂着的话题,只写一次;T1 的抽取不再交这一段', async () => {
    const { db, threads, bx, item, mt } = await setup()
    await mt.briefForMatter({ matterId: 'm1', ownerChatId: 'owner', title: '修 bx 的 UDP', text: '' })
    item('user_message', '修 UDP')
    item('agent_message', '先看看')
    item('agent_message', '改好了:UDP 默认走 hysteria2\n验证:Meet 延迟 80ms')
    expect(await mt.writeBack('m1')).toBe(1)
    const e = (await threads.entries(bx)).find(x => x.kind === 'conclusion')!
    expect(e).toMatchObject({ source: 'work', matterId: 'm1', line: '修 bx 的 UDP:改好了:UDP 默认走 hysteria2' })
    expect(e.body).toContain('Meet 延迟 80ms')
    expect(await mt.writeBack('m1')).toBe(0)
    db.query("UPDATE matters SET state = 'done' WHERE id = 'm1'").run()
    expect(readWorkResults(db, 0, T0 + 10).results).toEqual([])
    expect(await mt.writeBack('nope')).toBe(0)
  })

  it('delegate:只给主人;回答写成一条 delegate 结论', async () => {
    const { threads, bx, mt } = await setup()
    expect(await mt.briefForDelegate('guest', 'bx 的 UDP 怎么配')).toBeNull()
    expect(await mt.briefForDelegate(undefined, 'bx 的 UDP 怎么配')).toBeNull()
    const b = await mt.briefForDelegate('owner', 'bx 的 UDP 怎么配')
    expect(b).toMatchObject({ topicIds: [bx] })
    await mt.writeDelegate(b!.topicIds, 'codex', 'bx 的 UDP 怎么配\n细节', '用 hysteria2')
    expect((await threads.entries(bx)).find(x => x.source === 'delegate')).toMatchObject({ kind: 'conclusion', line: '问 codex:bx 的 UDP 怎么配', body: '用 hysteria2' })
  })
})
