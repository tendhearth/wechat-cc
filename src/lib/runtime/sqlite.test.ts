import { expect, it } from 'vitest'
import { openSqlite } from './sqlite'

it('reports native transaction state for manual, nested, committed and rolled back transactions', () => {
  const db = openSqlite(':memory:')
  try {
    expect(db.inTransaction).toBe(false)
    db.exec('BEGIN')
    expect(db.inTransaction).toBe(true)
    db.exec('SAVEPOINT nested')
    expect(db.inTransaction).toBe(true)
    db.exec('ROLLBACK TO nested; RELEASE nested')
    expect(db.inTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(db.inTransaction).toBe(false)
    db.transaction(() => {
      expect(db.inTransaction).toBe(true)
      db.transaction(() => { expect(db.inTransaction).toBe(true) })()
      expect(db.inTransaction).toBe(true)
    })()
    expect(db.inTransaction).toBe(false)
    expect(() => db.transaction(() => { throw new Error('rollback') })()).toThrow('rollback')
    expect(db.inTransaction).toBe(false)
  } finally { db.close() }
})
