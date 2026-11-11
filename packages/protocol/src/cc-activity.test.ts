import { describe, expect, it } from 'vitest'
import { createCCActivity, successfulCCResults } from './cc-activity.js'

const stream = (text = '', turn = 't') => ({ running: { turnId: turn }, events: text ? [{ id: 'e', turnId: turn, kind: 'agent_message', text }] : [] })
describe('CC acts only on current evidence', () => {
  it('does not speak on initial history, duplicate polls, another turn or a failed read', () => {
    const cc = createCCActivity()
    cc.observe(stream('old'), 0)
    expect(cc.phase({ connected: true, now: 0 })).toBe('thinking')
    cc.observe(stream('new'), 10)
    expect(cc.phase({ connected: true, now: 10 })).toBe('speaking')
    cc.observe(stream('new'), 800)
    expect(cc.phase({ connected: true, now: 911 })).toBe('thinking')
    cc.observe(stream(), 912)
    cc.observe(stream('new'), 913)
    expect(cc.phase({ connected: true, now: 913 })).toBe('thinking') // delta heartbeat cannot forget already seen output
    cc.observe({ running: { turnId: 't' }, events: [{ id: 'x', turnId: 'other', kind: 'agent_message', text: 'wrong turn' }] }, 920)
    expect(cc.phase({ connected: true, now: 920 })).toBe('thinking')
    cc.observe(null, 930)
    expect(cc.phase({ connected: true, now: 930 })).toBe('idle')
  })
  it('expires thinking without fresh evidence; consumes hidden/reduced text without replay', () => {
    const cc = createCCActivity()
    cc.observe(stream(), 0)
    expect(cc.phase({ connected: true, now: 2600 })).toBe('idle')
    cc.observe(stream('hidden'), 3000, false)
    cc.observe(stream('hidden'), 3010)
    expect(cc.phase({ connected: true, now: 3010 })).toBe('thinking')
    cc.observe({ running: null, events: [] }, 3020)
    expect(cc.phase({ connected: true, typing: true, now: 3020 })).toBe('listening')
    expect(cc.phase({ connected: false, typing: true, now: 3020 })).toBe('idle')
    expect(cc.phase({ connected: true, waiting: true, typing: true, now: 3020 })).toBe('idle')
  })
  it('does not treat a new turn history or changed scope as live speech', () => {
    const cc = createCCActivity()
    cc.observe({ ...stream(), scope: 'one' }, 0)
    cc.observe({ ...stream('history', 'new-turn'), scope: 'one' }, 1)
    expect(cc.phase({ connected: true, now: 1 })).toBe('thinking')
    cc.observe({ ...stream('other owner', 'new-turn'), scope: 'two' }, 2)
    expect(cc.phase({ connected: true, now: 2 })).toBe('thinking')
    cc.observe({ ...stream('paged old text', 'new-turn'), scope: 'two', activityReady: false }, 3)
    expect(cc.phase({ connected: true, now: 3 })).toBe('thinking')
  })
  it('only celebrates explicit successful outcomes, never a group label or disappearance', () => {
    const rows = ['working', 'waiting', 'replied', 'done', 'failed', 'stopped'].map(status => ({ id: status, status }))
    expect(successfulCCResults(rows).map(row => row.id)).toEqual(['replied', 'done'])
    expect(successfulCCResults([])).toEqual([])
  })
})
