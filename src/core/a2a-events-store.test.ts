import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeA2AEventsStore } from './a2a-events-store'

describe('a2a-events-store', () => {
  it('append() inserts a row with id, ts, direction, agent_id, text, status', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'hello', status: 'ok' })
    const rows = db.query<{ direction: string; agent_id: string; text: string; status: string }, []>(
      'SELECT direction, agent_id, text, status FROM a2a_events'
    ).all()
    expect(rows).toEqual([{ direction: 'in', agent_id: 'alpha', text: 'hello', status: 'ok' }])
  })

  it('append() persists urgency and http_status when provided', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'out', agent_id: 'beta', text: 'x', status: 'http_error', http_status: 502, urgency: 'critical' })
    const r = db.query<{ urgency: string | null; http_status: number | null }, []>(
      'SELECT urgency, http_status FROM a2a_events'
    ).get()
    expect(r?.urgency).toBe('critical')
    expect(r?.http_status).toBe(502)
  })

  it('truncates text to 8KB', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    const long = 'x'.repeat(10_000)
    store.append({ direction: 'in', agent_id: 'alpha', text: long, status: 'ok' })
    const r = db.query<{ text: string }, []>('SELECT text FROM a2a_events').get()
    expect(r?.text.length).toBe(8192)
  })

  it('recentForAgent(id, limit) returns latest N for an agent, newest first', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    for (let i = 0; i < 5; i++) {
      store.append({ direction: 'in', agent_id: 'alpha', text: `msg-${i}`, status: 'ok' })
    }
    store.append({ direction: 'in', agent_id: 'beta', text: 'unrelated', status: 'ok' })
    const recent = store.recentForAgent('alpha', 3)
    expect(recent).toHaveLength(3)
    expect(recent.map(r => r.text)).toEqual(['msg-4', 'msg-3', 'msg-2'])
  })

  it('counts() returns per-agent direction counts', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'x', status: 'ok' })
    store.append({ direction: 'in', agent_id: 'alpha', text: 'y', status: 'ok' })
    store.append({ direction: 'out', agent_id: 'alpha', text: 'z', status: 'ok' })
    expect(store.counts('alpha')).toEqual({ inbound: 2, outbound: 1 })
  })
})
