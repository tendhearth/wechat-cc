import { describe, expect, it, vi } from 'vitest'

const showToast = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => s, showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

// @ts-expect-error minimal DOM stub before import (module shape parity with memory.test.ts)
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }

const { groupObligations, reminderSlots, recentSettled, timeBadge, __onListClick, __setApi, __onOutsideRemindClick } = await import('./todos.js')

function row(id: number, contact: string, value: string, updated: number) {
  return { id, contact, kind: 'obligation', predicate: 'p', value, time_ref: null, confidence: 'med', updated_at: updated }
}

describe('groupObligations', () => {
  it('groups by contact with display names, newest activity first', () => {
    const names = new Map([['wx_a', '张三']])
    const groups = groupObligations([
      row(1, 'wx_a', '旧的', 100),
      row(2, 'wx_b', '中间的', 200),
      row(3, 'wx_a', '新的', 300),
    ] as never, names)
    expect(groups.map(g => g.display)).toEqual(['张三', 'wx_b'])   // wx_a 有 300 → 排前;wx_b 无 display → 回退 username
    expect(groups[0]!.items.map(i => i.value)).toEqual(['新的', '旧的'])
  })
})

describe('recentSettled', () => {
  const now = 1_756_000_000
  const day = 86400
  it('keeps only the last 7 days, newest first, capped at 20', () => {
    const rows = [
      row(1, 'wx_a', '三天前了结', now - 3 * day),
      row(2, 'wx_a', '刚了结', now - 60),
      row(3, 'wx_a', '八天前了结', now - 8 * day),   // outside window
    ]
    expect(recentSettled(rows as never, now).map((r: { value: string }) => r.value))
      .toEqual(['刚了结', '三天前了结'])
    const many = Array.from({ length: 30 }, (_, i) => row(i, 'wx_a', `v${i}`, now - i * 60))
    expect(recentSettled(many as never, now)).toHaveLength(20)
  })
})

describe('timeBadge', () => {
  const today = new Date('2026-08-24T15:00:00')
  it('flags overdue / today / tomorrow from a leading YYYY-MM-DD', () => {
    expect(timeBadge('2026-08-20', today)).toEqual({ label: '逾期', cls: 'overdue' })
    expect(timeBadge('2026-08-24', today)).toEqual({ label: '今天', cls: 'today' })
    expect(timeBadge('2026-08-25 下午', today)).toEqual({ label: '明天', cls: 'soon' })
  })
  it('null for far-future, unparseable, or empty refs', () => {
    expect(timeBadge('2026-09-20', today)).toBeNull()
    expect(timeBadge('下周', today)).toBeNull()
    expect(timeBadge(null, today)).toBeNull()
  })
})

describe('reminderSlots', () => {
  it('offers tonight only while tonight is still ahead', () => {
    const morning = reminderSlots(new Date('2026-08-24T10:00:00'))
    expect(morning.map(s => s.label)).toEqual(['今晚 21:00', '明早 9:30'])
    const late = reminderSlots(new Date('2026-08-24T22:30:00'))
    expect(late.map(s => s.label)).toEqual(['明早 9:30'])
  })
})

describe('onListClick — 200 但 ok:false 不能假装划掉', () => {
  class HTMLElementStub {
    dataset: Record<string, string> = {}
    classList = { add: vi.fn(), toggle: vi.fn() }
    _closest: Record<string, unknown> = {}
    closest(sel: string) { return (this._closest[sel] as unknown) ?? null }
    querySelector() { return null }
  }
  class HTMLButtonElementStub extends HTMLElementStub { disabled = false }

  function wire(apiResult: unknown) {
    // @ts-expect-error stub globals for instanceof checks in onListClick
    globalThis.HTMLElement = HTMLElementStub
    // @ts-expect-error stub globals for instanceof checks in onListClick
    globalThis.HTMLButtonElement = HTMLButtonElementStub
    const item = new HTMLElementStub()
    const btn = new HTMLButtonElementStub()
    btn.dataset = { todoAction: 'resolve', factId: '5' }
    btn._closest = { '[data-todo-action]': btn, '.todo-item': item, '.todo-actions': null }
    const api = vi.fn(async () => apiResult)
    __setApi(api)
    showToast.mockClear()
    return { item, btn, api, ev: { target: btn } as unknown as MouseEvent }
  }

  it('ok:false → 不打 is-done、重新启用按钮、提示', async () => {
    const { item, btn, api, ev } = wire({ ok: false })
    await __onListClick(ev)
    expect(api).toHaveBeenCalledWith('POST', '/v1/knowledge/facts/set_fact_status', { id: 5, status: 'resolved' })
    expect(item.classList.add).not.toHaveBeenCalledWith('is-done')
    expect(btn.disabled).toBe(false)
    expect(showToast).toHaveBeenCalled()
  })

  it('ok:true → 划掉(打 is-done)', async () => {
    const { item, ev } = wire({ ok: true })
    await __onListClick(ev)
    expect(item.classList.add).toHaveBeenCalledWith('is-done')
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('提醒选择器 — 点外面/Esc 自动关掉', () => {
  class NodeStub {}
  it('点在选择器内 → 不关;点在外面 → 关', () => {
    // @ts-expect-error stub Node for instanceof check
    globalThis.Node = NodeStub
    const inside = new NodeStub()
    const outside = new NodeStub()
    let removed = 0
    const pop = { contains: (n: unknown) => n === inside, remove: () => { removed++ } }
    // @ts-expect-error minimal document stub
    globalThis.document = { getElementById: () => pop, removeEventListener: () => {} }
    __onOutsideRemindClick({ target: inside } as unknown as Event)
    expect(removed).toBe(0)                       // 点内部,保持打开
    __onOutsideRemindClick({ target: outside } as unknown as Event)
    expect(removed).toBe(1)                       // 点外部,收起来
  })
})
