import { describe, expect, it } from 'vitest'
import { makeJudge } from './social-judge'

const card = {
  intent_id: 'i1',
  kind: 'seek' as const,
  topic: '找摄影搭子',
  hop: 1,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}

describe('makeJudge', () => {
  it('parses a clean {"match":"yes","blurb":"..."} verdict', async () => {
    const judge = makeJudge({
      policy: '兴趣可说；住址不可',
      runTurn: async () => JSON.stringify({ match: 'yes', blurb: '我主人也爱摄影' }),
    })
    const r = await judge(card)
    expect(r).toEqual({ match: 'yes', blurb: '我主人也爱摄影' })
  })

  it('tolerates stray prose around the JSON', async () => {
    const judge = makeJudge({
      policy: 'p',
      runTurn: async () => 'Sure, here is my answer:\n```json\n{"match":"yes","blurb":"也爱摄影"}\n```\nHope that helps!',
    })
    const r = await judge(card)
    expect(r).toEqual({ match: 'yes', blurb: '也爱摄影' })
  })

  it('parses a {"match":"no"} verdict with no blurb', async () => {
    const judge = makeJudge({
      policy: 'p',
      runTurn: async () => JSON.stringify({ match: 'no' }),
    })
    expect(await judge(card)).toEqual({ match: 'no' })
  })

  it('unparseable garbage → match:no (fail closed, never leak)', async () => {
    const judge = makeJudge({
      policy: 'p',
      runTurn: async () => 'this is not json at all',
    })
    expect(await judge(card)).toEqual({ match: 'no' })
  })

  it('a match:"yes" with no blurb field is still a yes (blurb optional)', async () => {
    const judge = makeJudge({
      policy: 'p',
      runTurn: async () => JSON.stringify({ match: 'yes' }),
    })
    expect(await judge(card)).toEqual({ match: 'yes' })
  })

  it('runTurn throwing → match:no (never surfaces the error as a match)', async () => {
    const judge = makeJudge({
      policy: 'p',
      runTurn: async () => { throw new Error('model down') },
    })
    expect(await judge(card)).toEqual({ match: 'no' })
  })

  it('builds the user prompt from topic + city when city is present', async () => {
    let capturedUserPrompt = ''
    const judge = makeJudge({
      policy: 'p',
      runTurn: async (_sys, user) => { capturedUserPrompt = user; return JSON.stringify({ match: 'no' }) },
    })
    await judge({ ...card, city: '南京' })
    expect(capturedUserPrompt).toContain('找摄影搭子')
    expect(capturedUserPrompt).toContain('南京')
  })

  it('includes the policy in the system prompt', async () => {
    let capturedSystemPrompt = ''
    const judge = makeJudge({
      policy: '住址绝不可说',
      runTurn: async (sys) => { capturedSystemPrompt = sys; return JSON.stringify({ match: 'no' }) },
    })
    await judge(card)
    expect(capturedSystemPrompt).toContain('住址绝不可说')
  })

  it('injects grounding text into the judge turn', async () => {
    let seenUser = ''
    const judge = makeJudge({
      runTurn: async (_s, u) => { seenUser = u; return '{"match":"yes","blurb":"我也爱摄影"}' },
      ground: async () => '主人相关事实：\n- 爱好: 摄影',
      policy: 'p',
    })
    const v = await judge({ intent_id: 'i', kind: 'seek', topic: '摄影', expires_at: 'x', hop: 1 } as any)
    expect(seenUser).toContain('摄影')
    expect(v.match).toBe('yes')
  })

  it('ground throwing degrades to empty grounding, still a verdict', async () => {
    const judge = makeJudge({
      runTurn: async () => '{"match":"no"}',
      ground: async () => { throw new Error('x') },
      policy: 'p',
    })
    const v = await judge({ intent_id: 'i', kind: 'seek', topic: 't', expires_at: 'x', hop: 1 } as any)
    expect(v.match).toBe('no')
  })

  it('ground throwing SYNCHRONOUSLY (non-async fn) degrades to empty grounding, judge still runs blind (does not short-circuit)', async () => {
    let runTurnCalled = false
    const judge = makeJudge({
      runTurn: async () => { runTurnCalled = true; return '{"match":"no"}' },
      ground: (() => { throw new Error('sync') }) as any,
      policy: 'p',
    })
    const v = await judge({ intent_id: 'i', kind: 'seek', topic: 't', expires_at: 'x', hop: 1 } as any)
    expect(v).toEqual({ match: 'no' })
    expect(runTurnCalled).toBe(true)
  })
})
