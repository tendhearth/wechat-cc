import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db'
import { makeThreadsStore } from '../lib/threads-store'
import { runTopicNoiseCleanup } from './topic-noise-cleanup'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
async function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-topic-cleanup-')); dirs.push(dir)
  const path = join(dir, 'test.db'), journal = join(dir, 'undo.json'), db = openDb({ path }), store = makeThreadsStore(db)
  const topic = await store.create({ chatId: 'owner', title: 'cc', description: '个人项目', summary: 'Codex升至0.167.0自检过', facets: [], tags: [], private: false, episodes: [] })
  const entry = await store.addEntry({ threadId: topic, kind: 'progress', line: 'Codex升至0.167.0自检过' })
  db.close()
  return { dir, path, journal, entry }
}
it('CLI defaults to read-only dry-run, journals before apply, rolls back exactly and refuses journal reuse', async () => {
  const s = await seed(), before = readFileSync(s.path)
  expect(runTopicNoiseCleanup({ db: s.path, chatId: 'owner' })).toMatchObject({ mode: 'dry-run', changed: 1 })
  expect(readFileSync(s.path)).toEqual(before)
  expect(existsSync(s.journal)).toBe(false)
  expect(runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true, journal: s.journal })).toMatchObject({ mode: 'apply', changed: 1 })
  if (process.platform !== 'win32') expect(statSync(s.journal).mode & 0o777).toBe(0o600)
  expect(runTopicNoiseCleanup({ db: s.path, chatId: 'owner', rollback: true, journal: s.journal })).toMatchObject({ mode: 'rollback', changed: 1 })
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true, journal: s.journal })).toThrow()
  const db = openDb({ path: s.path })
  try { expect(db.query<{ status: string }, [string]>('SELECT status FROM topic_entries WHERE id=?').get(s.entry)?.status).toBe('live') } finally { db.close() }
})
it('invalid flag combinations, missing DB and foreign journals fail without creating or changing a DB', async () => {
  const s = await seed()
  const missing = join(s.dir, 'missing.db')
  expect(() => runTopicNoiseCleanup({ db: missing, chatId: 'owner' })).toThrow()
  expect(existsSync(missing)).toBe(false)
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true })).toThrow(/journal/)
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true, dryRun: true, journal: s.journal })).toThrow()
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true, rollback: true, journal: s.journal })).toThrow()
  runTopicNoiseCleanup({ db: s.path, chatId: 'owner', apply: true, journal: s.journal })
  const bytes = readFileSync(s.path)
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'foreign', rollback: true, journal: s.journal })).toThrow(/scope/)
  expect(readFileSync(s.path)).toEqual(bytes)
  const invalid = join(s.dir, 'invalid.json'); writeFileSync(invalid, '{"version":1}')
  expect(() => runTopicNoiseCleanup({ db: s.path, chatId: 'owner', rollback: true, journal: invalid })).toThrow()
})
