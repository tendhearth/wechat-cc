import { describe, it, expect } from 'vitest'
import { greetingFor, ccPresence, latestCCLine, waitingRows } from './now-home.js'

describe('greetingFor', () => {
  it('三档,与手机同一套钟点', () => {
    expect(greetingFor(5)).toBe('早上好'); expect(greetingFor(11)).toBe('早上好')
    expect(greetingFor(12)).toBe('下午好'); expect(greetingFor(17)).toBe('下午好')
    expect(greetingFor(18)).toBe('晚上好'); expect(greetingFor(4)).toBe('晚上好')
  })
})
describe('ccPresence', () => {
  const p = (presence: string) => ({ presence, activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })
  it('拉到真数据就在身边(外发 offline 只影响微信,不变暗)', () => {
    for (const s of ['ok', 'degraded', 'offline']) expect(ccPresence(p(s))).toBe('here')
  })
  it('拉不到 / 还没拉 ⇒ 不在身边', () => { expect(ccPresence(p('down'))).toBe('away'); expect(ccPresence(null)).toBe('away') })
})
describe('latestCCLine', () => {
  it('最近一条 CC 的、非占位、非空的话', () => {
    expect(latestCCLine([{ role: 'cc', text: '早', at: 1 }, { role: 'user', text: '在吗', at: 2 }, { role: 'cc', text: '…', pending: true }, { role: 'cc', text: '行程好了', at: 3 }, { role: 'error', text: '失败' }] as any))
      .toEqual({ text: '行程好了', at: 3 })
  })
  it('只有占位 / 空 / 没有 ⇒ null', () => {
    expect(latestCCLine([])).toBeNull()
    expect(latestCCLine([{ role: 'cc', text: '…', pending: true }] as any)).toBeNull()
    expect(latestCCLine([{ role: 'user', text: 'hi' }] as any)).toBeNull()
  })
})
describe('waitingRows', () => {
  const task = (id: string, perm: number, q: number) => ({ id, title: `任务 ${id}`, providerId: 'claude', pendingPermissionCount: perm, pendingQuestionCount: q, attentionKey: '[]' })
  it('有权限 ⇒ 看清楚;只有问题 ⇒ 回答;说明是计数', () => {
    expect(waitingRows({ tasks: [task('a', 1, 1), task('b', 0, 2)], stale: false })).toEqual([
      { id: 'a', title: '任务 a', detail: '1 项权限 · 1 个问题', go: '看清楚' },
      { id: 'b', title: '任务 b', detail: '2 个问题', go: '回答' },
    ])
  })
  it('读不到 / 过期 ⇒ 空(不显示旧的「等你」)', () => {
    expect(waitingRows(null)).toEqual([])
    expect(waitingRows({ tasks: [task('a', 1, 0)], stale: true })).toEqual([])
  })
})
