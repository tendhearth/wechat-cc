import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrations, openDb } from '../src/lib/db'
import { openSqlite } from '../src/lib/runtime/sqlite'
import { auditReplied } from './m6e-replied-audit'

/** M6e 对账脚本:列 vs 步,两边分别数、不一样的逐行列出。对的是 v102 删列以前的库副本(从真迁移造到 v101)。 */
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

describe('m6e-replied-audit', () => {
  it('双写过的 ⇒ 两边一样;只有列(上线前的老 replied)⇒ 列出这一行', () => {
    dir = mkdtempSync(join(tmpdir(), 'm6e-audit-'))
    const path = join(dir, 'copy.db')
    const db = openSqlite(path)
    db.exec('PRAGMA foreign_keys = ON;')
    for (const m of migrations.slice(0, 101)) m(db as never)
    db.exec('PRAGMA user_version = 101;')
    let cursor = 0
    const task = (id: string, status: string, ready: boolean) => {
      db.query("INSERT INTO matters(id,kind,title,state,status,created_at,updated_at) VALUES(?,'task','t','open',?,1,1)").run(id, status)
      db.query("INSERT INTO workbench_tasks(id,title,path,provider_id,status,created_at,updated_at) VALUES(?,'t','/w','claude','running',1,1)").run(id)
      db.query("INSERT INTO matter_turns(id,matter_id,seq,executor,status,started_at,cursor) VALUES(?,?,1,'claude','completed',1,?)").run(id + 't', id, ++cursor)
      if (ready) db.query(`INSERT INTO matter_items(matter_id,turn_id,seq,kind,status,item_key,payload_json,created_at,updated_at,cursor) VALUES(?,?,1,'system','completed',?,'{"ready":true}',1,1,?)`).run(id, id + 't', 'ready:' + id + 't', ++cursor)
    }
    task('0000000a', 'replied', true)
    task('0000000b', 'replied', false)
    task('0000000c', 'open', false)
    db.close()
    const r = auditReplied(path)
    expect(r).toMatchObject({ matters: 3, columnReplied: 2, readySteps: 1, latestTurnReady: 1, legacyRepliedByColumn: 2, legacyRepliedByStep: 1 })
    expect(r.mismatches).toEqual([expect.objectContaining({ id: '0000000b', byColumn: 'replied', byStep: 'open', storedReplied: 1, latestReady: 0 })])
  })
  it('过了 v102 的库(没有列)⇒ 列那一半是 null,不报不一样', () => {
    dir = mkdtempSync(join(tmpdir(), 'm6e-audit-'))
    const path = join(dir, 'copy.db')
    openDb({ path }).close()
    expect(auditReplied(path)).toMatchObject({ matters: 0, columnReplied: null, legacyRepliedByColumn: null, mismatches: [] })
  })
})
