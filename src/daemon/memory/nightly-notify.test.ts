import { describe, it, expect } from 'vitest'
import { noticeItems, composeNotice, formatNightlyReply, FIRST_RUN_NOTICE } from './nightly-notify'
import type { AppliedOp } from './nightly-ops'

const applied: AppliedOp[] = [
  { kind: 'add', id: 'e1', section: '承诺', text: '周五前给 X 回话' },
  { kind: 'add', id: 'e2', section: '关于你', text: '养了只猫' },
  { kind: 'update', id: 'b1', section: '偏好', text: '先上线再优化', before: '先打磨再上线', reversal: true },
  { kind: 'update', id: 'b2', section: '偏好', text: '回复直接一点', before: '回复直接', reversal: false },
  { kind: 'remove', id: 'd1', section: '近况', text: '在准备搬家', reason: '之后没再提' },
  { kind: 'expire', id: 'c1', section: '承诺', text: '旧承诺', reason: 'commitment_past_due' },
]

describe('nightly notice', () => {
  it('only new commitments, reversals of 偏好/关于你, and model removals are worth telling', () => {
    expect(noticeItems(applied)).toEqual([
      { label: '新记下', text: '周五前给 X 回话' },
      { label: '改了', text: '先上线再优化', before: '先打磨再上线' },
      { label: '删了', text: '在准备搬家', reason: '之后没再提' },
    ])
  })
  it('composes at most three lines and points to 查看记忆 for the rest', () => {
    const items = [...noticeItems(applied), { label: '新记下' as const, text: '第四条' }]
    const t = composeNotice(items, false)!
    expect(t).toBe([
      '昨晚整理记忆,有几件想跟你对一下:',
      '· 新记下:周五前给 X 回话',
      '· 改了:先上线再优化(原来是:先打磨再上线)',
      '· 删了:在准备搬家(之后没再提)',
      '还有 1 条,发「查看记忆」看全部。',
      '不对的话直接跟我说。',
    ].join('\n'))
    expect(t).not.toMatch(/https?:\/\//)
  })
  it('says nothing when nothing notable changed; introduces itself on the first run', () => {
    expect(composeNotice([], false)).toBeNull()
    expect(composeNotice([], true)).toBe(FIRST_RUN_NOTICE)
  })
  it('formats the 整理记忆 reply for every outcome', () => {
    expect(formatNightlyReply({ status: 'written', applied, notice: '通知正文' })).toBe('通知正文')
    expect(formatNightlyReply({ status: 'written', applied: [], notice: null })).toBe('整理好了,没有需要特别跟你说的变化。发「查看记忆」看全部。')
    expect(formatNightlyReply({ status: 'skipped', reason: 'no_new_material' })).toBe('没有新东西要整理,记忆保持原样。')
    expect(formatNightlyReply({ status: 'failed', reason: 'bad_json' })).toBe('这次没整理成(bad_json),记忆保持原样。')
  })
})
