import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'

describe('social state migration', () => {
  it('creates social_seek and social_echo tables', () => {
    const db = openDb({ path: ':memory:' })
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('social_seek','social_echo')")
      .all()
      .map(r => r.name)
      .sort()
    expect(tables).toEqual(['social_echo', 'social_seek'])
  })
})
