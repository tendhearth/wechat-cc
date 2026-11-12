import { afterEach, expect, it } from 'vitest'
import { hostname } from 'node:os'
import { openTestDb, type Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeCliSessionStore } from '../../adapters/store/cli-session-store'
import { makeMatterTopics } from './matter-topics'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { readWorkResults, readMatterConclusion } from './work-results'
import { runThreadsExtraction } from './extractor'
import { consolidateTopics } from './consolidate'
import { makeOwnerDelegationRecorder } from '../wiring/owner-delegation'
import { loadMatchTopics, makeTopicRecall } from './recall'
import { bubbleRoutes } from '../../features/memory/bubble-routes'
import { topicsProjection, topicDetailPage } from '../../features/memory/topic-projection'

const dbs: Db[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
const at = Date.UTC(2026, 10, 10)
const context = { owner: 'owner', machine: hostname() }
function fixture() {
  const db = openTestDb(); dbs.push(db)
  const threads = makeThreadsStore(db), messages = makeMessagesStore(db)
  const matters = makeMatterStore(db, () => at), log = makeMatterLog(db, () => at)
  const turns = makeTerminalTurnLog({ db, matters, log })
  const task = (owner = 'owner', path: string | null = '/projects/bx') => {
    const m = matters.create({ kind: 'task', title: 'bx', projectPath: path, ownerChatId: owner })
    const t = log.startTurn({ matterId: m.id, executor: 'codex', policy: { cwd: path } })
    log.writeItem({ matterId: m.id, turnId: t.id, kind: 'agent_message', status: 'completed', payload: { text: 'RESULT_CANARY_DNS 修复完成' } })
    log.finishTurn(t.id, { status: 'completed', matterState: 'done' })
    return m.id
  }
  const terminal = (extra: { machine?: string; origin_agent?: string }) => {
    const base = { session_id: 'abcdef', source: 'claude' as const, cwd: '/projects/bx', ...extra }
    makeCliSessionStore(db, () => at).touch(base, at)
    turns.event({ ...base, kind: 'prompt', text: '修复 DNS' }, at)
    turns.event({ ...base, kind: 'stop', text: 'RESULT_CANARY_DNS 修复完成' }, at + 1)
    turns.event({ ...base, kind: 'session_end' }, at + 2)
    return matters.findBySurface('cli', 'abcdef')!.id
  }
  const extract = (sdkEval: (prompt: string) => Promise<string>) => runThreadsExtraction({
    chatId: 'owner', threads, messages,
    work: after => readWorkResults(db, after, context, at + 3),
    workAllowed: id => readMatterConclusion(db, id, 0, context) !== null,
    sdkEval, recordEvent: async () => {}, log: () => {},
  })
  const response = (id?: string) => JSON.stringify({ ops: [{ op: 'create_topic', title: 'bx', summary: 'RESULT_CANARY_DNS', facets: ['task'], tags: [], aliases: [], private: false,
    entries: [{ kind: 'conclusion', line: 'RESULT_CANARY_DNS', ...(id !== undefined ? { matter: id } : {}) }] }] })
  return { db, threads, messages, matters, log, task, terminal, extract, response }
}

it.each(['visitor', 'remote', 'subagent', 'temporary', 'unknown-path'] as const)('real reader rejects %s before the model and advances its cursor', async shape => {
  const f = fixture()
  const id = shape === 'remote' ? f.terminal({ machine: 'remote-host' }) : shape === 'subagent' ? f.terminal({ origin_agent: 'child-agent' }) : f.task(shape === 'visitor' ? 'visitor' : 'owner', shape === 'temporary' ? '/tmp/probe' : shape === 'unknown-path' ? null : '/projects/bx')
  let calls = 0
  await f.extract(async () => { calls++; return f.response(id) })
  expect(calls).toBe(0)
  expect(await f.threads.list('owner')).toEqual([])
  expect(readMatterConclusion(f.db, id, 0, context)).toBeNull()
  expect((await f.threads.getExtractState('owner')).workCursor).toBeGreaterThan(0)
})

it('real local owner work reaches the model and retains matter provenance in storage', async () => {
  const f = fixture(), id = f.task()
  let prompt = ''
  await f.extract(async p => { prompt = p; return f.response(id) })
  expect(prompt).toContain('RESULT_CANARY_DNS')
  const [topic] = await f.threads.list('owner')
  expect(await f.threads.entries(topic!.id)).toMatchObject([{ source: 'work', matterId: id, line: 'RESULT_CANARY_DNS' }])
})

it.each(['missing', 'visitor', 'remote', 'subagent'] as const)('rechecks %s matter after model return without persisting stale topic metadata', async change => {
  const f = fixture(), id = f.task()
  await f.extract(async () => {
    if (change === 'missing') { f.db.exec('PRAGMA foreign_keys=OFF'); f.db.query('DELETE FROM matters WHERE id=?').run(id) }
    else if (change === 'visitor') f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id)
    else f.db.query('UPDATE matter_turns SET policy_json=? WHERE matter_id=?').run(JSON.stringify({ cwd: '/projects/bx', ...(change === 'remote' ? { machine: 'remote-host' } : { originAgent: 'child-agent' }) }), id)
    return f.response(id)
  })
  expect(await f.threads.list('owner')).toEqual([])
  expect(f.db.query('SELECT id FROM topic_entries').all()).toEqual([])
})

it.each(['missing', 'forged'] as const)('never demotes a %s work reference into chat', async reference => {
  const f = fixture(); f.task()
  await f.extract(async () => f.response(reference === 'forged' ? 'absent' : undefined))
  expect(f.db.query('SELECT id FROM topic_entries').all()).toEqual([])
})

it('an orphaned matter is never sent to the model', async () => {
  const f = fixture(), id = f.task()
  { f.db.exec('PRAGMA foreign_keys=OFF'); f.db.query('DELETE FROM matters WHERE id=?').run(id) }
  let calls = 0
  await f.extract(async () => { calls++; return f.response(id) })
  expect(calls).toBe(0)
  expect(await f.threads.list('owner')).toEqual([])
})

it('authorized recall and paginated detail hide restricted history and derived summaries without writes', async () => {
  const f = fixture(), local = f.task(), visitor = f.task('visitor')
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_CACHED', description: 'SECRET_CACHED', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  const add = (line: string, source: 'chat' | 'work' | 'delegate', matterId?: string) => f.threads.addEntry({ threadId: topic, kind: 'conclusion', line, body: line, source, matterId, ...(source==='delegate'?{ts:'2026-11-01T00:00:00Z'}:{}) })
  await add('ALLOWED', 'work', local)
  await add('SECRET_VISITOR', 'work', visitor)
  await add('SECRET_MISSING', 'work')
  await add('ALLOWED_DELEGATE', 'delegate')
  const original = await add('SECRET_ORIGINAL', 'work', visitor)
  const synthetic = await add('SECRET_MERGED', 'chat')
  await f.threads.updateEntry(original, { status: 'superseded', supersededBy: synthetic })
  const before = f.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n
  const readable = makeThreadsStore(f.db, { filterSources: true })
  const recall = await loadMatchTopics(readable, 'owner')
  expect(JSON.stringify(recall)).not.toContain('SECRET_')
  expect(recall[0]!.entries.map(e => e.line).sort()).toEqual(['ALLOWED', 'ALLOWED_DELEGATE'])
  const detail = await topicDetailPage(f.db, 'owner', topic, { entries: 0, matters: 0, messages: 0 }, { entries: 1, matters: 1, messages: 1 })
  expect(detail!.entries.map(e => e.line)).toEqual(['ALLOWED'])
  expect(detail!.totals.entries).toBe(2)
  expect(JSON.stringify(detail)).not.toContain('SECRET_')
  expect(f.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n).toBe(before)
  expect(await f.threads.entries(topic)).toHaveLength(6)
})

it('rechecks work authorization after awaited context reads before calling the model', async () => {
  const f = fixture(), id = f.task()
  const original = f.threads.tagVocabulary
  f.threads.tagVocabulary = async n => {
    f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id)
    return original(n)
  }
  let calls = 0
  await f.extract(async () => { calls++; return f.response(id) })
  expect(calls).toBe(0)
})

it.each(['update_topic', 'update_entry'] as const)('rechecks before %s after an awaited lookup', async operation => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'old', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  const entry = await f.threads.addEntry({ threadId: topic, kind: 'fact', line: 'old' })
  const invalidate = () => f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id)
  if (operation === 'update_topic') {
    const get = f.threads.get
    f.threads.get = async value => { const result = await get(value); invalidate(); return result }
  } else {
    const get = f.threads.getEntry
    f.threads.getEntry = async value => { const result = await get(value); invalidate(); return result }
  }
  await f.extract(async () => JSON.stringify({ ops: [operation === 'update_topic' ? { op: operation, id: topic, summary: 'STALE_RESULT' } : { op: operation, id: entry, line: 'STALE_RESULT' }] }))
  expect(JSON.stringify(await f.threads.list('owner'))).not.toContain('STALE_RESULT')
  expect(JSON.stringify(await f.threads.entries(topic))).not.toContain('STALE_RESULT')
})

it('hides cached text derived from a restricted superseded original with no successor', async () => {
  const f = fixture(), id = f.task('visitor')
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_OLD', description: 'SECRET_OLD', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  const entry = await f.threads.addEntry({ threadId: topic, kind: 'progress', line: 'SECRET_OLD', source: 'work', matterId: id })
  await f.threads.updateEntry(entry, { status: 'superseded' })
  await f.threads.addEntry({ threadId: topic, kind: 'fact', line: 'safe' })
  const topics = await loadMatchTopics(makeThreadsStore(f.db, { filterSources: true }), 'owner')
  expect(JSON.stringify(topics)).not.toContain('SECRET_')
})

it.each(['missing', 'forged'] as const)('does not leave unlinked topic metadata from a %s work reference', async reference => {
  const f = fixture(); f.task()
  await f.extract(async () => f.response(reference === 'forged' ? 'absent' : undefined))
  expect(await f.threads.list('owner')).toEqual([])
})


it('rechecks cached topic metadata when detail receives an older projection', async () => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_CACHED', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  await f.threads.addEntry({ threadId: topic, kind: 'conclusion', line: 'SECRET_CACHED', source: 'work', matterId: id })
  const snapshot = await topicsProjection(f.db, 'owner')
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id)
  const detail = await topicDetailPage(f.db, 'owner', topic, { entries: 0, matters: 0, messages: 0 }, { entries: 1, matters: 1, messages: 1 }, undefined, snapshot)
  expect(JSON.stringify(detail)).not.toContain('SECRET_')
})

it('retains independent chat memories when completed work is waiting in the same tick', async () => {
  const f = fixture(), id = f.task()
  await f.messages.append({ id: 'chat', kind: 'text', source: 'live', chatId: 'owner', direction: 'in', text: '妈妈周五体检', ts: '2026-11-10T01:00:00Z' })
  await f.extract(async prompt => prompt.includes('=== agent 做完的活(只记结论) ===') ? f.response(id) : JSON.stringify({ ops: [{ op: 'create_topic', title: '妈妈', summary: '', facets: ['life'], tags: [], aliases: [], private: false, entries: [{ kind: 'commitment', line: '妈妈周五体检' }] }] }))
  const entries = [...(await f.threads.entriesByThread('owner')).values()].flat()
  expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ line: '妈妈周五体检', source: 'chat', matterId: null }), expect.objectContaining({ line: 'RESULT_CANARY_DNS', source: 'work', matterId: id })]))
})


it.each(['present', 'pruned'] as const)('local null-owner terminal remains authorized with %s CLI metadata', async metadata => {
  const f = fixture(), id = f.terminal({ machine: hostname() })
  if (metadata === 'pruned') f.db.query('DELETE FROM cli_sessions').run()
  let prompt = ''
  await f.extract(async p => { prompt = p; return f.response(id) })
  expect(prompt).toContain('RESULT_CANARY_DNS')
  const entries = [...(await f.threads.entriesByThread('owner')).values()].flat()
  expect(entries).toMatchObject([{ source: 'work', matterId: id }])
})

it.each(['machine', 'origin_agent'] as const)('current CLI %s overrides otherwise local turn facts', async field => {
  const f = fixture(), id = f.terminal({})
  f.db.query(`UPDATE cli_sessions SET ${field}=?`).run('remote-or-child')
  let calls = 0
  await f.extract(async () => { calls++; return f.response(id) })
  expect(calls).toBe(0)
})

it.each(['visitor', 'foreign-topic', 'remote'] as const)('direct conclusion writeback rejects %s source or target', async shape => {
  const f = fixture(), id = shape === 'remote' ? f.terminal({ machine: 'remote' }) : f.task(shape === 'visitor' ? 'visitor' : 'owner')
  const topic = await f.threads.create({ chatId: shape === 'foreign-topic' ? 'visitor' : 'owner', title: 'bx', summary: '', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  f.db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts,written_back_cursor) VALUES(?,?,?,0)').run(id, topic, new Date(at).toISOString())
  const service = makeMatterTopics({ db: f.db, threads: f.threads, ownerChatId: () => 'owner', log: () => {} })
  expect(await service.writeBack(id)).toBe(0)
  expect(await f.threads.entries(topic)).toEqual([])
})


it('rechecks historical topic context before sending a chat-only batch to the model', async () => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_HISTORY', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  await f.threads.addEntry({ threadId: topic, kind: 'conclusion', line: 'SECRET_HISTORY', source: 'work', matterId: id })
  await f.messages.append({ id: 'chat', kind: 'text', source: 'live', chatId: 'owner', direction: 'in', text: '周五去体检', ts: '2026-11-10T01:00:00Z' })
  const readable = makeThreadsStore(f.db, { filterSources: true })
  const vocab = readable.tagVocabulary
  readable.tagVocabulary = async n => { f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id); return vocab(n) }
  let leaked = false
  await runThreadsExtraction({ chatId: 'owner', threads: readable, messages: f.messages, sdkEval: async prompt => { leaked ||= prompt.includes('SECRET_'); return '{"ops":[]}' }, log: () => {}, recordEvent: async () => {} })
  expect(leaked).toBe(false)
})

it('work topic creation keeps linked entries atomic across asynchronous store wrappers', async () => {
  const f = fixture(), id = f.task()
  const create = f.threads.create
  f.threads.create = async input => { const topic = await create(input); f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id); return topic }
  await f.extract(async () => f.response(id))
  const readable = makeThreadsStore(f.db, { filterSources: true })
  const entries = [...(await f.threads.entriesByThread('owner')).values()].flat()
  const topics = await readable.list('owner')
  // A topic either has durable matter lineage, or contains no copied work text.
  expect(entries.some(e => e.matterId === id) || !JSON.stringify(topics).includes('RESULT_CANARY_DNS')).toBe(true)
})

it('direct writeback rechecks current target owner after an awaited lookup', async () => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: '', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  f.db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts,written_back_cursor) VALUES(?,?,?,0)').run(id, topic, new Date(at).toISOString())
  const get = f.threads.get
  f.threads.get = async value => { const result = await get(value); f.db.query('UPDATE threads SET chat_id=? WHERE id=?').run('visitor', value); return result }
  const service = makeMatterTopics({ db: f.db, threads: f.threads, ownerChatId: () => 'owner', log: () => {} })
  expect(await service.writeBack(id)).toBe(0)
  expect(await f.threads.entries(topic)).toEqual([])
})

it('unrelated database writes during model evaluation do not discard authorized output', async () => {
  const f = fixture(), id = f.task()
  await f.extract(async () => { f.task('visitor'); return f.response(id) })
  expect([...(await f.threads.entriesByThread('owner')).values()].flat()).toMatchObject([{ source: 'work', matterId: id }])
})

it('rechecks historical context after the apply-stage topic lookup', async () => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_HISTORY', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  await f.threads.addEntry({ threadId: topic, kind: 'conclusion', line: 'SECRET_HISTORY', source: 'work', matterId: id })
  await f.messages.append({ id: 'chat', kind: 'text', source: 'live', chatId: 'owner', direction: 'in', text: '周五去体检', ts: '2026-11-10T01:00:00Z' })
  const readable = makeThreadsStore(f.db, { filterSources: true }), list = readable.list
  let calls = 0
  readable.list = async owner => {
    const result = await list(owner)
    if (++calls === 2) f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id)
    return result
  }
  await runThreadsExtraction({ chatId: 'owner', threads: readable, messages: f.messages, sdkEval: async () => f.response(), log: () => {}, recordEvent: async () => {} })
  expect((await f.threads.list('owner')).map(t => t.id)).toEqual([topic])
  expect((await f.threads.getExtractState('owner')).entriesToTs).toBeNull()
})

it('authorization cached inside a rolled back transaction cannot outlive its temporary grant', () => {
  const f = fixture(), id = f.task('visitor')
  expect(() => f.db.transaction(() => {
    f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('owner', id)
    expect(readMatterConclusion(f.db, id, 0, context)).not.toBeNull()
    throw new Error('rollback')
  })()).toThrow('rollback')
  expect(readMatterConclusion(f.db, id, 0, context)).toBeNull()
})


it.each([
  ['activity','matter'], ['activity','owner'], ['judge','matter'], ['judge','owner'],
] as const)('recall rechecks %s-await %s revocation before returning memory', async (stage, source) => {
  const f = fixture(), id = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'SECRET_SUMMARY', facets: ['task'], tags: [], aliases: [], private: false, episodes: [] })
  await f.threads.addEntry({ threadId: topic, kind: 'conclusion', line: 'SECRET_ENTRY', source: 'work', matterId: id })
  let authorized = true, changed = false
  const revoke = () => { changed = true; if(source === 'owner') authorized = false; else f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', id) }
  const recall = makeTopicRecall({ threads: makeThreadsStore(f.db, { filterSources: true }), isOwner: () => authorized,
    activity: async () => { if(stage === 'activity')revoke(); return new Map() },
    cheapEval: () => async () => { if(stage === 'judge')revoke(); return '1.1' }, log: () => {} })
  expect(await recall('owner', '开视频会议的时候浏览器会把真实 IP 漏出去吗')).toBeNull()
  expect(changed).toBe(true)
})

it.each(['work-only', 'mixed'] as const)('restricted metadata canaries stay out of readers and extraction: %s', async shape => {
  const f = fixture(), matter = f.task()
  await f.extract(async () => JSON.stringify({ ops: [{ op: 'create_topic', title: 'SECRET_TITLE', summary: 'SECRET_SUMMARY', aliases: ['SECRET_ALIAS'], tags: ['SECRET_TAG'], facets: ['task'], private: false, entries: [{ kind: 'conclusion', line: 'SECRET_WORK', matter }] }] }))
  const [topic] = await f.threads.list('owner')
  if (shape === 'mixed') await f.threads.addEntry({ threadId: topic!.id, kind: 'fact', line: 'SAFE_CHAT' })
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', matter)
  await f.messages.append({ id: 'later', chatId: 'owner', ts: '2026-11-11T00:00:00Z', direction: 'in', text: '今天吃什么', kind: 'text', source: 'live' })
  const filtered = makeThreadsStore(f.db, { filterSources: true })
  let prompt = ''
  await runThreadsExtraction({ chatId: 'owner', threads: filtered, messages: f.messages, sdkEval: async p => { prompt = p; return '{"ops":[]}' }, recordEvent: async () => {}, log: () => {} })
  expect(prompt).not.toContain('SECRET_')
  expect(JSON.stringify(await filtered.list('owner'))).not.toContain('SECRET_')
  expect(JSON.stringify(await topicsProjection(f.db, 'owner'))).not.toContain('SECRET_')
  const detail = await topicDetailPage(f.db, 'owner', topic!.id, { entries: 0, matters: 0, messages: 0 }, { entries: 10, matters: 10, messages: 10 })
  expect(JSON.stringify(detail)).not.toContain('SECRET_')
  expect(await filtered.get(topic!.id)).toEqual(shape === 'work-only' ? null : expect.objectContaining({ title: '', aliases: [], tags: [] }))
  expect((await f.threads.get(topic!.id))!.title).toBe('SECRET_TITLE')
})

it('chat copies of existing work context inherit revocable provenance', async () => {
  const f = fixture(), matter = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'WORK_CANARY_DNS', facets: ['task'], tags: [], private: false, episodes: [] })
  const original = await f.threads.addEntry({ threadId: topic, kind: 'conclusion', line: 'WORK_CANARY_DNS', source: 'work', matterId: matter })
  await f.messages.append({ id: 'copy-chat', chatId: 'owner', direction: 'in', kind: 'text', source: 'live', text: '这个项目的诊断还要记得', ts: '2026-11-11T00:00:00Z' })
  const readable = makeThreadsStore(f.db, { filterSources: true })
  await runThreadsExtraction({ chatId: 'owner', threads: readable, messages: f.messages, sdkEval: async () => JSON.stringify({ ops: [{ op: 'add_entry', topic, kind: 'fact', line: 'WORK_CANARY_DNS' }] }), recordEvent: async () => {}, log: () => {} })
  const before = await f.threads.entries(topic)
  expect(before).toHaveLength(2)
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', matter)
  expect(await readable.entries(topic)).toEqual([])
  expect(await f.threads.getEntry(original)).not.toBeNull()
  expect(await f.threads.entries(topic)).toHaveLength(2)
})


it.each(['retry', 'response', 'owner'] as const)('nightly consolidation rechecks revoked context before %s', async stage => {
  const f = fixture(), matter = f.task()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: 'old', facets: ['task'], tags: [], private: false, episodes: [] })
  const first = await f.threads.addEntry({ threadId: topic, kind: 'progress', line: 'REVOKED_CANARY DNS 检查开始', source: 'work', matterId: matter })
  const second = await f.threads.addEntry({ threadId: topic, kind: 'progress', line: 'REVOKED_CANARY DNS 检查完成', source: 'work', matterId: matter })
  await f.threads.addEntry({ threadId: topic, kind: 'decision', line: '保持配置' })
  await f.threads.addEntry({ threadId: topic, kind: 'commitment', line: '明天确认' })
  const before = await f.threads.entries(topic)
  let calls = 0, owner = true
  const result = await consolidateTopics({ chatId: 'owner', threads: makeThreadsStore(f.db, { filterSources: true }), isOwner: () => owner,
    sdkEval: async () => { calls++; if (stage === 'owner') owner = false; else f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor', matter); return stage === 'retry' && calls === 1 ? '' : JSON.stringify({ groups: [[first, second]] }) }, log: () => {} })
  expect(calls).toBe(1)
  expect(result.failed).toBe(1)
  expect(result.merged).toBe(0)
  expect(await f.threads.entries(topic)).toEqual(before)
  expect((await f.threads.get(topic))!.summary).toBe('old')
  expect((await f.threads.getExtractState('owner')).consolidatedToTs).toBeNull()
})


it('T3 owner consultation delegate writeback remains readable to the owner', async () => {
  const f = fixture()
  const topic = await f.threads.create({ chatId: 'owner', title: 'bx', summary: '咨询', facets: ['task'], tags: [], private: false, episodes: [] })
  const service=makeMatterTopics({db:f.db,threads:f.threads,ownerChatId:()=> 'owner',log:()=>{}})
  await service.writeDelegate([topic],'codex','DNS 方案','DELEGATE_CANARY 采用双栈')
  const owner=makeThreadsStore(f.db,{filterSources:true})
  expect(await owner.entries(topic)).toMatchObject([{source:'delegate',body:'DELEGATE_CANARY 采用双栈',matterId:null}])
  expect((await owner.get(topic))!.summary).toBe('咨询')
  expect(await makeThreadsStore(f.db,{filterSources:true,allowWork:false}).get(topic)).toBeNull()
})


it('pathless owner consultation acts are extracted before their watermark advances', async () => {
  const f=fixture()
  const record=makeOwnerDelegationRecorder({db:f.db,ownerChatId:()=> 'owner',name:p=>p})
  record('owner','codex','咨询 DNS')!({ok:true,response:'PATHLESS_ACT_CANARY 双栈可用'})
  const row=f.db.query<{id:string;project_path:string|null},[]>('SELECT id,project_path FROM matters').get()!
  expect(row.project_path).toBeNull()
  const work=readWorkResults(f.db,0,context)
  expect(work.results).toMatchObject([{matterId:row.id,result:'PATHLESS_ACT_CANARY 双栈可用',project:null}])
  expect(readMatterConclusion(f.db,row.id,0,context)).toMatchObject({result:'PATHLESS_ACT_CANARY 双栈可用'})
  await f.threads.setExtractState('owner',{entriesToTs:'2099-01-01T00:00:00Z'})
  await f.extract(async()=> '')
  expect((await f.threads.getExtractState('owner')).workCursor).toBe(0)
  await f.extract(async()=>f.response(row.id))
  expect([...(await f.threads.entriesByThread('owner')).values()].flat()).toMatchObject([{source:'work',matterId:row.id}])
  expect((await f.threads.getExtractState('owner')).workCursor).toBe(work.nextCursor)
})

it('nightly consolidation never writes a filtered summary over raw restricted history', async () => {
  const f=fixture(), matter=f.task('visitor')
  const topic=await f.threads.create({chatId:'owner',title:'代理工具',description:'代理工具',summary:'代理工具。现状:旧状态',facets:['task'],tags:[],private:false,episodes:[]})
  await f.threads.addEntry({threadId:topic,kind:'conclusion',line:'SECRET_OLD',source:'work',matterId:matter})
  await f.threads.addEntry({threadId:topic,kind:'progress',line:'合法进展'})
  const before=await f.threads.get(topic)
  const result=await consolidateTopics({chatId:'owner',threads:makeThreadsStore(f.db,{filterSources:true}),sdkEval:null,log:()=>{}})
  expect(result.failed).toBe(0)
  expect(await f.threads.get(topic)).toEqual(before)
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('owner',matter)
  expect((await makeThreadsStore(f.db,{filterSources:true}).get(topic))!.summary).toBe('代理工具。现状:旧状态')
})

it('a subsequent sleep can consolidate a topic with authorized superseded history', async () => {
  const f=fixture(),matter=f.task()
  const topic=await f.threads.create({chatId:'owner',title:'bx',summary:'',facets:['task'],tags:[],private:false,episodes:[]})
  const a=await f.threads.addEntry({threadId:topic,kind:'fact',line:'DNS 使用双栈网络',source:'work',matterId:matter})
  const b=await f.threads.addEntry({threadId:topic,kind:'fact',line:'DNS 使用双栈网络',source:'work',matterId:matter})
  const filtered=makeThreadsStore(f.db,{filterSources:true})
  expect((await consolidateTopics({chatId:'owner',threads:filtered,sdkEval:null,log:()=>{},now:()=> '2026-11-13T00:00:00Z'})).merged).toBe(2)
  await f.threads.addEntry({threadId:topic,kind:'progress',line:'DNS 新进展',ts:'2026-11-14T00:00:00Z'})
  const next=await consolidateTopics({chatId:'owner',threads:f.threads,sdkEval:null,log:()=>{},now:()=> '2026-11-15T00:00:00Z'})
  expect(next.failed).toBe(0)
  expect((await f.threads.get(topic))!.summary).toContain('DNS 新进展')
  expect(await f.threads.getEntry(a)).toMatchObject({status:'superseded'})
  expect(await f.threads.getEntry(b)).toMatchObject({status:'superseded'})
})

it('owner extraction vocabulary never reads another conversation work metadata',async()=>{
  const f=fixture(),matter=f.task('visitor')
  const topic=await f.threads.create({chatId:'visitor',title:'visitor',summary:'',tags:['SECRET_VISITOR_TAG'],facets:['task'],private:false,episodes:[]})
  await f.threads.addEntry({threadId:topic,kind:'conclusion',line:'SECRET_VISITOR_RESULT',source:'work',matterId:matter})
  await f.messages.append({id:'vocab-chat',chatId:'owner',ts:'2026-11-11T00:00:00Z',direction:'in',kind:'text',source:'live',text:'明天去体检'})
  let prompt=''
  await runThreadsExtraction({chatId:'owner',threads:makeThreadsStore(f.db,{filterSources:true}),messages:f.messages,sdkEval:async p=>{prompt=p;return '{"ops":[]}'},recordEvent:async()=>{},log:()=>{}})
  expect(prompt).not.toContain('SECRET_VISITOR_')
})


it('deleting a source topic preserves dependent evidence as a fail-closed tombstone',async()=>{
  const f=fixture(),matter=f.task()
  const input={chatId:'owner',title:'bx',summary:'',facets:['task'] as const,tags:[],private:false,episodes:[]}
  const a=await f.threads.create({...input,facets:['task']}),b=await f.threads.create({...input,facets:['task'],title:'derived'})
  const source=await f.threads.addEntry({threadId:a,kind:'conclusion',line:'WORK_CANARY_DNS',source:'work',matterId:matter})
  const copy=await f.threads.addEntry({threadId:b,kind:'fact',line:'WORK_CANARY_DNS',derivedFrom:[source]})
  const result=await bubbleRoutes({db:f.db,ownerChatId:()=> 'owner'})['POST /v1/memory/topics/delete']!(new URLSearchParams(),{id:a},{tier:'admin',origin:'operator'})
  expect(result.status).toBe(200)
  expect(await f.threads.get(a)).toBeNull()
  expect(await f.threads.getEntry(copy)).not.toBeNull()
  expect(await makeThreadsStore(f.db,{filterSources:true}).getEntry(copy)).toBeNull()
  expect(f.db.query('SELECT source_id FROM topic_entry_sources WHERE entry_id=?').get(copy)).toEqual({source_id:source})
})


it('work context does not prevent completing unrelated chat commitments or topic status',async()=>{
  const f=fixture(),matter=f.task()
  const work=await f.threads.create({chatId:'owner',title:'bx',summary:'',facets:['task'],tags:[],private:false,episodes:[]})
  await f.threads.addEntry({threadId:work,kind:'conclusion',line:'工作结论',source:'work',matterId:matter})
  const chat=await f.threads.create({chatId:'owner',title:'包裹',summary:'',facets:['life'],tags:[],private:false,episodes:[]})
  const entry=await f.threads.addEntry({threadId:chat,kind:'commitment',line:'明天寄包裹'})
  await f.messages.append({id:'complete-chat',chatId:'owner',ts:'2026-11-11T00:00:00Z',direction:'in',kind:'text',source:'live',text:'包裹已寄出'})
  const result=await runThreadsExtraction({chatId:'owner',threads:makeThreadsStore(f.db,{filterSources:true}),messages:f.messages,sdkEval:async()=>JSON.stringify({ops:[{op:'update_entry',id:entry,status:'done'},{op:'update_topic',id:chat,status:'done',private:true}]}),recordEvent:async()=>{},log:()=>{}})
  expect(result.applied).toBe(2)
  expect(await f.threads.getEntry(entry)).toMatchObject({status:'done',line:'明天寄包裹',source:'chat'})
  expect(await f.threads.get(chat)).toMatchObject({status:'done',private:true})
})


it.each(['first','second'] as const)('new chat topics inherit every work context source: revoke %s',async which=>{
  const f=fixture(),first=f.task(),second=f.task()
  const existing=await f.threads.create({chatId:'owner',title:'bx',summary:'WORK_CONTEXT',facets:['task'],tags:[],private:false,episodes:[]})
  for(const matter of [first,second])await f.threads.addEntry({threadId:existing,kind:'conclusion',line:'WORK_CONTEXT',source:'work',matterId:matter})
  await f.messages.append({id:'derived-chat',chatId:'owner',ts:'2026-11-11T00:00:00Z',direction:'in',kind:'text',source:'live',text:'诊断还要记得'})
  const readable=makeThreadsStore(f.db,{filterSources:true})
  await runThreadsExtraction({chatId:'owner',threads:readable,messages:f.messages,sdkEval:async()=>JSON.stringify({ops:[{op:'create_topic',title:'DERIVED_CANARY',summary:'DERIVED_CANARY',aliases:['DERIVED_CANARY'],tags:['DERIVED_CANARY'],facets:['task'],private:false,entries:[{kind:'conclusion',line:'DERIVED_CANARY'}]}]}),recordEvent:async()=>{},log:()=>{}})
  const derived=(await f.threads.list('owner')).find(t=>t.title==='DERIVED_CANARY')!
  expect(await readable.get(derived.id)).not.toBeNull()
  expect(await readable.entries(derived.id)).toHaveLength(1)
  f.db.query('UPDATE matters SET owner_chat_id=? WHERE id=?').run('visitor',which==='first'?first:second)
  expect(await readable.get(derived.id)).toBeNull()
  expect(await readable.entries(derived.id)).toEqual([])
  expect(await f.threads.get(derived.id)).not.toBeNull()
})
