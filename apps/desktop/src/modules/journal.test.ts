import { describe, expect, it, vi, beforeEach } from 'vitest'

const showToast = vi.fn()
const invokeApi = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => String(s), showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: (...a: unknown[]) => invokeApi(...a) }))

const els = new Map<string, { innerHTML: string; textContent: string; addEventListener: () => void }>()
const mkEl = () => ({ innerHTML: '', textContent: '', addEventListener: () => {} })
// @ts-expect-error minimal DOM stub before import (same shape as todos.test.ts)
globalThis.document = { getElementById: (id: string) => els.get(id) ?? null }

const { renderHuntBag, splitByStatus, dayLabel, statusLabel, onHuntBagClick, countLabel, markJournalSeen } = await import('./journal.js')

const item = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 'i1', ts: new Date().toISOString(), chat_id: 'c', title: 'Continue.dev',
  url: 'https://github.com/continuedev/continue', note: '能改多文件', status: 'new', kind: 'hunt', ...o,
})

beforeEach(() => {
  els.clear(); els.set('fd-catch', mkEl()); els.set('fd-catch-count', mkEl())
  showToast.mockClear(); invokeApi.mockReset()
})
const host = () => els.get('fd-catch')!
const count = () => els.get('fd-catch-count')!

describe('renderHuntBag', () => {
  it('渲染标题、原文、链接和四个状态', () => {
    renderHuntBag({ items: [item()] })
    expect(host().innerHTML).toContain('Continue.dev')
    expect(host().innerHTML).toContain('能改多文件')
    expect(host().innerHTML).toContain('https://github.com/continuedev/continue')
    for (const l of ['没试', '跑过', '在用', '不要了']) expect(host().innerHTML).toContain(l)
    expect(count().textContent).toBe('1 件')
  })

  it('当前状态高亮', () => {
    renderHuntBag({ items: [item({ status: 'using' })] })
    expect(host().innerHTML).toMatch(/class="hb-chip on"[^>]*data-hb-status="using"/)
  })

  it('没有链接的条目不渲染链接行(而不是渲染一个空链接)', () => {
    renderHuntBag({ items: [item({ url: null })] })
    expect(host().innerHTML).not.toContain('hb-link')
  })

  it('**读不到 ≠ 空背包** —— 把读取失败显示成空清单等于告诉主人 CC 什么都没找到', () => {
    renderHuntBag({ items: null })
    expect(host().innerHTML).toContain('读不到背包')
    renderHuntBag({ items: [] })
    expect(host().innerHTML).toContain('背包还是空的')
  })

  it('丢弃的折叠起来,且不计入件数', () => {
    renderHuntBag({ items: [item(), item({ id: 'i2', status: 'dropped' })] })
    expect(count().textContent).toBe('1 件')
    expect(host().innerHTML).toContain('不要了的 1 件')
  })

  it('全被丢弃时不显示「背包还是空的」(它们还在,只是折起来了)', () => {
    renderHuntBag({ items: [item({ status: 'dropped' })] })
    expect(host().innerHTML).not.toContain('背包还是空的')
    expect(host().innerHTML).toContain('都处理完了')
  })
})

describe('见闻卡(kind=visit)', () => {
  const visit = (o: Partial<Record<string, unknown>> = {}) => item({ id: 'v1', kind: 'visit', url: null, title: '去第 1 度的朋友家串门', note: '他们家猫叫豆包。', ...o })

  it('没有状态档、没有链接行 —— 一段见闻不是一件要处理的东西', () => {
    renderHuntBag({ items: [visit()] })
    expect(host().innerHTML).toContain('hb-visit')
    expect(host().innerHTML).toContain('豆包')
    expect(host().innerHTML).not.toContain('hb-chip')
    expect(host().innerHTML).not.toContain('hb-link')
    // 但能删
    expect(host().innerHTML).toContain('data-hb-action="remove"')
  })

  it('有明信片就内联渲染;没有就不留空框', () => {
    renderHuntBag({ items: [visit({ image_svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>' })] })
    expect(host().innerHTML).toContain('hb-postcard')
    expect(host().innerHTML).toContain('<circle r="1"/>')
    renderHuntBag({ items: [visit({ image_svg: null })] })
    expect(host().innerHTML).not.toContain('hb-postcard')
  })

  it('东西和见闻分开数', () => {
    expect(countLabel([item(), item({ id: 'i2' }), visit()])).toBe('2 件 · 1 段见闻')
    expect(countLabel([visit()])).toBe('1 段见闻')
    expect(countLabel([item()])).toBe('1 件')
    expect(countLabel([])).toBe('')
  })

  it('没有 kind 的老行(v37 之前写的)当成东西', () => {
    const legacy = item(); delete (legacy as Record<string, unknown>).kind
    renderHuntBag({ items: [legacy] })
    expect(host().innerHTML).toContain('hb-chip')
    expect(count().textContent).toBe('1 件')
  })
})

describe('splitByStatus / dayLabel / statusLabel', () => {
  it('只有 dropped 进第二摞', () => {
    const { kept, dropped } = splitByStatus([item(), item({ status: 'tried' }), item({ status: 'dropped' })])
    expect(kept).toHaveLength(2); expect(dropped).toHaveLength(1)
  })

  it('日期显示成今天/昨天/N 天前/月日', () => {
    // 本地时间构造 —— 「今天」按主人所在时区算,而 CI 跑 UTC、我这台 +8。
    // 用 Z 后缀写死时刻会让这条测试在两地给出不同答案(而代码是对的)。
    const local = (d: number, h = 12) => new Date(2026, 8, d, h).toISOString()
    const now = new Date(2026, 8, 10, 12)
    expect(dayLabel(local(10, 1), now)).toBe('今天')
    expect(dayLabel(local(9, 23), now)).toBe('昨天')
    expect(dayLabel(local(7), now)).toBe('3 天前')
    expect(dayLabel(new Date(2026, 7, 20, 10).toISOString(), now)).toBe('8月20日')
  })

  it('坏时间戳不炸出 Invalid Date', () => {
    expect(dayLabel('不是时间')).toBe('')
  })

  it('未知状态回落到「没试」', () => { expect(statusLabel('???')).toBe('没试') })
})

describe('onHuntBagClick', () => {
  const btn = (attrs: Record<string, string>) => ({
    getAttribute: (k: string) => attrs[k] ?? null,
  })
  const ev = (attrs: Record<string, string>) => ({ target: { closest: () => btn(attrs) } })

  it('点状态 → POST 后刷新', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ items: [] })
    await onHuntBagClick(ev({ 'data-hb-action': 'status', 'data-hb-id': 'i1', 'data-hb-status': 'using' }))
    expect(invokeApi).toHaveBeenNthCalledWith(1, 'POST', '/v1/journal/status', { id: 'i1', status: 'using' })
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'GET', '/v1/journal')
  })

  it('**ok:false 要说出来** —— 否则界面显示一个改不动的状态,主人只觉得点了没反应', async () => {
    invokeApi.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ items: [] })
    await onHuntBagClick(ev({ 'data-hb-action': 'status', 'data-hb-id': 'gone', 'data-hb-status': 'using' }))
    expect(showToast).toHaveBeenCalledWith('这条已经不在背包里了')
  })

  it('删除走 remove 路由', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ items: [] })
    await onHuntBagClick(ev({ 'data-hb-action': 'remove', 'data-hb-id': 'i1' }))
    expect(invokeApi).toHaveBeenNthCalledWith(1, 'POST', '/v1/journal/remove', { id: 'i1' })
  })

  it('点空白处什么都不做', async () => {
    await onHuntBagClick({ target: { closest: () => null } })
    expect(invokeApi).not.toHaveBeenCalled()
  })

  it('复制链接;剪贴板不可用时告诉主人手动选中', async () => {
    // @ts-expect-error 测试桩
    globalThis.navigator = { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } }
    await onHuntBagClick(ev({ 'data-hb-action': 'copy', 'data-hb-url': 'https://a.com' }))
    expect(showToast).toHaveBeenCalledWith('复制不了 —— 手动选中那行链接吧')
    expect(invokeApi).not.toHaveBeenCalled()
  })
})

describe('markJournalSeen —— 打开觅食台 = 看过了', () => {
  it('打 POST /v1/journal/seen;失败吞掉返回 false', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, seen_until: 'x' })
    await expect(markJournalSeen()).resolves.toBe(true)
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/journal/seen')
    invokeApi.mockRejectedValueOnce(new Error('down'))
    await expect(markJournalSeen()).resolves.toBe(false)
  })
})
