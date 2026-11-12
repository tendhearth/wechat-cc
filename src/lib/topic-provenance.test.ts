import { afterEach, expect, it, vi } from 'vitest'
import { hostname } from 'node:os'
import { openTestDb, type Db } from './db'
import { makeThreadsStore } from './threads-store'
import { makeMatterStore } from '../adapters/store/matters-store'
import { makeMatterLog } from '../adapters/store/matter-log'
import { allowedTopicEntryIds, localTopicContext, restrictedTopicIds, topicMatterAccess } from './topic-provenance'
import { makeTopicRecall, makeTopicSearch } from '../daemon/threads/recall'

const host = vi.hoisted(() => ({ override: undefined as string | undefined }))
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, hostname: () => host.override ?? original.hostname() }
})
const dbs: Db[] = []
afterEach(() => { host.override = undefined; vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close() })
async function fixture() {
  const db = openTestDb(); dbs.push(db)
  const raw = makeThreadsStore(db), owner = makeThreadsStore(db, { filterSources: true })
  const topic = await raw.create({ chatId: 'owner', title: '家用网络', summary: '网络配置', aliases: ['家里路由'], facets: ['task'], tags: ['网络'], private: false, episodes: [] })
  const matters = makeMatterStore(db), log = makeMatterLog(db)
  const task = (path: string | null = '/projects/network', machine?: string) => {
    const m = matters.create({ kind: 'task', title: '网络配置', ownerChatId: 'owner', projectPath: path })
    log.startTurn({ matterId: m.id, executor: 'codex', policy: { cwd: path, ...(machine ? { machine } : {}) } })
    return m.id
  }
  return { db, raw, owner, topic, task }
}

it('owner can search title and alias and recall chat with a deleted-matter entry', async () => {
  const f = await fixture(), matter = f.task()
  const bad = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '旧工作结论', source: 'work', matterId: matter })
  const good = await f.raw.addEntry({ threadId: f.topic, kind: 'decision', line: '主人决定周末换路由' })
  f.db.exec('PRAGMA foreign_keys=OFF'); f.db.query('DELETE FROM matters WHERE id=?').run(matter)
  expect((await f.owner.get(f.topic))!.aliases).toEqual(['家里路由'])
  const search = makeTopicSearch({ threads: f.owner, ownerChatId: () => 'owner' })
  for (const query of ['家用网络', '家里路由']) {
    expect(JSON.stringify(await search('owner', query))).toContain('主人决定周末换路由')
    const r = await makeTopicRecall({ threads: f.owner, isOwner: () => true, cheapEval: () => null, log: () => {} })('owner', query)
    expect(r?.entryIds).toContain(good)
    expect(r?.entryIds).not.toContain(bad)
  }
})

it('owner pathless local task is readable while remote and child tasks remain denied', async () => {
  const f = await fixture(), local = f.task(null), remote = f.task(null, 'other-machine'), child = f.task(null)
  f.db.query('UPDATE matter_turns SET policy_json=? WHERE matter_id=?').run(JSON.stringify({ originAgent: 'child' }), child)
  expect([...topicMatterAccess(f.db, localTopicContext('owner'), [local, remote, child]).entryAllowed]).toEqual([local])
  const id = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '无目录任务完成', source: 'work', matterId: local })
  expect((await f.owner.entries(f.topic)).map(e => e.id)).toEqual([id])
})

it('owner historical work survives local hostname suffix and case drift', async () => {
  const f = await fixture(), matter = f.task('/projects/network', 'Nates-Mac.local')
  const id = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '主人终端的配置', source: 'work', matterId: matter })
  for (const machine of ['nates-mac', 'NATES-MAC-2.local', 'Nates-Mac-3']) {
    expect([...allowedTopicEntryIds(f.db, { owner: 'owner', machine }, [id])]).toEqual([id])
  }
  expect([...allowedTopicEntryIds(f.db, { owner: 'owner', machine: 'other-mac' }, [id])]).toEqual([])
})

it('owner keeps a derived chat memory after its source was deleted; restricted readers fail closed', async () => {
  const f = await fixture(), source = await f.raw.addEntry({ threadId: f.topic, kind: 'fact', line: '原主人记忆' })
  const copy = await f.raw.addEntry({ threadId: f.topic, kind: 'decision', line: '主人之后的决定', derivedFrom: [source] })
  f.db.query('DELETE FROM topic_entries WHERE id=?').run(source)
  expect((await f.owner.entries(f.topic)).map(e => e.id)).toEqual([copy])
  expect(await makeThreadsStore(f.db, { filterSources: true, allowWork: false }).entries(f.topic)).toEqual([])
})

it('superseded restricted entries no longer independently hide metadata from restricted readers', async () => {
  const f = await fixture(), bad = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '无法证明的旧结论', source: 'work' })
  await f.raw.updateEntry(bad, { status: 'superseded' })
  await f.raw.addEntry({ threadId: f.topic, kind: 'decision', line: '主人的新决定' })
  expect([...restrictedTopicIds(f.db, { ...localTopicContext('owner'), allowWork: false }, [f.topic])]).toEqual([])
  expect((await makeThreadsStore(f.db, { filterSources: true, allowWork: false }).get(f.topic))?.title).toBe('家用网络')
})

it('5k-entry deep-chain owner recall stays indexed and batched on cold reads after writes', async () => {
  const f = await fixture(), matter = f.task('/projects/network', hostname())
  f.db.transaction(() => {
    const insert = f.db.query(`INSERT INTO topic_entries(id,thread_id,kind,line,source,matter_id,status,superseded_by,created_ts,updated_ts) VALUES(?,?,'progress','网络配置已完成','work',?,?,?,'2026-11-01','2026-11-01')`)
    for (let n = 0; n < 5000; n++) insert.run(`scale-${n}`, f.topic, matter, n === 4999 ? 'live' : 'superseded', n === 4999 ? null : `scale-${n + 1}`)
  })()
  // Assert the actual recursive join's index remains available even with automatic indexes disabled.
  f.db.exec('PRAGMA automatic_index=OFF')
  const plan = f.db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT e.id FROM topic_entries p JOIN topic_entries e ON e.superseded_by=p.id WHERE p.id='scale-4999'").all()
  expect(plan.some(r => /SEARCH e USING (?:COVERING )?INDEX/.test(r.detail))).toBe(true)
  let executed = 0
  const originalQuery = f.db.query.bind(f.db)
  vi.spyOn(f.db, 'query').mockImplementation(((sql: string) => new Proxy(originalQuery(sql), {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (['get', 'all', 'values', 'iterate', 'run'].includes(String(key))) executed++
        return Reflect.apply(value, target, args)
      }
    },
  })) as Db['query'])
  const recall = makeTopicRecall({ threads: f.owner, isOwner: () => true, cheapEval: () => null, log: () => {} })
  for (let round = 0; round < 3; round++) {
    await f.raw.setExtractState('unrelated', { entriesToTs: `2026-11-0${round + 1}T00:00:00Z` })
    executed = 0
    const started = performance.now(), result = await recall('owner', '家里路由')
    expect(result?.entryIds).toEqual(['scale-4999'])
    expect(performance.now() - started).toBeLessThan(1500)
    expect(executed).toBeLessThan(35)
  }
})

it('owner reads stay correct after nested savepoint grants and revocations are rolled back', async () => {
  const f = await fixture(), matter = f.task()
  const id = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '主人工作结论', source: 'work', matterId: matter })
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', matter)
  f.db.transaction(() => {
    f.db.exec('SAVEPOINT grant')
    f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('owner', matter)
    expect([...allowedTopicEntryIds(f.db, localTopicContext('owner'), [id])]).toEqual([id])
    f.db.exec('ROLLBACK TO grant; RELEASE grant')
    expect([...allowedTopicEntryIds(f.db, localTopicContext('owner'), [id])]).toEqual([])
  })()
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('owner', matter)
  expect((await f.owner.entries(f.topic)).map(e => e.id)).toEqual([id])
})

it('transaction metadata authorization shares nested batch reads and retains owner entries', async () => {
  const f = await fixture()
  await f.raw.addEntry({ threadId: f.topic, kind: 'decision', line: '主人周末换路由' })
  const query = vi.spyOn(f.db, 'query')
  f.db.transaction(() => {
    query.mockClear()
    expect([...restrictedTopicIds(f.db, { ...localTopicContext('owner'), allowWork: false }, [f.topic])]).toEqual([])
    // One snapshot query per top-level authorization, including nested entry/matter checks.
    expect(query.mock.calls.filter(([sql]) => sql.includes('total_changes()'))).toHaveLength(1)
  })()
  expect(await f.owner.entries(f.topic)).toMatchObject([{ line: '主人周末换路由' }])
})

it('owner exact local hostname with numeric name segments is never normalized twice', async () => {
  host.override = 'Nates-Mac-1-2.local'
  const f = await fixture(), matter = f.task('/projects/network', host.override)
  const id = await f.raw.addEntry({ threadId: f.topic, kind: 'conclusion', line: '主人数字命名机器的历史', source: 'work', matterId: matter })
  expect((await f.owner.entries(f.topic)).map(e => e.id)).toEqual([id])
})
