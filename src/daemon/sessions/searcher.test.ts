import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchAcrossSessions } from './searcher'
import { openTestDb, type Db } from '../../lib/db'

describe('searchAcrossSessions', () => {
  let stateDir: string
  let db: Db
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'searcher-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns empty for empty query', async () => {
    expect(await searchAcrossSessions('', { stateDir, db })).toEqual([])
    expect(await searchAcrossSessions('   ', { stateDir, db })).toEqual([])
  })

  it('returns empty when sessions.json has no aliases', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: {} }))
    expect(await searchAcrossSessions('anything', { stateDir, db })).toEqual([])
  })

  it('returns empty when alias maps to a missing jsonl', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { compass: { session_id: 's_nonexistent', last_used_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(await searchAcrossSessions('foo', { stateDir, db })).toEqual([])
  })

  // Set up a fake $HOME so the path resolver finds our test jsonl.
  // The searcher uses os.homedir() through path-resolver — we can't pass a
  // home override directly, but setting HOME env works for both macOS/linux.
  function withFakeHome(setup: (projects: string) => void, run: (home: string) => Promise<void>) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'searcher-home-'))
    const projects = join(fakeHome, '.claude', 'projects', 'test-cwd')
    mkdirSync(projects, { recursive: true })
    setup(projects)
    return run(fakeHome).finally(() => rmSync(fakeHome, { recursive: true, force: true }))
  }

  it('returns parsed turn + session_has_reply_tool=true when reply tool is used', async () => {
    await withFakeHome(
      (projects) => {
        const userTurn = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<wechat>我是谁</wechat>' }] } })
        const replyTurn = JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '你是 GSR' } },
          ]},
        })
        writeFileSync(join(projects, 'sid-A.jsonl'), userTurn + '\n' + replyTurn + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { _default: { session_id: 'sid-A', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('我是谁', { stateDir, home, db })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.alias).toBe('_default')
        expect(hits[0]!.turn).toBeTruthy()
        expect((hits[0]!.turn as any).type).toBe('user')
        expect(hits[0]!.session_has_reply_tool).toBe(true)
      },
    )
  })

  it('returns session_has_reply_tool=false when no reply tool is used', async () => {
    await withFakeHome(
      (projects) => {
        const turn = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] } })
        writeFileSync(join(projects, 'sid-B.jsonl'), turn + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { plain: { session_id: 'sid-B', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('plain', { stateDir, home, db })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.session_has_reply_tool).toBe(false)
      },
    )
  })

  it('short (<3 char) query falls back to the substring scan and still finds hits', async () => {
    await withFakeHome(
      (projects) => {
        const turn = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '去上海出差' }] } })
        writeFileSync(join(projects, 'sid-S.jsonl'), turn + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { s: { session_id: 'sid-S', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('上海', { stateDir, home, db })   // 2 chars — trigram can't
        expect(hits).toHaveLength(1)
        expect(hits[0]!.snippet).toContain('上海')
      },
    )
  })

  it('re-search after new turns are appended finds the new content (incremental FTS refresh)', async () => {
    await withFakeHome(
      (projects) => {
        const t1 = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first message' }] } })
        writeFileSync(join(projects, 'sid-I.jsonl'), t1 + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { inc: { session_id: 'sid-I', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        expect(await searchAcrossSessions('first message', { stateDir, home, db })).toHaveLength(1)
        const projects = join(home, '.claude', 'projects', 'test-cwd')
        const t2 = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'appended needle later' }] } })
        appendFileSync(join(projects, 'sid-I.jsonl'), t2 + '\n')
        const hits = await searchAcrossSessions('appended needle', { stateDir, home, db })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.turn_index).toBe(1)
      },
    )
  })

  it('honors the limit across FTS results', async () => {
    await withFakeHome(
      (projects) => {
        const lines = Array.from({ length: 5 }, (_, i) =>
          JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `repeated phrase ${i}` }] } }))
        writeFileSync(join(projects, 'sid-L.jsonl'), lines.join('\n') + '\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { lim: { session_id: 'sid-L', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        expect(await searchAcrossSessions('repeated phrase', { stateDir, home, db, limit: 2 })).toHaveLength(2)
      },
    )
  })

  it('survives malformed lines — turn is null, but hit still returned', async () => {
    await withFakeHome(
      (projects) => {
        // Hit "needle" inside a malformed (non-JSON) line. The searcher
        // shouldn't drop the match; it should set turn=null and let the
        // client decide to hide it in compact mode.
        writeFileSync(join(projects, 'sid-C.jsonl'), 'not-json-but-contains needle\n')
        writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
          version: 1, sessions: { x: { session_id: 'sid-C', last_used_at: '2026-04-29T00:00:00Z' } },
        }))
      },
      async (home) => {
        const hits = await searchAcrossSessions('needle', { stateDir, home, db })
        expect(hits).toHaveLength(1)
        expect(hits[0]!.turn).toBeNull()
      },
    )
  })
})
