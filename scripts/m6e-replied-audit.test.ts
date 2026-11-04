import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/lib/db'
import { makeWorkbenchStore } from '../src/adapters/store/workbench/store'
import { makeMatterLog } from '../src/adapters/store/matter-log'
import { makeMatterStore } from '../src/adapters/store/matters-store'
import { auditReplied } from './m6e-replied-audit'

/** M6e 对账脚本:列 vs 步,两边分别数、不一样的逐行列出。 */
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

describe('m6e-replied-audit', () => {
  it('双写过的 ⇒ 两边一样;只有列(上线前的老 replied)⇒ 列出这一行', () => {
    dir = mkdtempSync(join(tmpdir(), 'm6e-audit-'))
    const path = join(dir, 'copy.db')
    const db = openDb({ path })
    const store = makeWorkbenchStore(db), log = makeMatterLog(db), matters = makeMatterStore(db)
    const task = () => {
      const id = store.create({ title: 't', path: '/w', providerId: 'claude', ownerChatId: null }).id
      db.query("UPDATE workbench_tasks SET status='running' WHERE id=?").run(id)
      const t = log.startTurn({ matterId: id, executor: 'claude' }); log.finishTurn(t.id, { status: 'completed' })
      return id
    }
    const both = task(); matters.setStatus(both, 'replied'); store.markReady(both)
    const columnOnly = task(); matters.setStatus(columnOnly, 'replied')
    task()
    db.close()
    const r = auditReplied(path)
    expect(r).toMatchObject({ matters: 3, columnReplied: 2, readySteps: 1, latestTurnReady: 1, legacyRepliedByColumn: 2, legacyRepliedByStep: 1 })
    expect(r.mismatches).toEqual([expect.objectContaining({ id: columnOnly, byColumn: 'replied', byStep: 'open', storedReplied: 1, latestReady: 0 })])
  })
})
