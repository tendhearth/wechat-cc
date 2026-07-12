/**
 * M1 intent-brokering end-to-end (AC1–AC5), deterministic.
 *
 * Composes the REAL modules — makeBroker (initiating) → makeAnswerIntent
 * (answering) → gateOutbound (disclosure) — with injected deterministic
 * judge + checker so the acceptance criteria are stable in CI. The /a2a/intent
 * HTTP transport is covered separately in a2a-server.test.ts; here `send`
 * invokes the answering handler directly to exercise the broker↔answer↔gate
 * composition.
 *
 * The same composition was verified against REAL Kimi over the REAL /a2a/intent
 * transport (scratchpad/social-m1-e2e.ts, 2026-07-12): AC1/AC2/AC3/AC5 all passed
 * — B's blurb never leaked the home address or the third party seeded in its facts.
 */
import { describe, expect, it } from 'vitest'
import { makeBroker } from './social-broker'
import { makeAnswerIntent } from './social-answer'
import type { IntentCard } from './a2a-intent'

const POLICY = '可透露兴趣/城市;不透露住址门牌、第三方。'
const recB = { id: 'ccb', name: '小B' } as any

// A permissive checker: passes text through unless it contains a seeded forbidden token.
const passingCheck = async (prompt: string) => {
  // Inspect ONLY the reviewed text (between triple quotes), NOT the whole prompt —
  // the prompt also embeds the policy, which itself names forbidden tokens.
  const reviewed = extractReviewed(prompt)
  const leak = /兰园路|门牌|老陈/.test(reviewed)
  return JSON.stringify(leak ? { violation: true, redacted: '', reasons: ['leak'] } : { violation: false, redacted: reviewed })
}
function extractReviewed(prompt: string): string {
  const m = prompt.match(/"""([\s\S]*?)"""/)
  return m ? m[1] : ''
}

function brokerWith(judge: (c: IntentCard) => Promise<{ match: 'yes' | 'no'; blurb?: string }>, confirmOwner: boolean, confirmPeer: boolean) {
  const answerB = makeAnswerIntent({ judge, policy: POLICY, cheapEval: passingCheck })
  return makeBroker({
    policy: POLICY,
    cheapEval: passingCheck,
    discover: async () => [recB],
    send: async (_hand, card) => answerB({ agent: { id: 'cca' } as any, card }),
    confirmWithOwner: async () => confirmOwner,
    confirmPeer: async () => confirmPeer,
  })
}

describe('M1 intent-brokering AC1–AC5', () => {
  it('AC1 happy path: match + both confirm → lit, blurb present', async () => {
    const judge = async () => ({ match: 'yes' as const, blurb: '南京摄影爱好者,周末想出门拍照' })
    const out = await brokerWith(judge, true, true).seek('找周末拍照搭子', { city: '南京' })
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
    expect(out.matched[0].blurb).toContain('摄影')
    expect(out.lit).toEqual(['ccb'])
  })

  it('AC2 non-match → nothing matched, owner never asked', async () => {
    let asked = 0
    const answerB = makeAnswerIntent({ judge: async () => ({ match: 'no' as const }), policy: POLICY, cheapEval: passingCheck })
    const out = await makeBroker({
      policy: POLICY, cheapEval: passingCheck,
      discover: async () => [recB],
      send: async (_h, card) => answerB({ agent: { id: 'cca' } as any, card }),
      confirmWithOwner: async () => { asked++; return true },
      confirmPeer: async () => true,
    }).seek('找打篮球的球友')
    expect(out.matched).toEqual([])
    expect(out.lit).toEqual([])
    expect(asked).toBe(0)
  })

  it('AC3 disclosure gate: a yes whose blurb leaks a home address is downgraded to no (never sent)', async () => {
    // Judge (adversarially) returns a blurb containing a forbidden home address.
    const judge = async () => ({ match: 'yes' as const, blurb: '住南京玄武区兰园路7号302,爱摄影' })
    const out = await brokerWith(judge, true, true).seek('找周末拍照搭子')
    // The gate blocks the leaky blurb → answer downgrades to match:no → nothing matched, nothing lit.
    expect(out.matched).toEqual([])
    expect(out.lit).toEqual([])
  })

  it('AC4 third-party hard rule: a blurb naming a third party is blocked', async () => {
    const judge = async () => ({ match: 'yes' as const, blurb: '我和好友老陈都爱摄影' })
    const out = await brokerWith(judge, true, true).seek('找周末拍照搭子')
    expect(out.matched).toEqual([])   // gate blocks "老陈" → downgraded, never revealed
  })

  it('AC5 no commit without dual confirm: peer declines → matched but not lit', async () => {
    const judge = async () => ({ match: 'yes' as const, blurb: '南京摄影爱好者' })
    const out = await brokerWith(judge, true, false).seek('找周末拍照搭子')
    expect(out.matched.map(m => m.hand)).toEqual(['ccb'])
    expect(out.lit).toEqual([])
  })
})
