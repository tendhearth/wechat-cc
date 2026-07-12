import { describe, expect, it } from 'vitest'
import { gateOutbound } from './a2a-disclosure'

const policy = '可透露:兴趣爱好、大致意向、所在城市。不透露:住址、收入、健康、第三方好友。'

describe('gateOutbound', () => {
  it('passes clean, policy-compliant text unchanged', async () => {
    const cheapEval = async () => JSON.stringify({ violation: false, redacted: '我主人也爱摄影,周末常拍' })
    const r = await gateOutbound('我主人也爱摄影,周末常拍', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(true)
    expect(r.redacted).toContain('摄影')
  })
  it('blocks/redacts a forbidden disclosure (home address)', async () => {
    const cheapEval = async () => JSON.stringify({ violation: true, redacted: '我主人也爱摄影', reasons: ['泄露住址'] })
    const r = await gateOutbound('我主人住玄武区XX路12号,爱摄影', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
    expect(r.redacted).not.toContain('XX路')
    expect(r.violations.length).toBeGreaterThan(0)
  })
  it('fails CLOSED when the checker returns unparseable output', async () => {
    const cheapEval = async () => 'not json at all'
    const r = await gateOutbound('anything', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
  })
  it('fails CLOSED when the checker throws', async () => {
    const cheapEval = async () => { throw new Error('model down') }
    const r = await gateOutbound('anything', { policy, peerNames: [], cheapEval })
    expect(r.ok).toBe(false)
  })
})
