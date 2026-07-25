import { describe, expect, it } from 'vitest'
import { makeAnswerIntent } from './social-answer'

const base = { policy: '兴趣可说;住址不可', cheapEval: async () => JSON.stringify({ violation: false, redacted: '我主人也爱摄影' }) }
const card = { intent_id: 'i1', kind: 'seek' as const, topic: '找摄影搭子', hop: 1, expires_at: new Date(Date.now()+60000).toISOString() }

describe('makeAnswerIntent', () => {
  it('yes + clean blurb passes through the gate', async () => {
    const answer = makeAnswerIntent({ ...base, judge: async () => ({ match: 'yes', blurb: '我主人也爱摄影' }) })
    const r = await answer({ agent: { id: 'cca' } as any, card })
    expect(r).toMatchObject({ intent_id: 'i1', match: 'yes' })
    expect(r.blurb).toContain('摄影')
  })
  it('non-match returns a silent no with no blurb', async () => {
    const answer = makeAnswerIntent({ ...base, judge: async () => ({ match: 'no' }) })
    expect(await answer({ agent: { id: 'cca' } as any, card })).toEqual({ intent_id: 'i1', match: 'no' })
  })
  it('DOWNGRADES to no when the gate blocks the blurb (never leak)', async () => {
    const answer = makeAnswerIntent({
      ...base,
      cheapEval: async () => JSON.stringify({ violation: true, redacted: '', reasons: ['住址'] }),
      judge: async () => ({ match: 'yes', blurb: '我主人住XX路,爱摄影' }),
    })
    const r = await answer({ agent: { id: 'cca' } as any, card })
    expect(r).toEqual({ intent_id: 'i1', match: 'no' })   // gate block => no leak, no match
  })
})
