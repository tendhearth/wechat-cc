import { describe, it, expect } from 'vitest'
import { greetingFor, ccPresence, nowStatusLine, latestCCLine, waitingRows, waitingHeader } from './now-home.js'

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

describe('waitingHeader(终审 M3:读不到不等于没有)', () => {
  const task = { id: 'a', title: 't', providerId: 'claude', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '[]' }
  it('有事 ⇒ 「N 件事等你」;没有 ⇒ 不显示;还没拉到第一拍 ⇒ 不显示', () => {
    expect(waitingHeader({ tasks: [task, { ...task, id: 'b' }], stale: false })).toEqual({ hidden: false, unknown: false, title: '2 件事等你' })
    expect(waitingHeader({ tasks: [], stale: false })).toEqual({ hidden: true, unknown: false, title: '' })
    expect(waitingHeader(null)).toEqual({ hidden: true, unknown: false, title: '' })
  })
  it('读不到 / 过期 ⇒ 灰字「暂时不知道有没有等你的事」,不能悄悄消失', () => {
    expect(waitingHeader({ tasks: [task], stale: true })).toEqual({ hidden: false, unknown: true, title: '暂时不知道有没有等你的事' })
    expect(waitingHeader({ tasks: [], stale: true })).toEqual({ hidden: false, unknown: true, title: '暂时不知道有没有等你的事' })
  })
})

describe('nowStatusLine', () => {
  const p = (presence: string) => ({ presence })
  it('presence 够不着 ⇒ 红点 + 不在身边,即使 doctor 说 daemon 活着(与 CC 变暗同一信号)', () => {
    expect(nowStatusLine({ alive: true }, p('down'))).toEqual({ cls: 'bad', text: 'CC 不在身边' })
  })
  it('还没拉到(doctor 或 presence 尚未第一拍)⇒ 灰点「正在连接…」,既不报绿也不报红', () => {
    expect(nowStatusLine(null, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine({ alive: true }, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine(null, p('ok'))).toEqual({ cls: 'unknown', text: '正在连接…' })
  })
  it('daemon 没跑 ⇒ 红', () => { expect(nowStatusLine({ alive: false }, p('ok'))).toEqual({ cls: 'bad', text: 'CC 没在运行' }) })
  it('两边都通才绿', () => { expect(nowStatusLine({ alive: true }, p('ok'))).toEqual({ cls: 'ok', text: 'CC 在家 · 运行中' }) })
})
