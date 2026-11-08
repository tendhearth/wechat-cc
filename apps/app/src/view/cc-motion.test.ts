import { describe, expect, it } from 'vitest'
import { makeCCMotionTracker } from './cc-motion'

const message = (id: string, at = 100) => ({ id, at })
describe('CC motions follow new evidence once', () => {
  it('looks at each genuinely new topic once, with a cooldown and no hidden replay', () => {
    const track = makeCCMotionTracker()
    track.read({ active: true, topics: ['history'] })
    expect(track.read({ active: true, topics: ['new'] })).toEqual({ behavior: 'look', eventKey: 'topic:new' })
    expect(track.read({ active: true, topics: ['new'] })).toBeUndefined()
    expect(track.read({ active: true, topics: ['too-soon'] })).toBeUndefined()
    track.read({ active: false, topics: ['hidden'] })
    expect(track.read({ active: true, topics: ['hidden'] })).toBeUndefined()
  })
  it('does not turn late initial topic history into an arrival', () => {
    const track = makeCCMotionTracker()
    track.read({ active: true })
    expect(track.read({ active: true, topics: ['late-history'] })).toBeUndefined()
    track.read({ active: false }); track.read({ active: true })
    expect(track.read({ active: true, topics: ['late-resume-history'] })).toBeUndefined()
  })
  it('celebrates an observed successful transition once, never an edit, failure, stop or late result history', () => {
    const track = makeCCMotionTracker(), row = (status: string, at: number) => [{ id: 'work', at, status }]
    track.read({ active: true, outcomes: row('working', 1) })
    expect(track.read({ active: true, outcomes: row('done', 2) })).toEqual({ behavior: 'done', eventKey: 'done:work:2' })
    expect(track.read({ active: true, outcomes: row('done', 3) })).toBeUndefined()
    track.read({ active: true, outcomes: row('working', 4) })
    expect(track.read({ active: true, outcomes: row('failed', 5) })).toBeUndefined()
    track.read({ active: true, outcomes: row('working', 6) })
    expect(track.read({ active: true, outcomes: row('stopped', 7) })).toBeUndefined()
    track.read({ active: false }); track.read({ active: true })
    expect(track.read({ active: true, outcomes: row('done', 8) })).toBeUndefined()
  })
  it('baselines each source independently and ignores repeated snapshots and older history', () => {
    const track = makeCCMotionTracker()
    expect(track.read({ active: true, received: [message('old')] })).toBeUndefined()
    expect(track.read({ active: true, received: [message('old')], done: [message('finished')] })).toBeUndefined()
    expect(track.read({ active: true, received: [message('older', 50), message('old')], done: [message('finished')] })).toBeUndefined()
    expect(track.read({ active: true, received: [message('old'), message('new', 110)] })).toEqual({ behavior: 'receive', eventKey: 'receive:new:110' })
    expect(track.read({ active: true, received: [message('new', 110)] })).toBeUndefined()
  })
  it('recognizes different event identities sharing a timestamp without replaying the same one', () => {
    const track = makeCCMotionTracker()
    track.read({ active: true, received: [message('first')] })
    expect(track.read({ active: true, received: [message('first'), message('second')] })).toEqual({ behavior: 'receive', eventKey: 'receive:second:100' })
    expect(track.read({ active: true, received: [message('second'), message('first')] })).toBeUndefined()
  })
  it('prioritizes new waiting requests and consumes simultaneous events without replaying them', () => {
    const track = makeCCMotionTracker()
    track.read({ active: true, received: [], done: [], waiting: [] })
    expect(track.read({ active: true, received: [message('reply')], done: [message('task')], waiting: ['request'] })).toEqual({ behavior: 'wait', eventKey: 'wait:request' })
    expect(track.read({ active: true, received: [message('reply')], done: [message('task')], waiting: ['request'] })).toBeUndefined()
    expect(track.read({ active: true, done: [message('task'), message('another', 120)], waiting: ['request'] })).toBeUndefined()
  })
  it('does not replay accumulated events after reduce motion, background, route blur or disconnection', () => {
    const track = makeCCMotionTracker()
    track.read({ active: true, received: [] })
    track.read({ active: false, received: [message('while-away')] })
    expect(track.read({ active: true, received: [message('return-snapshot', 150)] })).toBeUndefined()
    expect(track.read({ active: true, received: [message('fresh', 160)] })).toEqual({ behavior: 'receive', eventKey: 'receive:fresh:160' })
  })
})
