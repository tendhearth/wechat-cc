import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../lib/db'
import { refreshSessionFtsIndex, ftsSearchSessions, FTS_LINE_MAX } from './fts-index'

describe('session FTS index', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-fts-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function session(name: string, lines: string[]) {
    const path = join(dir, `${name}.jsonl`)
    writeFileSync(path, lines.map(l => l + '\n').join(''))
    return { alias: name, session_id: `sid-${name}`, path }
  }

  it('indexes a jsonl line-by-line and finds CJK + ascii matches (trigram needs ≥3 chars)', () => {
    const s = session('a', ['{"text":"我在上海工作"}', '{"text":"plain english needle"}'])
    refreshSessionFtsIndex(db, [s])
    expect(ftsSearchSessions(db, '上海工作', 10)).toEqual([{ alias: 'a', session_id: 'sid-a', turn_index: 0 }])
    expect(ftsSearchSessions(db, 'needle', 10)).toEqual([{ alias: 'a', session_id: 'sid-a', turn_index: 1 }])
    expect(ftsSearchSessions(db, '北京城里', 10)).toEqual([])
  })

  it('incremental: appending lines only indexes the new lines, old rows not duplicated', () => {
    const s = session('a', ['{"text":"第一条消息"}'])
    refreshSessionFtsIndex(db, [s])
    appendFileSync(s.path, '{"text":"第二条消息"}\n')
    refreshSessionFtsIndex(db, [s])
    expect(ftsSearchSessions(db, '第二条', 10)).toEqual([{ alias: 'a', session_id: 'sid-a', turn_index: 1 }])
    // "消息" appears in both lines — exactly two rows, no duplicates from re-refresh
    refreshSessionFtsIndex(db, [s])
    expect(ftsSearchSessions(db, '条消息', 10)).toHaveLength(2)
  })

  it('truncated/rewritten file (smaller byte_size) → reindexed from scratch', () => {
    const s = session('a', ['{"text":"旧的很长很长的内容啊啊啊"}', '{"text":"第二行内容"}'])
    refreshSessionFtsIndex(db, [s])
    writeFileSync(s.path, '{"text":"全新内容"}\n')   // rewritten, shorter
    refreshSessionFtsIndex(db, [s])
    expect(ftsSearchSessions(db, '全新内容', 10)).toEqual([{ alias: 'a', session_id: 'sid-a', turn_index: 0 }])
    expect(ftsSearchSessions(db, '第二行', 10)).toEqual([])   // stale rows gone
  })

  it('caps stored text at FTS_LINE_MAX chars but still matches within the cap', () => {
    const inside = '目标词组'
    const line = inside + 'x'.repeat(FTS_LINE_MAX) + '尾部词组'
    const s = session('a', [line])
    refreshSessionFtsIndex(db, [s])
    expect(ftsSearchSessions(db, '目标词组', 10)).toHaveLength(1)
    expect(ftsSearchSessions(db, '尾部词组', 10)).toEqual([])   // beyond the cap — not stored
  })

  it('phrase-literal quoting: FTS operators and quotes in the query do not throw', () => {
    const s = session('a', ['{"text":"a AND b - c:\\"quoted\\""}'])
    refreshSessionFtsIndex(db, [s])
    expect(() => ftsSearchSessions(db, 'AND b - c:"', 10)).not.toThrow()
    expect(ftsSearchSessions(db, 'a AND b', 10)).toHaveLength(1)
  })

  it('missing file → skipped without throwing, state untouched', () => {
    const s = { alias: 'gone', session_id: 'sid-gone', path: join(dir, 'nope.jsonl') }
    expect(() => refreshSessionFtsIndex(db, [s])).not.toThrow()
    expect(ftsSearchSessions(db, 'anything', 10)).toEqual([])
  })

  it('multiple sessions: hits carry the right alias/session and respect limit', () => {
    const a = session('a', ['{"text":"共同词汇 in a"}'])
    const b = session('b', ['{"text":"共同词汇 in b"}'])
    refreshSessionFtsIndex(db, [a, b])
    const all = ftsSearchSessions(db, '共同词汇', 10)
    expect(all.map(h => h.alias).sort()).toEqual(['a', 'b'])
    expect(ftsSearchSessions(db, '共同词汇', 1)).toHaveLength(1)
  })
})
