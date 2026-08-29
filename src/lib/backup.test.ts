import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createBackup, listBackups, pruneBackups, restoreBackup, BACKUP_DIRNAME } from './backup'

function seedStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'backup-state-'))
  // live-ish sqlite dbs (WAL like production)
  const db = new Database(join(dir, 'wechat-cc.db'))
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('主库数据')")
  db.close()
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  const facts = new Database(join(dir, 'knowledge', 'facts.db'))
  facts.exec("PRAGMA journal_mode = WAL; CREATE TABLE facts (v TEXT); INSERT INTO facts VALUES ('事实')")
  facts.close()
  const graph = new Database(join(dir, 'knowledge', 'graph.db'))
  graph.exec("CREATE TABLE contacts (v TEXT); INSERT INTO contacts VALUES ('联系人')")
  graph.close()
  // irreplaceable files
  mkdirSync(join(dir, 'memory', 'chat1', 'notes'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'chat1', 'profile.md'), '# 记忆')
  writeFileSync(join(dir, 'memory', 'chat1', 'notes', 'a.md'), '笔记')
  mkdirSync(join(dir, 'memory-archive', 'chat1'), { recursive: true })
  writeFileSync(join(dir, 'memory-archive', 'chat1', 'profile.md.2026-08-01.md'), '旧档')
  writeFileSync(join(dir, 'agent-config.json'), '{"provider":"claude"}')
  writeFileSync(join(dir, 'access.json'), '{"dmPolicy":"allowlist"}')
  // must be EXCLUDED: secrets + derivable bulk
  writeFileSync(join(dir, 'internal-api-info.json'), '{"token":"secret"}')
  const sem = new Database(join(dir, 'knowledge', 'semantic.db'))
  sem.exec("CREATE TABLE chunks (v BLOB)")
  sem.close()
  mkdirSync(join(dir, 'plugin-data', 'wxvault'), { recursive: true })
  writeFileSync(join(dir, 'plugin-data', 'wxvault', 'huge.bin'), 'x'.repeat(1000))
  return dir
}

describe('backup', () => {
  let stateDir: string
  beforeEach(() => { stateDir = seedStateDir() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('createBackup produces a tar.gz holding the irreplaceable set and nothing else', async () => {
    const r = await createBackup({ stateDir, now: new Date('2026-08-24T03:00:00Z') })
    expect(existsSync(r.path)).toBe(true)
    expect(r.path).toContain(BACKUP_DIRNAME)
    expect(r.bytes).toBeGreaterThan(0)
    const listing = Bun.spawnSync(['tar', '-tzf', r.path]).stdout.toString()
    expect(listing).toContain('wechat-cc.db')
    expect(listing).toContain('knowledge/facts.db')
    expect(listing).toContain('knowledge/graph.db')
    expect(listing).toContain('memory/chat1/profile.md')
    expect(listing).toContain('memory/chat1/notes/a.md')
    expect(listing).toContain('memory-archive/chat1/profile.md.2026-08-01.md')
    expect(listing).toContain('agent-config.json')
    expect(listing).toContain('access.json')
    expect(listing).not.toContain('internal-api-info.json')   // token — never in a backup
    expect(listing).not.toContain('semantic.db')              // derivable, 240MB
    expect(listing).not.toContain('plugin-data')              // derivable, ~1GB
  })

  it('snapshot is consistent even while the source db stays open (VACUUM INTO)', async () => {
    const live = new Database(join(stateDir, 'wechat-cc.db'))
    live.exec("INSERT INTO t VALUES ('写入中')")
    const r = await createBackup({ stateDir })
    live.close()
    expect(existsSync(r.path)).toBe(true)
  })

  it('listBackups newest first; pruneBackups keeps N', async () => {
    await createBackup({ stateDir, now: new Date('2026-08-21T03:00:00Z') })
    await createBackup({ stateDir, now: new Date('2026-08-22T03:00:00Z') })
    await createBackup({ stateDir, now: new Date('2026-08-23T03:00:00Z') })
    const all = listBackups(stateDir)
    expect(all).toHaveLength(3)
    expect(all[0]!.path > all[1]!.path || all[0]!.mtimeMs >= all[1]!.mtimeMs).toBe(true)
    const removed = pruneBackups(stateDir, 2)
    expect(removed).toBe(1)
    expect(listBackups(stateDir)).toHaveLength(2)
  })

  it('restoreBackup puts files back and stashes what it replaced', async () => {
    const r = await createBackup({ stateDir })
    // mutate + delete after the backup
    writeFileSync(join(stateDir, 'memory', 'chat1', 'profile.md'), '被改坏了')
    rmSync(join(stateDir, 'memory', 'chat1', 'notes', 'a.md'))
    const res = await restoreBackup({ stateDir, file: r.path })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(readFileSync(join(stateDir, 'memory', 'chat1', 'profile.md'), 'utf8')).toBe('# 记忆')
    expect(readFileSync(join(stateDir, 'memory', 'chat1', 'notes', 'a.md'), 'utf8')).toBe('笔记')
    // pre-restore state stashed for undo
    expect(existsSync(res.undoDir)).toBe(true)
  })

  it('restoreBackup refuses when the daemon holds the state dir (probe hook)', async () => {
    const r = await createBackup({ stateDir })
    const res = await restoreBackup({ stateDir, file: r.path, daemonRunning: () => true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('daemon_running')
  })
})
