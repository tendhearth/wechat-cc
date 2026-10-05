import { describe, it, expect } from 'vitest'
import { nowView, latestCCLine, waitingCount } from './now'

const a = (taskId: string, kind: 'permission' | 'question', id: string, summary: string) => ({ taskId, kind, id, summary })
const m = (id: string, title: string) => ({ id, title, kind: 'task', status: 'open', updatedAt: 1 }) as any

describe('nowView', () => {
  it('按任务合并等你的事;有权限就算「看清楚」,只有问题算「回答」', () => {
    const v = nowView({ hour: 21, matters: [m('t1', '作品集'), m('t2', '出差')], approvals: [
      a('t1', 'question', 'q1', '哪种风格?'), a('t1', 'permission', 'p1', '装图片组件?'), a('t2', 'question', 'q2', '哪天出发?'),
    ] })
    expect(v.greetingKey).toBe('now.greetingEvening')
    expect(v.waiting).toEqual([
      { taskId: 't1', kind: 'permission', firstRequestId: 'q1', count: 2, fallback: '哪种风格?', matterTitle: '作品集' },
      { taskId: 't2', kind: 'question', firstRequestId: 'q2', count: 1, fallback: '哪天出发?', matterTitle: '出差' },
    ])
  })
  it('事项标题拿不到就给空串(行上只剩标题一行),不编', () => {
    expect(nowView({ hour: 9, matters: [], approvals: [a('x', 'permission', 'p', 's')] }).waiting[0]!.matterTitle).toBe('')
  })
  it('够不着电脑(读不到等你的事)⇒ 不显示旧行,改说「不知道」;够得着才按真数据(终审 M3)', () => {
    const ap = [a('t1', 'permission', 'p1', 's')]
    expect(nowView({ hour: 9, matters: [], approvals: ap, known: false })).toMatchObject({ waiting: [], waitingUnknown: true })
    expect(nowView({ hour: 9, matters: [], approvals: [], known: false })).toMatchObject({ waiting: [], waitingUnknown: true })
    expect(nowView({ hour: 9, matters: [], approvals: ap, known: true }).waitingUnknown).toBe(false)
    expect(nowView({ hour: 9, matters: [], approvals: [] }).waitingUnknown).toBe(false)
  })
  it('三档问候', () => {
    expect(nowView({ hour: 5, matters: [], approvals: [] }).greetingKey).toBe('now.greetingMorning')
    expect(nowView({ hour: 12, matters: [], approvals: [] }).greetingKey).toBe('now.greetingAfternoon')
    expect(nowView({ hour: 4, matters: [], approvals: [] }).greetingKey).toBe('now.greetingEvening')
  })
})

describe('latestCCLine', () => {
  const msg = (id: string, role: 'me' | 'cc', text: string, at: number) => ({ id, role, text, at, source: 'wechat', truncated: false }) as any
  const page = (messages: any[]) => ({ matterId: 'c', title: 'CC', messages, hasMore: false, nextBefore: null, pending: null, failed: null }) as any
  it('取最近一条 CC 说的、非空的话', () => {
    expect(latestCCLine(page([msg('1', 'cc', '早', 1), msg('2', 'me', '在吗', 2), msg('3', 'cc', '行程整理好了', 3), msg('4', 'me', '好', 4)])))
      .toEqual({ text: '行程整理好了', at: 3 })
  })
  it('没页 / 空页 / 只有「我」/ CC 的话全是空白 ⇒ null(不画空气泡)', () => {
    expect(latestCCLine(undefined)).toBeNull()
    expect(latestCCLine(page([]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'me', 'hi', 1)]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'cc', '   ', 1)]))).toBeNull()
  })
  it('首页预览保留文字,去掉 Markdown 语法与链接目标;用户消息不作为 CC 预览', () => {
    const raw = '## 已整理\n\n**可以继续**，查看 [资料](/Users/owner/a.md:13)。'
    const p = page([msg('1', 'cc', raw, 1), msg('2', 'me', '**保留原文**', 2)])
    expect(latestCCLine(p)).toEqual({ text: '已整理\n\n可以继续，查看 资料。', at: 1 })
    expect(p.messages[0].text).toBe(raw)
  })
})

describe('waitingCount — 标签栏「此刻」后面的数字', () => {
  const w = (taskId: string, id: string) => a(taskId, 'permission', id, '')
  it('counts tasks, not requests, and matches the 此刻 rows', () => {
    const approvals = [w('t1', 'r1'), w('t1', 'r2'), w('t2', 'r3')]
    expect(waitingCount(approvals, true)).toBe(2)
    expect(waitingCount(approvals, true)).toBe(nowView({ approvals, matters: [], hour: 9 }).waiting.length)
  })
  it('writes nothing when the computer is out of reach (stale data)', () => {
    expect(waitingCount([w('t1', 'r1')], false)).toBe(0)
    expect(waitingCount([], true)).toBe(0)
  })
})
