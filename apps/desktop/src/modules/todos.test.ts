import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Window } from 'happy-dom'

const showToast = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => s, showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

// @ts-expect-error minimal DOM stub before import (module shape parity with memory.test.ts)
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] }

const todosModule = await import('./todos.js')
const { groupObligations, reminderSlots, recentSettled, timeBadge, __onListClick, __setApi, __onOutsideRemindClick, initTodosPage } = todosModule

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


// Real DOM tests cover the page's existing API contract and lifecycle. No daemon.
describe('待办 — 操作层级与提醒生命周期', () => {
  let win: Window
  let activeRows: ReturnType<typeof row>[]
  let settledRows: ReturnType<typeof row>[]
  let defaultChatId: string | null
  let admins: string[]
  let api: Mock<(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>>
  let invoke: Mock<(cmd: string, args: Record<string, unknown>) => Promise<unknown>>
  let pageModule: typeof todosModule
  let lifecycle: { deactivateTodosPage?: () => void } = {}

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
  }

  async function settle() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  function query<T extends Element = HTMLElement>(selector: string): T {
    const found = document.querySelector(selector)
    expect(found, selector).not.toBeNull()
    return found as T
  }

  async function mount() {
    pageModule.initTodosPage({ invoke }, { api })
    await settle()
  }

  async function openPicker(id = 1) {
    const button = query<HTMLButtonElement>(`[data-fact-id="${id}"] [data-todo-action="remind"]`)
    const more = button.closest('details')
    if (more) more.open = true
    button.click()
    await settle()
    return query<HTMLElement>('#todo-remind-pop')
  }

  function scheduleCalls() {
    return api.mock.calls.filter(call => call[1] === '/v1/reminders/schedule')
  }

  beforeEach(async () => {
    lifecycle.deactivateTodosPage?.()
    win = new Window({ url: 'http://localhost/' })
    for (const name of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
      vi.stubGlobal(name, name === 'window' ? win : win[name])
    }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T10:00:00'))
    document.body.innerHTML = '<div id="todos-root"></div>'
    activeRows = [row(1, 'wx_a', '发出合同', 200), row(2, 'wx_b', '约好见面', 100)]
    settledRows = []
    defaultChatId = 'second-owner'
    admins = ['first-owner', 'second-owner']
    api = vi.fn(async (_method: string, path: string, body?: Record<string, unknown>): Promise<unknown> => {
      if (path === '/v1/knowledge/facts/find_facts') return { results: body?.status === 'resolved' ? settledRows : activeRows }
      if (path === '/v1/knowledge/graph/top_contacts') return { contacts: [{ username: 'wx_a', display: '阿青' }] }
      if (path === '/v1/companion/status') return { enabled: true, timezone: 'America/Los_Angeles', default_chat_id: defaultChatId, snooze_until: null, import_local_history: false }
      return { ok: true }
    })
    invoke = vi.fn(async (_cmd: string, args: Record<string, unknown>): Promise<unknown> => {
      const argv = args.args as string[]
      if (argv[0] === 'access') return { ok: true, admins, trusted: ['guest-chat'], allowFrom: [], dmPolicy: 'allowlist' }
      // Actual memory list is an array; its first entry may be a guest.
      return [{ userId: 'guest-chat', facts: 1 }, { userId: 'second-owner', facts: 3 }]
    })
    showToast.mockClear()
    vi.resetModules()
    pageModule = await import('./todos.js')
    lifecycle = pageModule as unknown as { deactivateTodosPage?: () => void }
  })

  afterEach(async () => {
    lifecycle.deactivateTodosPage?.()
    vi.clearAllTimers()
    vi.useRealTimers()
    await win.happyDOM.abort()
    vi.unstubAllGlobals()
  })

  it('每行只露出完成；提醒和纠正在普通更多折叠内，联系人分组保留', async () => {
    await mount()
    const item = query<HTMLElement>('.todo-item')
    const complete = item.querySelector('[data-todo-action="resolve"]')!
    expect(complete.closest('details')).toBeNull()
    for (const action of ['remind', 'reject']) {
      const more = item.querySelector(`[data-todo-action="${action}"]`)!.closest('details')
      expect(more).not.toBeNull()
      expect(more?.open).toBe(false)
      expect(more?.querySelector('summary')?.textContent).toBe('更多')
    }
    expect(document.querySelectorAll('.todo-group')).toHaveLength(2)
    expect(query('.todo-group h2').textContent).toContain('阿青')
  })

  it('提醒使用实际 status + admins 选主人，不把 memory 第一位联系人当主人', async () => {
    await mount()
    const pop = await openPicker()
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(1)
    expect(scheduleCalls()[0]).toEqual(['POST', '/v1/reminders/schedule', expect.objectContaining({ chat_id: 'second-owner', text: '⏰ 待办：发出合同' })])
    expect(invoke).toHaveBeenCalledWith('wechat_cli_json', { args: ['access', 'list', '--json'] })
    expect(invoke.mock.calls.some(call => (call[1].args as string[])[0] === 'memory')).toBe(false)
    expect([...pop.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input')].every(control => control.disabled)).toBe(true)
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(1)
  })

  it('status 默认联系人不在 admins 时回退第一位 admin', async () => {
    defaultChatId = 'guest-chat'
    await mount()
    const pop = await openPicker()
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(scheduleCalls()[0]?.[2]).toEqual(expect.objectContaining({ chat_id: 'first-owner' }))
  })

  it('同一待办提交提醒单飞，等待期间选择器所有输入和按钮禁用', async () => {
    const pending = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/reminders/schedule' ? pending.promise : normal(method, path, body))
    await mount()
    const pop = await openPicker()
    const slots = pop.querySelectorAll<HTMLButtonElement>('[data-remind-at]')
    slots[0]!.click()
    await settle()
    slots[1]!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(1)
    expect([...pop.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input')].every(el => el.disabled)).toBe(true)
    pending.resolve({ ok: true })
    await settle()
  })

  it('提醒失败保留表单与可重试反馈，再次提交能成功', async () => {
    let attempts = 0
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/reminders/schedule'
      ? Promise.resolve(++attempts === 1 ? { ok: false, error: 'too_many_pending' } : { ok: true })
      : normal(method, path, body))
    await mount()
    const pop = await openPicker()
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(pop.querySelector('[role="status"]')?.textContent).toBeTruthy()
    expect(pop.textContent).not.toContain('too_many_pending')
    const retry = pop.querySelector<HTMLButtonElement>('[data-remind-at]')
    expect(retry).not.toBeNull()
    expect(retry?.disabled).toBe(false)
    retry!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(2)
    expect(pop.querySelector('.todo-remind-ok')?.textContent).toContain('微信')
  })

  it('缺少主人时保留时间表单，主人恢复后可原地重试', async () => {
    admins = []
    await mount()
    const pop = await openPicker()
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(0)
    const retry = pop.querySelector<HTMLButtonElement>('[data-remind-at]')
    expect(retry).not.toBeNull()
    expect(pop.querySelector('[role="status"]')?.textContent).toBeTruthy()
    admins = ['second-owner']
    retry!.click()
    await settle()
    expect(scheduleCalls()[0]?.[2]).toEqual(expect.objectContaining({ chat_id: 'second-owner' }))
  })

  it('旧提醒迟到成功不会关闭随后打开的另一条选择器', async () => {
    // Let the old implementation reach its schedule call so this test isolates
    // picker lifetime independently of the owner contract regression.
    invoke.mockImplementation(async (_cmd, args) => {
      const argv = args.args as string[]
      return argv[0] === 'access' ? { ok: true, admins } : { users: [{ userId: 'second-owner' }] }
    })
    const pending = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/reminders/schedule' ? pending.promise : normal(method, path, body))
    await mount()
    const first = await openPicker(1)
    first.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    const second = await openPicker(2)
    expect(scheduleCalls()).toHaveLength(1)
    pending.resolve({ ok: true })
    await settle()
    await vi.advanceTimersByTimeAsync(1700)
    expect(document.getElementById('todo-remind-pop')).toBe(second)
  })

  it('收起更多立即关闭提醒选择器', async () => {
    await mount()
    const pop = await openPicker()
    const more = pop.closest('details')!
    more.open = false
    more.dispatchEvent(new Event('toggle'))
    expect(document.getElementById('todo-remind-pop')).toBeNull()
  })

  it('离页立即关闭选择器，迟到主人解析不得继续创建提醒', async () => {
    const owner = deferred<unknown>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/companion/status' ? owner.promise : normal(method, path, body))
    invoke.mockImplementation((_cmd, args) => (args.args as string[])[0] === 'memory' ? owner.promise : Promise.resolve({ ok: true, admins }))
    await mount()
    const pop = await openPicker()
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(typeof lifecycle.deactivateTodosPage).toBe('function')
    lifecycle.deactivateTodosPage!()
    expect(document.getElementById('todo-remind-pop')).toBeNull()
    owner.resolve({ default_chat_id: 'second-owner', users: [{ userId: 'second-owner' }] })
    await settle()
    expect(scheduleCalls()).toHaveLength(0)
  })

  it('完成与纠正共用行级单飞，失败后恢复操作', async () => {
    const pending = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/knowledge/facts/set_fact_status' ? pending.promise : normal(method, path, body))
    await mount()
    const item = query<HTMLElement>('.todo-item')
    item.querySelector<HTMLButtonElement>('[data-todo-action="resolve"]')!.click()
    item.querySelector<HTMLButtonElement>('[data-todo-action="reject"]')!.click()
    await settle()
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/set_fact_status')).toHaveLength(1)
    expect([...item.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    pending.resolve({ ok: false })
    await settle()
    expect(item.classList.contains('is-done')).toBe(false)
    expect([...item.querySelectorAll<HTMLButtonElement>('button')].every(button => !button.disabled)).toBe(true)
    expect(showToast).toHaveBeenCalled()
  })

  it('已了结保留恢复动作，恢复仍写 active', async () => {
    settledRows = [row(5, 'wx_a', '上周未办完', Math.floor(Date.now() / 1000) - 60)]
    await mount()
    query<HTMLDetailsElement>('.todo-settled').open = true
    query<HTMLButtonElement>('[data-todo-action="revive"]').click()
    await settle()
    expect(api).toHaveBeenCalledWith('POST', '/v1/knowledge/facts/set_fact_status', { id: 5, status: 'active' })
  })

  it('重新进入后的新列表不被上一轮迟到读取覆盖', async () => {
    const oldRead = deferred<unknown>()
    const normal = api.getMockImplementation()!
    let readCount = 0
    api.mockImplementation((method, path, body) => path === '/v1/knowledge/facts/find_facts' && body?.status === 'active' && ++readCount === 1
      ? oldRead.promise : normal(method, path, body))
    pageModule.initTodosPage({ invoke }, { api })
    await settle()
    expect(typeof lifecycle.deactivateTodosPage).toBe('function')
    lifecycle.deactivateTodosPage!()
    activeRows = [row(8, 'wx_a', '新的待办', 500)]
    await mount()
    expect(query('#todos-list').textContent).toContain('新的待办')
    oldRead.resolve({ results: [row(9, 'wx_a', '旧列表', 1)] })
    await settle()
    expect(query('#todos-list').textContent).toContain('新的待办')
    expect(query('#todos-list').textContent).not.toContain('旧列表')
  })

  it('自选过去时间不提交，提示后仍可选择未来时间', async () => {
    await mount()
    const pop = await openPicker()
    query<HTMLInputElement>('#todo-remind-custom-input').value = '2026-10-02T10:00'
    query<HTMLButtonElement>('#todo-remind-custom-go').click()
    await settle()
    expect(scheduleCalls()).toHaveLength(0)
    expect(pop.querySelector('[role="status"]')?.textContent).toBeTruthy()
    expect(pop.querySelector<HTMLButtonElement>('[data-remind-at]')?.disabled).toBe(false)
  })

  it.each([
    ['resolve', 'resolved'],
    ['revive', 'active'],
  ] as const)('上一轮 %s 迟到成功后，重新进入的列表应读取真实状态', async (action, status) => {
    const fact = row(15, 'wx_a', '离页期间才更新的待办', Math.floor(Date.now() / 1000) - 60)
    activeRows = action === 'resolve' ? [fact] : []
    settledRows = action === 'revive' ? [fact] : []
    const mutation = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/knowledge/facts/set_fact_status'
      ? mutation.promise : normal(method, path, body))
    await mount()
    if (action === 'revive') query<HTMLDetailsElement>('.todo-settled').open = true
    query<HTMLButtonElement>(`[data-fact-id="15"] [data-todo-action="${action}"]`).click()
    await settle()
    expect(api).toHaveBeenCalledWith('POST', '/v1/knowledge/facts/set_fact_status', { id: 15, status })

    lifecycle.deactivateTodosPage!()
    await mount()
    if (action === 'revive') query<HTMLDetailsElement>('.todo-settled').open = true
    expect(query<HTMLButtonElement>(`[data-fact-id="15"] [data-todo-action="${action}"]`).disabled).toBe(true)
    const readsBeforeResult = api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length

    // The latest read happened before the previous mutation reached the store.
    // Its eventual success must refresh the new page rather than merely enable
    // a row whose fact status is now stale.
    activeRows = action === 'revive' ? [fact] : []
    settledRows = action === 'resolve' ? [fact] : []
    mutation.resolve({ ok: true })
    await settle()
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length).toBeGreaterThan(readsBeforeResult)
    expect(document.querySelector(`.todo-group [data-fact-id="15"]`) !== null).toBe(action === 'revive')
    expect(document.querySelector(`.todo-settled [data-fact-id="15"]`) !== null).toBe(action === 'resolve')
  })


  it('跨页完成迟到时保留另一条提醒草稿，关闭选择器后才刷新', async () => {
    const mutation = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/knowledge/facts/set_fact_status'
      ? mutation.promise : normal(method, path, body))
    await mount()
    query<HTMLButtonElement>('[data-fact-id="1"] [data-todo-action="resolve"]').click()
    await settle()
    lifecycle.deactivateTodosPage!()
    await mount()
    const pop = await openPicker(2)
    const input = pop.querySelector<HTMLInputElement>('#todo-remind-custom-input')!
    input.value = '2026-10-05T13:10'
    await vi.advanceTimersByTimeAsync(0)
    const readsBeforeResult = api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length

    const completed = activeRows[0]!
    activeRows = activeRows.filter(fact => fact.id !== 1)
    settledRows = [completed]
    mutation.resolve({ ok: true })
    await settle()
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length).toBe(readsBeforeResult)
    expect(document.getElementById('todo-remind-pop')).toBe(pop)
    expect(input.value).toBe('2026-10-05T13:10')
    expect(query<HTMLButtonElement>('[data-fact-id="1"] [data-todo-action="resolve"]').disabled).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(document.getElementById('todo-remind-pop')).toBeNull()
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length).toBeGreaterThan(readsBeforeResult)
    expect(document.querySelector('.todo-group [data-fact-id="1"]')).toBeNull()
    expect(document.querySelector('.todo-group [data-fact-id="2"]')).not.toBeNull()
  })

  it('刷新期间打开的提醒表单被替换后，迟到主人解析不得提交', async () => {
    await mount()
    const refreshRead = deferred<{ results: ReturnType<typeof row>[] }>()
    const owner = deferred<unknown>()
    const normal = api.getMockImplementation()!
    let delayRefresh = true
    api.mockImplementation((method, path, body) => {
      if (path === '/v1/knowledge/facts/find_facts' && body?.status === 'active' && delayRefresh) {
        delayRefresh = false
        return refreshRead.promise
      }
      if (path === '/v1/companion/status') return owner.promise
      return normal(method, path, body)
    })
    query<HTMLButtonElement>('#todos-refresh').click()
    await settle()
    const pop = await openPicker(1)
    pop.querySelector<HTMLButtonElement>('[data-remind-at]')!.click()
    await settle()
    expect(scheduleCalls()).toHaveLength(0)

    refreshRead.resolve({ results: activeRows })
    await settle()
    expect(document.getElementById('todo-remind-pop')).toBeNull()
    expect(pop.isConnected).toBe(false)
    owner.resolve({ default_chat_id: 'second-owner' })
    await settle()
    expect(scheduleCalls()).toHaveLength(0)
    expect([...query('.todo-item').querySelectorAll<HTMLButtonElement>('button')].every(button => !button.disabled)).toBe(true)
  })


  it('同代完成迟到时保留另一条提醒草稿，关闭选择器后才刷新', async () => {
    const mutation = deferred<{ ok: boolean }>()
    const normal = api.getMockImplementation()!
    api.mockImplementation((method, path, body) => path === '/v1/knowledge/facts/set_fact_status'
      ? mutation.promise : normal(method, path, body))
    await mount()
    query<HTMLButtonElement>('[data-fact-id="1"] [data-todo-action="resolve"]').click()
    await settle()
    const pop = await openPicker(2)
    const input = pop.querySelector<HTMLInputElement>('#todo-remind-custom-input')!
    input.value = '2026-10-05T13:10'
    await vi.advanceTimersByTimeAsync(0)
    const readsBeforeResult = api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length

    const completed = activeRows[0]!
    activeRows = activeRows.filter(fact => fact.id !== 1)
    settledRows = [completed]
    mutation.resolve({ ok: true })
    await settle()
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(document.getElementById('todo-remind-pop')).toBe(pop)
    expect(input.value).toBe('2026-10-05T13:10')
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length).toBe(readsBeforeResult)
    expect(query<HTMLButtonElement>('[data-fact-id="1"] [data-todo-action="resolve"]').disabled).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(document.getElementById('todo-remind-pop')).toBeNull()
    expect(api.mock.calls.filter(call => call[1] === '/v1/knowledge/facts/find_facts').length).toBeGreaterThan(readsBeforeResult)
    expect(document.querySelector('.todo-group [data-fact-id="1"]')).toBeNull()
    expect(document.querySelector('.todo-group [data-fact-id="2"]')).not.toBeNull()
  })

})
