import { afterEach, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { consolidateTopics } from '../../daemon/threads/consolidate'
import { readProjectsActivity } from './projects-activity'

const at = Date.parse('2026-11-10T20:00:00Z'), now = at + 86400000
const dbs: Db[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
const identify = async (path: string) => ({ key: path + '/.git', roots: [path], names: ['bx'] })
type Source = 'all-work' | 'mixed-chat' | 'all-chat'
type Shape = 'allowed' | 'foreign' | 'remote' | 'subagent' | 'temporary' | 'missing' | 'unknown'

async function fixture(source: Source, shape: Shape) {
  const db = openTestDb(); dbs.push(db)
  const threads = makeThreadsStore(db), matters = makeMatterStore(db, () => at), log = makeMatterLog(db, () => at)
  const topic = await threads.create({ chatId: 'owner', title: 'bx', private: false, summary: '', facets: [], tags: [], episodes: [] })
  const matter = matters.create({ kind: ['remote', 'subagent'].includes(shape) ? 'terminal' : 'task', title: '检查',
    projectPath: shape === 'temporary' ? '/tmp/selftest' : shape === 'unknown' ? null : '/projects/bx', ownerChatId: shape === 'foreign' ? 'visitor' : 'owner' })
  const turn = log.startTurn({ matterId: matter.id, executor: 'claude', policy: {
    ...(shape === 'unknown' ? {} : { cwd: matter.projectPath }),
    ...(shape === 'remote' ? { machine: 'remote' } : {}), ...(shape === 'subagent' ? { originAgent: 'subagent' } : {}),
  } })
  log.finishTurn(turn.id, { status: 'completed', endedAt: at + 1 })
  db.query('UPDATE matters SET archived_at=? WHERE id=?').run(at + 2, matter.id)
  const matterId = shape === 'missing' ? 'deleted-matter' : matter.id
  const old = await threads.addEntry({ threadId: topic, kind: 'progress', line: '隐私构建 检查进度 第一步',
    source: source === 'all-work' ? 'work' : 'chat', ...(source === 'all-work' ? { matterId } : {}), ts: new Date(at).toISOString() })
  const latest = await threads.addEntry({ threadId: topic, kind: 'progress', line: `隐私构建 检查进度 CANARY_${shape}`,
    source: source === 'all-chat' ? 'chat' : 'work', ...(source === 'all-chat' ? {} : { matterId }), ts: new Date(at + 1000).toISOString() })
  await threads.addEntry({ threadId: topic, kind: 'decision', line: '甲决定', ts: new Date(at).toISOString() })
  await threads.addEntry({ threadId: topic, kind: 'decision', line: '乙决定', ts: new Date(at + 1).toISOString() })
  const read = () => readProjectsActivity({ db, owner: 'owner', identify, now: () => now }, { projects: ['bx'] })
  const merge = async (ids: string[], time = at + 2000) => {
    // Historical fixture: consolidate while authorized, then revoke the original
    // facts. The production consolidator now correctly refuses restricted input.
    const savedMatter=db.query<{kind:string;owner_chat_id:string|null;project_path:string|null},[string]>('SELECT kind,owner_chat_id,project_path FROM matters WHERE id=?').get(matter.id)!
    const savedTurns=db.query<{id:string;policy_json:string},[string]>('SELECT id,policy_json FROM matter_turns WHERE matter_id=?').all(matter.id)
    const savedEntries=db.query<{id:string;source:string;matter_id:string|null},[string]>('SELECT id,source,matter_id FROM topic_entries WHERE thread_id=?').all(topic)
    db.query("UPDATE matters SET kind='task',owner_chat_id='owner',project_path='/projects/bx' WHERE id=?").run(matter.id)
    for(const t of savedTurns)db.query('UPDATE matter_turns SET policy_json=? WHERE id=?').run(JSON.stringify({cwd:'/projects/bx'}),t.id)
    for(const e of savedEntries)if(e.source!=='chat')db.query("UPDATE topic_entries SET source='work',matter_id=? WHERE id=?").run(matter.id,e.id)
    let result
    try {
      result = await consolidateTopics({ chatId: 'owner', threads, sdkEval: async () => JSON.stringify({ groups: [ids] }), log: () => {}, now: () => new Date(time).toISOString() })
    } finally {
      db.query('UPDATE matters SET kind=?,owner_chat_id=?,project_path=? WHERE id=?').run(savedMatter.kind,savedMatter.owner_chat_id,savedMatter.project_path,matter.id)
      for(const t of savedTurns)db.query('UPDATE matter_turns SET policy_json=? WHERE id=?').run(t.policy_json,t.id)
      for(const e of savedEntries)db.query('UPDATE topic_entries SET source=?,matter_id=? WHERE id=?').run(e.source,e.matter_id,e.id)
    }
    expect(result).toMatchObject({ merged: 2, failed: 0 })
    const progress = (await threads.entries(topic, { live: true })).filter(e => e.kind === 'progress')
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ matterId: null })
    return progress[0]!
  }
  return { db, threads, matters, log, topic, matter, turn, old, latest, read, merge }
}

for (const source of ['all-work', 'mixed-chat'] as const) {
  // Removing lineage authorization must expose the review's six actual consolidation canaries.
  it.each(['foreign', 'remote', 'subagent'] as const)(`${source} consolidation inherits %s exclusion`, async shape => {
    const f = await fixture(source, shape)
    expect(JSON.stringify(await f.read())).not.toContain('CANARY_')
    const merged = await f.merge([f.old, f.latest])
    expect(merged.source).toBe(source === 'all-work' ? 'work' : 'chat')
    expect(JSON.stringify(await f.read())).not.toContain('CANARY_')
  })
}

it.each(['all-work', 'mixed-chat', 'all-chat'] as const)('retains legal owner %s consolidation without reader writes', async source => {
  const f = await fixture(source, 'allowed')
  await f.merge([f.old, f.latest])
  const before = f.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n
  const result = await f.read()
  expect(result.projects[0]!.entries.map(e => e.line)).toContain('隐私构建 检查进度 CANARY_allowed')
  expect(f.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n).toBe(before)
})

it.each(['temporary', 'missing', 'unknown'] as const)('rejects mixed consolidation with an original %s matter', async shape => {
  const f = await fixture('mixed-chat', shape)
  await f.merge([f.old, f.latest])
  expect(JSON.stringify(await f.read())).not.toContain('CANARY_')
})

it.each(['unlinked', 'delegated', 'wrong-kind'] as const)('rejects %s original sources even when consolidated into chat', async shape => {
  const f = await fixture('mixed-chat', 'allowed')
  if (shape === 'unlinked') f.db.query('UPDATE topic_entries SET matter_id=NULL WHERE id=?').run(f.latest)
  else if (shape === 'delegated') f.db.query("UPDATE topic_entries SET source='delegate',matter_id=NULL WHERE id=?").run(f.latest)
  else f.db.query("UPDATE matters SET kind='chat' WHERE id=?").run(f.matter.id)
  await f.merge([f.old, f.latest])
  expect(JSON.stringify(await f.read())).not.toContain('CANARY_')
})

it.each(['allowed', 'foreign'] as const)('traces every original through multiple merges: %s', async shape => {
  const f = await fixture('mixed-chat', shape)
  const first = await f.merge([f.old, f.latest])
  const newer = await f.threads.addEntry({ threadId: f.topic, kind: 'progress', line: '隐私构建 检查进度 CANARY_second', source: 'chat', ts: new Date(at + 3000).toISOString() })
  await f.merge([first.id, newer], at + 4000)
  const result = await readProjectsActivity({ db: f.db, owner: 'owner', identify, now: () => now }, { projects: ['bx'], since: new Date(at + 2500).toISOString() })
  const lines = result.projects.flatMap(p => p.entries.map(e => e.line))
  if (shape === 'allowed') expect(lines).toContain('隐私构建 检查进度 CANARY_second')
  else expect(lines.join('\n')).not.toContain('CANARY_')
})

it.each(['foreign', 'remote', 'subagent', 'temporary', 'missing'] as const)('rechecks original %s authorization after awaited identity resolution', async change => {
  const f = await fixture('mixed-chat', 'allowed')
  await f.merge([f.old, f.latest])
  expect(JSON.stringify(await f.read())).toContain('CANARY_allowed')
  let changed = false
  const result = await readProjectsActivity({ db: f.db, owner: 'owner', now: () => now, identify: async path => {
    if (!changed) {
      changed = true
      await Promise.resolve()
      if (change === 'foreign') f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', f.matter.id)
      else if (change === 'missing') f.db.transaction(() => {
        f.db.query('DELETE FROM matter_items WHERE matter_id=?').run(f.matter.id)
        f.db.query('DELETE FROM matter_turns WHERE matter_id=?').run(f.matter.id)
        f.db.query('DELETE FROM matters WHERE id=?').run(f.matter.id)
      })()
      else if (change === 'temporary') f.db.query('UPDATE matters SET project_path=? WHERE id=?').run('/tmp/selftest', f.matter.id)
      else {
        f.db.query("UPDATE matters SET kind='terminal' WHERE id=?").run(f.matter.id)
        f.db.query('UPDATE matter_turns SET policy_json=? WHERE id=?').run(JSON.stringify({ cwd: '/projects/bx', ...(change === 'remote' ? { machine: 'remote' } : { originAgent: 'subagent' }) }), f.turn.id)
      }
    }
    return identify(path)
  } }, { projects: ['bx'] })
  expect(changed).toBe(true)
  if (change === 'missing') expect(f.matters.get(f.matter.id)).toBeNull()
  expect(JSON.stringify(result)).not.toContain('CANARY_')
})

it.each(['remote', 'subagent'] as const)('rejects original task %s policy as well as terminal policy', async shape => {
  const f = await fixture('mixed-chat', shape)
  f.db.query("UPDATE matters SET kind='task' WHERE id=?").run(f.matter.id)
  await f.merge([f.old, f.latest])
  expect(JSON.stringify(await f.read())).not.toContain('CANARY_')
})
