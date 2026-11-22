import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCliSessionStore } from '../../adapters/store/cli-session-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { openTestDb } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { TERMINAL_SEARCH_SCAN_LIMIT, searchTerminalSpeech } from '../../features/roster/terminal-search'
import { createInternalApi } from './index'
import type { TerminalSearchHitT } from '@wechat-cc/protocol/desktop-api'

const owner = 'owner'
let db: ReturnType<typeof openTestDb>
let dir: string
let cursor: number
beforeEach(() => {
  db = openTestDb()
  dir = mkdtempSync(join(tmpdir(), 'terminal-search-test-'))
  cursor = 0
})
afterEach(() => { db.close(); removeTempDir(dir) })

function session(id: string, options: { owner?: string; cwd?: string; title?: string; machine?: string; origin?: string } = {}) {
  const cwd = options.cwd ?? process.cwd()
  const matters = makeMatterStore(db)
  const matter = matters.create({ kind: 'terminal', title: options.title ?? '花园', origin: 'cli', projectPath: cwd, ownerChatId: options.owner ?? null })
  matters.bind(matter.id, 'cli', id)
  makeCliSessionStore(db).touch({ session_id: id, source: 'codex', cwd, machine: options.machine ?? hostname(), origin_agent: options.origin }, Date.now())
  return matter.id
}

function add(matter: string, text: string, full?: string, kind = 'agent_message') {
  cursor++
  db.query("INSERT INTO matter_items(matter_id,seq,kind,status,payload_json,created_at,updated_at,cursor) VALUES (?,?,?,'completed',?,?,?,?)")
    .run(matter, cursor, kind, JSON.stringify({ text, full }), cursor, cursor, cursor)
}

it('只给 operator，范围、全文、子串、中文、表情和日志', async () => {
  const local = session('local')
  add(local, '缩写', '👨‍👩‍👧‍👦'.repeat(45) + '前缀X花园.[a]😀尾巴' + '😀'.repeat(45), 'user_message')
  add(local, '下一句 x花园.[A]')
  add(local, '最新一句 X花园.[a]')
  add(local, '工具里的 x花园.[a]', undefined, 'tool_call')
  for (const [id, options] of [
    ['other-owner', { owner: 'other' }],
    ['other-machine', { machine: 'remote-pc.example' }],
    ['forwarded', { origin: 'remote' }],
    ['temp', { cwd: '/tmp/transient-project' }],
    ['selftest', { title: 'selftest chat' }],
    ['gone', {}],
  ] as const) add(session(id, options), 'x花园.[a]')

  db.query('DELETE FROM cli_sessions WHERE session_id=?').run('gone')
  db.query("UPDATE matters SET state='done' WHERE id=?").run(local)

  const logs: unknown[] = []
  const api = createInternalApi({ stateDir: dir, daemonPid: 1, db, resolveAdminChatId: () => owner, log: (...args) => logs.push(args) })
  try {
    const running = await api.start()
    const operator = readFileSync(running.operatorTokenFilePath, 'utf8').trim()
    const trusted = readFileSync(running.tokenFilePath, 'utf8').trim()
    const path = '/v1/terminal/search?q=' + encodeURIComponent('  x花园.[a]  ')
    const request = (token: string, endpoint = path) => fetch(`http://127.0.0.1:${running.port}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } })
    const denied = await request('wrong')
    expect(denied.status).toBe(401)
    expect((await request(trusted)).status).toBe(403)
    const invalid = await request(operator, path + '&limit=0')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_request' })
    expect((await request(operator, '/v1/terminal/search?q=' + 'x'.repeat(201))).status).toBe(400)
    const response = await request(operator)
    expect(response.status).toBe(200)
    const { hits } = await response.json() as { hits: TerminalSearchHitT[] }
    expect(hits.map(hit => [hit.sessionId, hit.who])).toEqual([['local', 'said'], ['local', 'said'], ['local', 'you']])
    const hit = hits[2]!
    expect(hit.snippet.startsWith('…👨‍👩‍👧‍👦')).toBe(true)
    expect(hit.snippet.endsWith('😀…')).toBe(true)
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('X花园.[a]')
    expect(JSON.stringify(logs).includes('花园') || JSON.stringify(logs).includes('%E8%8A%B1')).toBe(false)
    expect(logs).toContainEqual(['TERMINAL_SEARCH', 'terminal search', { length: 7, hitCount: 3, elapsedMs: expect.any(Number) }])
    add(local, '第 4 句 x花园.[a]')
    expect((await (await request(operator)).json() as { hits: TerminalSearchHitT[] }).hits.map(hit => hit.at)).toEqual([11, 3, 2])

    db.transaction(() => {
      for (let n = 0; n < 55; n++) add(session(`extra-${n}`, { owner }), 'x花园.[a]')
    })()
    expect((await (await request(operator)).json() as { hits: TerminalSearchHitT[] }).hits).toHaveLength(20)
    expect((await (await request(operator, path + '&limit=1000')).json() as { hits: TerminalSearchHitT[] }).hits).toHaveLength(50)
  } finally { await api.stop() }
})

it('最多检查最近 20,000 步，且命中足够即停止', () => {
  expect(TERMINAL_SEARCH_SCAN_LIMIT).toBe(20_000)
  const local = session('local')
  db.transaction(() => {
    add(local, 'boundary')
    add(local, 'boundary')
    const filler = '活动记录'.repeat(250)
    for (let n = 0; n < TERMINAL_SEARCH_SCAN_LIMIT - 1; n++) add(local, filler)
  })()
  const start = performance.now()
  const hits = searchTerminalSpeech(db, owner, hostname(), 'boundary', 20)
  const elapsed = performance.now() - start
  console.info(`terminal search, 20,000 steps: ${elapsed.toFixed(1)}ms`)
  expect(hits.map(hit => hit.at)).toEqual([2])
  expect(elapsed).toBeLessThan(180)
  add(local, 'boundary')
  let projectLookups = 0
  const older = session('another')
  add(older, 'boundary')
  expect(searchTerminalSpeech(db, owner, hostname(), 'boundary', 1, path => { projectLookups++; return path ?? null }).map(hit => hit.sessionId)).toEqual(['another'])
  expect(projectLookups).toBe(1)
})
