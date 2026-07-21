import { describe, it, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeSeekStore } from './social-seek-store'

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

describe('makeSeekStore', () => {
  it('creates, lists newest-first, and updates status + peers', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeekStore(db)
    s.create({ id: 'k1', kind: 'seek', topic: '找个会修老相机的' })
    s.create({ id: 'k2', kind: 'fun', topic: '谁也在追这剧' })
    expect(s.list().map(r => r.id)).toEqual(['k2', 'k1'])   // newest first
    expect(s.get('k1')!.status).toBe('foraging')
    s.update('k1', { status: 'echoed', peersAsked: 5 })
    const r = s.get('k1')!
    expect(r.status).toBe('echoed'); expect(r.peers_asked).toBe(5)
    expect(r.updated_at >= r.created_at).toBe(true)
  })

  it('create (unchanged path) leaves redacted_topic null and status foraging', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeekStore(db)
    s.create({ id: 'c1', kind: 'seek', topic: 'x' })
    const r = s.get('c1')!
    expect(r.status).toBe('foraging')
    expect(r.redacted_topic).toBeNull()
  })

  it('propose persists redacted_topic/redacted_city and status proposed', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeekStore(db)
    s.propose({ id: 'p1', kind: 'seek', topic: '找搭子', redactedTopic: '找搭子【已清理】', redactedCity: '南京' })
    const r = s.get('p1')!
    expect(r.status).toBe('proposed')
    expect(r.redacted_topic).toBe('找搭子【已清理】')
    expect(r.redacted_city).toBe('南京')
  })

  it('propose without redactedCity leaves redacted_city null', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeekStore(db)
    s.propose({ id: 'p2', kind: 'seek', topic: '找搭子', redactedTopic: '找搭子【已清理】' })
    expect(s.get('p2')!.redacted_city).toBeNull()
  })

  it('transitions proposed -> foraging -> cancelled via update', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeSeekStore(db)
    s.propose({ id: 'p3', kind: 'seek', topic: '找搭子', redactedTopic: '找搭子【已清理】', redactedCity: '南京' })
    s.update('p3', { status: 'foraging' })
    expect(s.get('p3')!.status).toBe('foraging')
    s.update('p3', { status: 'cancelled' })
    expect(s.get('p3')!.status).toBe('cancelled')
  })
})
