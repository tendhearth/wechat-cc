import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeProjectMemory, projectIdentity, resolveProjectTopic, renderProjectMemory, type ProjectIdentity } from './project-memory'
import type { MatchTopic } from '../../domain/topic-match'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { makeMatterLog } from '../../adapters/store/matter-log'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const temp = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-memory-'))); dirs.push(d); return d }
const repo: ProjectIdentity = { roots: ['/Users/u/Documents/tendhearth/wechat-cc', '/Users/u/Documents/tendhearth/wt-xxx'], names: ['wechat-cc'], key: '/Users/u/Documents/tendhearth/wechat-cc/.git' }
const topic = (id = 'cc', title = 'Tendhearth CC', aliases = ['wechat-cc']): MatchTopic => ({ id, title, aliases, tags: [], summary: 'PRIVATE SUMMARY', lastActive: '', entries: [{ id: 'e1', kind: 'progress', line: '待补会话入口', body: 'secret@example.invalid', due: null, updatedTs: '2026-11-08' }] })

describe('cwd → topic conservative evaluation table', () => {
  it.each([
    ['/Users/u/Documents/tendhearth/wechat-cc', repo, 'cc'],
    ['/Users/u/Documents/tendhearth/wt-xxx/src', repo, 'cc'],
    ['/Users/u/Documents/Project Nategu/check', { roots: ['/Users/u/Documents/Project Nategu/check'], names: ['check'], key: '/check/.git' }, null],
    ['/tmp', null, null],
  ])('%s maps only from project evidence', (cwd, identity, expected) => {
    expect(resolveProjectTopic(cwd, identity, [topic()], []).topicId).toBe(expected)
  })
  it('exact names only; conflicting history or aliases abstain', () => {
    expect(resolveProjectTopic(repo.roots[0]!, repo, [topic('near', 'wechat-cc-helper', [])], []).topicId).toBeNull()
    expect(resolveProjectTopic(repo.roots[0]!, repo, [topic(), topic('other')], []).reason).toBe('ambiguous')
    expect(resolveProjectTopic(repo.roots[0]!, repo, [topic(), topic('bx', 'bx', [])], [{ topicId: 'bx', cwd: repo.roots[1]! }]).reason).toBe('ambiguous')
  })
  it('history works without name match; path boundaries prevent sibling confusion', () => {
    expect(resolveProjectTopic(repo.roots[1]! + '/src', repo, [topic('history', 'CC 开发', [])], [{ topicId: 'history', cwd: repo.roots[0]! + '/src' }])).toMatchObject({ topicId: 'history', reason: 'history' })
    expect(resolveProjectTopic('/tmp/ab', null, [topic()], [{ topicId: 'cc', cwd: '/tmp/a' }]).topicId).toBeNull()
    expect(resolveProjectTopic('/project', null, [topic()], [{ topicId: 'cc', cwd: '/project' }]).topicId).toBe('cc')
    expect(resolveProjectTopic('/project/other', null, [topic()], [{ topicId: 'cc', cwd: '/project' }]).topicId).toBeNull()
  })
})

it('slow identity returns no context and logs timeout once', async () => {
  const db = openTestDb(), threads = makeThreadsStore(db), logs: string[] = []
  try {
    const id = await threads.create({ chatId: 'owner', title: 'wechat-cc', private: false, summary: '', facets: [], tags: [], episodes: [] })
    await threads.addEntry({ threadId: id, kind: 'progress', line: '尚未完成' })
    const get = makeProjectMemory({ db, config: () => ({ enabled: true, owner: 'owner' }), identity: () => new Promise(() => {}), timeoutMs: 20, log: l => logs.push(l) })
    expect(await get({ source: 'claude', session_id: 'slow', cwd: '/repo' })).toEqual({ context: '', reason: 'timeout' })
    expect(logs).toHaveLength(1); expect(logs[0]).toContain('chars=0 reason=timeout')
  } finally { db.close() }
})

it('real terminal provenance survives session pruning and consolidation; marked-wrong source loses mapping', async () => {
  const db = openTestDb(), threads = makeThreadsStore(db), matters = makeMatterStore(db)
  try {
    const turns = makeTerminalTurnLog({ db, matters, log: makeMatterLog(db) })
    turns.event({ source: 'claude', kind: 'prompt', session_id: 'history-session', cwd: repo.roots[0]! }, 1000)
    const matterId = matters.findBySurface('cli', 'history-session')!.id
    expect(matters.get(matterId)?.ownerChatId).toBeNull() // actual terminal matters are not chat-bound
    const id = await threads.create({ chatId: 'owner', title: 'CC 开发', aliases: [], summary: '', private: false, facets: [], tags: [], episodes: [] })
    const source = await threads.addEntry({ threadId: id, kind: 'progress', line: '历史来源', source: 'work', matterId })
    const replacement = await threads.addEntry({ threadId: id, kind: 'progress', line: '整理后的进展' })
    await threads.updateEntry(source, { status: 'superseded', supersededBy: replacement })
    db.query('DELETE FROM cli_sessions WHERE session_id=?').run('history-session')
    const get = makeProjectMemory({ db, config: () => ({ enabled: true, owner: 'owner' }), identity: async () => repo, log: () => {} })
    const req = { source: 'codex' as const, session_id: 'new-session', cwd: repo.roots[1]! + '/src' }
    expect(await get(req)).toMatchObject({ reason: 'history', context: expect.stringContaining('整理后的进展') })
    await threads.addEntry({ threadId: id, kind: 'fact', line: '这个话题的另一条事实' })
    await threads.updateEntry(replacement, { status: 'superseded' }) // existing mark-wrong path
    expect(await get(req)).toMatchObject({ reason: 'no_match', context: '' })
    await threads.updateEntry(replacement, { status: 'live' })
    await threads.updateEntry(source, { supersededBy: null })
    expect(await get(req)).toMatchObject({ reason: 'no_match', context: '' })
  } finally { db.close() }
})

it('history from an independent nested git repository does not map its parent repository', async () => {
  const d = temp(), outer = join(d, 'outer'), nested = join(outer, 'nested')
  mkdirSync(join(outer, '.git'), { recursive: true }); mkdirSync(join(nested, '.git'), { recursive: true })
  const db = openTestDb(), threads = makeThreadsStore(db), matters = makeMatterStore(db)
  try {
    const turns = makeTerminalTurnLog({ db, matters, log: makeMatterLog(db) })
    turns.event({ source: 'claude', kind: 'prompt', session_id: 'nested-session', cwd: nested }, 1000)
    const m = matters.findBySurface('cli', 'nested-session')!
    const id = await threads.create({ chatId: 'owner', title: '嵌套项目', private: false, summary: '', facets: [], tags: [], episodes: [] })
    await threads.addEntry({ threadId: id, kind: 'progress', line: '子项目的事', source: 'work', matterId: m.id })
    const get = makeProjectMemory({ db, config: () => ({ enabled: true, owner: 'owner' }), log: () => {} })
    expect(await get({ source: 'claude', session_id: 'outer-session', cwd: outer })).toEqual({ context: '', reason: 'no_match' })
  } finally { db.close() }
})

it.each(['prompt', 'stop'] as const)('pruned remote sessions with the same absolute path never become local provenance: %s', async kind => {
  const db = openTestDb(), threads = makeThreadsStore(db), matters = makeMatterStore(db)
  try {
    const turns = makeTerminalTurnLog({ db, matters, log: makeMatterLog(db) })
    turns.event({ source: 'codex', kind, session_id: 'remote-session', cwd: repo.roots[0]!, origin_agent: 'remote-agent', machine: 'other-machine' }, 1000)
    const m = matters.findBySurface('cli', 'remote-session')!
    const id = await threads.create({ chatId: 'owner', title: '远端项目', private: false, summary: '', facets: [], tags: [], episodes: [] })
    await threads.addEntry({ threadId: id, kind: 'progress', line: '远端的事情', source: 'work', matterId: m.id })
    db.query('DELETE FROM cli_sessions WHERE session_id=?').run('remote-session')
    const get = makeProjectMemory({ db, config: () => ({ enabled: true, owner: 'owner' }), identity: async () => repo, log: () => {} })
    expect(await get({ source: 'codex', session_id: 'local-session', cwd: repo.roots[0]! })).toEqual({ context: '', reason: 'no_match' })
  } finally { db.close() }
})

it.each(['missing', 'cycle', 'cross-topic'] as const)('invalid replacement chain cannot establish a project mapping: %s', async shape => {
  const db = openTestDb(), threads = makeThreadsStore(db), matters = makeMatterStore(db)
  try {
    const turns = makeTerminalTurnLog({ db, matters, log: makeMatterLog(db) })
    turns.event({ source: 'claude', kind: 'prompt', session_id: 'history', cwd: repo.roots[0]! }, 1000)
    const thread = (title: string) => threads.create({ chatId: 'owner', title, private: false, summary: '', facets: [], tags: [], episodes: [] })
    const id = await thread('无名称命中')
    const source = await threads.addEntry({ threadId: id, kind: 'progress', line: '旧来源', source: 'work', matterId: matters.findBySurface('cli', 'history')!.id })
    await threads.addEntry({ threadId: id, kind: 'fact', line: '仍有效但无项目来源' })
    const replacement = shape === 'missing' ? 'missing-entry' : await threads.addEntry({ threadId: shape === 'cross-topic' ? await thread('其他话题') : id, kind: 'progress', line: '替代条目' })
    await threads.updateEntry(source, { status: 'superseded', supersededBy: replacement })
    if (shape === 'cycle') await threads.updateEntry(replacement, { status: 'superseded', supersededBy: source })
    const get = makeProjectMemory({ db, config: () => ({ enabled: true, owner: 'owner' }), identity: async () => repo, log: () => {} })
    expect(await get({ source: 'claude', session_id: 'new', cwd: repo.roots[0]! })).toEqual({ context: '', reason: 'no_match' })
  } finally { db.close() }
})

it('resolves actual linked worktree, nested cwd, canonical main root and remote basename', async () => {
  const d = temp(), main = join(d, 'local-name'), wt = join(d, 'wt-unrelated')
  mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true }); mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n url = git@github.com:owner/wechat-cc.git\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'w')}\n`)
  writeFileSync(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
  writeFileSync(join(main, '.git', 'worktrees', 'w', 'gitdir'), `${join(wt, '.git')}\n`)
  const identity = await projectIdentity(join(wt, 'src'))
  expect(identity?.names).toEqual(expect.arrayContaining(['local-name', 'wechat-cc']))
  expect(identity?.names).not.toContain('wt-unrelated')
  expect(identity?.roots).toEqual(expect.arrayContaining([main, wt]))
  expect(await projectIdentity(join(d, 'unrelated'))).toBeNull()
})

it('renders only index lines, prioritizes unfinished work and stays within 1200 codepoints', () => {
  const t = topic()
  t.entries = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...t.entries[0]!, id: `f${i}`, kind: 'fact' as const, line: '普通事实'.repeat(80), updatedTs: '2026-11-09' })),
    { ...t.entries[0]!, id: 'promise', kind: 'commitment', line: '答应补验收', updatedTs: '2020-01-01' },
    { ...t.entries[0]!, id: 'progress', line: '尚未完成设置入口', updatedTs: '2020-01-01' },
  ]
  const out = renderProjectMemory(t)
  expect(out.startsWith('CC 记下的这个项目的近况,可能过时,以仓库为准')).toBe(true)
  expect(out).toContain('答应补验收'); expect(out).toContain('尚未完成设置入口')
  expect(out).not.toContain('secret@example.invalid'); expect(out).not.toContain('PRIVATE SUMMARY')
  expect([...out].length).toBeLessThanOrEqual(1200)
  expect(out.indexOf('答应补验收')).toBeLessThan(out.indexOf('普通事实'))
})

it('daemon filters private/done/foreign/wrong entries and observes switch immediately', async () => {
  const db = openTestDb(), threads = makeThreadsStore(db), logs: string[] = []
  try {
    const id = await threads.create({ chatId: 'owner', title: 'wechat-cc', summary: 'secret summary', private: false, facets: [], tags: [], episodes: [] })
    const entry = await threads.addEntry({ threadId: id, kind: 'commitment', line: '补验收', body: 'secret body' })
    const foreign = await threads.create({ chatId: 'other', title: 'wechat-cc', summary: '', private: false, facets: [], tags: [], episodes: [] })
    await threads.addEntry({ threadId: foreign, kind: 'progress', line: '别人的事' })
    let enabled = true
    const get = makeProjectMemory({ db, config: () => ({ enabled, owner: 'owner' }), identity: async () => repo, log: line => logs.push(line) })
    const req = { source: 'claude' as const, session_id: 'session-1', cwd: repo.roots[0]! }
    expect((await get(req)).context).toContain('补验收')
    await threads.updateEntry(entry, { status: 'superseded' })
    expect((await get(req)).context).toBe('')
    await threads.addEntry({ threadId: id, kind: 'progress', line: '有效进展' })
    await threads.update(id, { private: true }); expect((await get(req)).context).toBe('')
    await threads.update(id, { private: false, status: 'done' }); expect((await get(req)).context).toBe('')
    await threads.update(id, { status: 'active' }); enabled = false
    expect(await get(req)).toMatchObject({ context: '', reason: 'disabled' })
    expect(logs.every(l => l.includes('session="session-1"') && /chars=\d+/.test(l) && l.includes('reason='))).toBe(true)
    expect(logs.join('\n')).not.toContain('secret')
  } finally { db.close() }
})
