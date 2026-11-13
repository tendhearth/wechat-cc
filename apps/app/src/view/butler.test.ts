import { describe, expect, it } from 'vitest'
import { butlerActionError, butlerView, type CheckupViewT } from './butler'
const base: CheckupViewT = { target: { provider: 'fake', address: 'https://synthetic.invalid', model: 'synthetic', windowTokens: 8000, windowKnown: false }, profile: null, attempt: null, periodicProbe: false, suspectedChanged: false }
const profile: NonNullable<CheckupViewT['profile']> = { provider: 'fake', addressHash: 'synthetic', model: 'synthetic', windowTokens: 8000, windowKnown: false, reliableFillRatio: .1, stages: [{ fillRatio: .1, accuracy: 1 }], memory: 'weak', tools: 'flaky', toolAccuracy: .5, firstTextMedianMs: 100, completionMedianMs: 200, testedAt: '2026-11-12T00:00:00Z', ccVersion: 'test', short: true, seed: 113 }
describe('butler status words', () => {
  it('does not label a failed or cancelled measurement weak', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const v = butlerView({ ...base, attempt: { status, completedRequests: 0, totalRequests: 8, startedAt: '2026-11-12T00:00:00Z' } }, 'zh-Hans')
      expect(v.memory).toBe('还没体检'); expect(v.tools).toBe('还没体检'); expect(v.attempt).not.toContain('弱')
    }
  })
  it('uses plain words and the reassurance for measured weak memory', () => {
    const data: CheckupViewT = { ...base, profile }
    expect(butlerView(data, 'zh-Hans')).toMatchObject({ memory: '弱', tools: '偶尔出错', note: 'CC 会更常跟你确认。' })
    expect(butlerView({ ...data, profile: { ...profile, memory: 'good', tools: 'stable' } }, 'en')).toMatchObject({ memory: 'Good', tools: 'Steady', note: '' })
  })
})


it('explains a stale cost confirmation, busy checkup and invalid checkup request in plain words', () => {
  expect(butlerActionError('stale', 'zh-Hans')).toBe('体检设置或用量上限变了，请重新确认体检用量。')
  expect(butlerActionError('busy', 'zh-Hans')).toContain('体检已经在做了')
  expect(butlerActionError('checkup_invalid', 'zh-Hans')).toBe('这次体检没能开始，请重新打开体检再试。')
  expect(butlerActionError('checkup_invalid', 'en')).not.toMatch(/invalid|request|parameter/i)
})

it('uses the shared interview review verbatim',()=>{
  const review={title:'小禾（现在用的是 synthetic）',rows:[{key:'memory',label:'记性',detail:'一周内的事靠得住',grade:'好'}],care:'CC 会这样照顾它：拿不准时多问你一句。',status:'这个后端暂时没法体检：全局工具尚不能隔离。'}
  const result=butlerView({...base,review},'zh-Hans')
  expect(result.title).toBe(review.title)
  expect(result.rows).toEqual(review.rows)
  expect(result.note).toBe(review.care)
  expect(result.attempt).toBe(review.status)
})

it('explains the daily checkup limit instead of suggesting an immediate retry',()=>{
  expect(butlerActionError('checkup_rate_limited','zh-Hans')).toContain('每日体检次数已用完')
  expect(butlerActionError('checkup_rate_limited','en')).toContain('daily checkup limit')
})
