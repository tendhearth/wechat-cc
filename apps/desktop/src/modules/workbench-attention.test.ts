import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const attentionTask = (id: string, requests: string[], overrides: Record<string, unknown> = {}) => ({
  id, title: `任务 ${id}`, providerId: 'codex', pendingPermissionCount: requests.length,
  pendingQuestionCount: 0, attentionKey: JSON.stringify(requests), ...overrides,
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class Element {
  hidden = false
  textContent = ''
  className = ''
  type = ''
  id = ''
  dataset: Record<string, string> = {}
  children: Element[] = []
  parent: Element | null = null
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<(event: any) => void>>()
  ownerDocument: any
  constructor(public tagName = 'DIV') {}
  append(...children: Element[]) {
    for (const child of children) {
      child.remove()
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: Element[]) { for (const child of [...this.children]) child.remove(); this.append(...children) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  getAttribute(key: string) { return this.attributes.get(key) ?? null }
  addEventListener(name: string, fn: (event: any) => void) { const list = this.listeners.get(name) ?? new Set(); list.add(fn); this.listeners.set(name, list) }
  removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn) }
  dispatch(name: string, event: any = {}) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this, ...event }) }
  contains(node: Element | null): boolean { return node === this || this.children.some(child => child.contains(node)) }
  focus() { this.ownerDocument.activeElement = this }
  find(predicate: (el: Element) => boolean): Element | undefined { return this.children.find(predicate) ?? this.children.map(child => child.find(predicate)).find(Boolean) }
}

function dom() {
  const documentTarget = new Element() as Element & { createElement(tag: string): Element; activeElement: Element | null }
  documentTarget.activeElement = null
  documentTarget.createElement = tag => { const element = new Element(tag.toUpperCase()); element.ownerDocument = documentTarget; return element }
  const host = documentTarget.createElement('div')
  return { documentTarget, host }
}

describe('global workbench attention polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows every initially pending task without replaying existing native notifications', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    const first = attentionTask('A', ['permission-a'])
    const second = attentionTask('B', ['question-b'], { pendingPermissionCount: 0, pendingQuestionCount: 1 })
    const onChange = vi.fn(), invoke = vi.fn()
    const api = vi.fn(async () => ({ tasks: [first, second] }))
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: api, invoke, onChange, getContext: () => ({ taskId: null, focused: true }) })

    await attention.start()
    expect(onChange).toHaveBeenLastCalledWith({ tasks: [first, second], stale: false })
    expect(api).toHaveBeenCalledWith('GET', '/v1/workbench/attention')
    expect(invoke).not.toHaveBeenCalled()
    attention.destroy()
  })

  it('notifies only for new request identities across tasks, removals, retries and resolved replays', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    let tasks: ReturnType<typeof attentionTask>[] = []
    const invoke = vi.fn(async () => undefined), onChange = vi.fn()
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: async () => ({ tasks }), invoke, onChange, getContext: () => ({ taskId: null, focused: true }) })
    await attention.start()
    tasks = [attentionTask('A', ['a-1', 'a-2'], { title: '/private/file run secret command' }), attentionTask('B', ['b-1'])]
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(1)
    const [command, payload] = invoke.mock.calls[0] as unknown as [string, { title: string; body: string }]
    expect(command).toBe('notify_user')
    expect(Object.keys(payload).sort()).toEqual(['body', 'title'])
    expect(payload.title + payload.body).not.toMatch(/private|secret|a-1|任务 A|任务 B/)

    await attention.refresh()
    tasks = [attentionTask('A', ['a-1'])]
    await attention.refresh()
    tasks = []
    await attention.refresh()
    expect(onChange).toHaveBeenLastCalledWith({ tasks: [], stale: false })
    tasks = [attentionTask('A', ['a-1'])]
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(1)
    tasks = [attentionTask('A', ['a-3'])]
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(2)
    attention.destroy()
  })

  it('suppresses the selected focused task without deferring old notifications until navigation', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    let tasks: ReturnType<typeof attentionTask>[] = [], context = { taskId: 'A' as string | null, focused: true }
    const invoke = vi.fn(async () => undefined)
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: async () => ({ tasks }), invoke, onChange: () => {}, getContext: () => context })
    await attention.start()
    tasks = [attentionTask('A', ['a-1'])]
    await attention.refresh()
    context = { taskId: null, focused: true }
    await attention.refresh()
    expect(invoke).not.toHaveBeenCalled()
    context = { taskId: 'A', focused: false }
    tasks = [attentionTask('A', ['a-1', 'a-2'])]
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(1)
    context = { taskId: 'A', focused: true }
    tasks = [...tasks, attentionTask('B', ['b-1'])]
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(2)
    attention.destroy()
  })

  it('keeps polling independently of notification permission and does not retry a denied notice', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    let tasks: ReturnType<typeof attentionTask>[] = []
    const invoke = vi.fn(async () => { throw new Error('denied') }), onChange = vi.fn()
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: async () => ({ tasks }), invoke, onChange, intervalMs: 100, getContext: () => ({ taskId: null, focused: false }) })
    await attention.start()
    tasks = [attentionTask('A', ['a-1'])]
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(300)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ tasks, stale: false })
    attention.destroy()
  })

  it('backs off while unavailable, retains visible pending state, and returns to its normal interval on recovery', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    let unavailable = false
    const task = attentionTask('A', ['a-1']), onChange = vi.fn()
    const api = vi.fn(async () => { if (unavailable) throw new Error('offline'); return { tasks: [task] } })
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: api, invoke: vi.fn(), onChange, intervalMs: 100, maxBackoffMs: 400 })
    await attention.start()
    unavailable = true
    await vi.advanceTimersByTimeAsync(100)
    expect(onChange).toHaveBeenLastCalledWith({ tasks: [task], stale: true })
    await vi.advanceTimersByTimeAsync(199)
    expect(api).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(400)
    expect(api).toHaveBeenCalledTimes(4)
    unavailable = false
    await vi.advanceTimersByTimeAsync(400)
    expect(api).toHaveBeenCalledTimes(5)
    expect(onChange).toHaveBeenLastCalledWith({ tasks: [task], stale: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(api).toHaveBeenCalledTimes(6)
    attention.destroy()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deduplicates concurrent refreshes and ignores a timed-out response after a newer result', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    const old = deferred<unknown>(), onChange = vi.fn()
    const current = attentionTask('B', ['b-1'])
    const api = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ tasks: [current] })
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: api, invoke: vi.fn(), onChange, intervalMs: 100, requestTimeoutMs: 50 })
    const first = attention.start()
    const again = attention.refresh()
    expect(api).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all([first, again])
    await vi.advanceTimersByTimeAsync(200)
    expect(onChange).toHaveBeenLastCalledWith({ tasks: [current], stale: false })
    const calls = onChange.mock.calls.length
    old.resolve({ tasks: [attentionTask('A', ['a-1'])] })
    await Promise.resolve()
    expect(onChange).toHaveBeenCalledTimes(calls)
    attention.destroy()
  })

  it('ignores inflight work on destroy and cleans up its timers', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    const pending = deferred<unknown>(), onChange = vi.fn(), invoke = vi.fn()
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: () => pending.promise, invoke, onChange })
    const started = attention.start()
    attention.destroy()
    pending.resolve({ tasks: [attentionTask('A', ['a-1'])] })
    await started
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('global workbench attention entry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens exact pending tasks without sending a request and disappears when all requests resolve', async () => {
    const { mountWorkbenchAttention } = await import('./workbench-attention.js')
    const { host, documentTarget } = dom()
    let tasks = [attentionTask('A', ['a-1']), attentionTask('B', ['b-1'], { title: '<img src=x onerror=alert(1)>' })]
    const api = vi.fn(async (_method: string, _path: string) => ({ tasks })), openTask = vi.fn(async () => undefined)
    const attention = mountWorkbenchAttention({ host: host as any, documentTarget: documentTarget as any, invokeWorkbenchApi: api, invoke: vi.fn(), openTask })
    await attention.start()
    expect(host.hidden).toBe(false)
    const toggle = host.find(element => element.getAttribute('aria-controls') === 'workbench-attention-tasks')!
    toggle.dispatch('click')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const second = host.find(element => element.dataset.taskId === 'B')!
    expect(second.textContent).toContain('<img src=x onerror=alert(1)>')
    second.dispatch('click')
    await Promise.resolve()
    expect(openTask).toHaveBeenCalledWith('B')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    tasks = [attentionTask('A', ['a-1'])]
    await attention.refresh()
    toggle.dispatch('click')
    await Promise.resolve()
    expect(openTask).toHaveBeenLastCalledWith('A')
    tasks = []
    await attention.refresh()
    expect(host.hidden).toBe(true)
    attention.destroy()
  })

  it('preserves keyboard access during polling and closes the transient choices with Escape or outside click', async () => {
    const { mountWorkbenchAttention } = await import('./workbench-attention.js')
    const { host, documentTarget } = dom()
    const tasks = [attentionTask('A', ['a-1']), attentionTask('B', ['b-1'])]
    const attention = mountWorkbenchAttention({ host: host as any, documentTarget: documentTarget as any, invokeWorkbenchApi: async () => ({ tasks }), invoke: vi.fn(), openTask: vi.fn() })
    await attention.start()
    const toggle = host.find(element => element.getAttribute('aria-controls') === 'workbench-attention-tasks')!
    toggle.dispatch('click')
    const second = host.find(element => element.dataset.taskId === 'B')!
    second.focus()
    await attention.refresh()
    expect(documentTarget.activeElement).toBe(second)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    documentTarget.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(documentTarget.activeElement).toBe(toggle)
    toggle.dispatch('click')
    documentTarget.dispatch('pointerdown', { target: documentTarget.createElement('button') })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    attention.destroy()
    expect([...documentTarget.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(host.hidden).toBe(true)
  })

  it('keeps the visible entry actionable after native notifications are denied', async () => {
    const { mountWorkbenchAttention } = await import('./workbench-attention.js')
    const { host, documentTarget } = dom()
    let tasks: ReturnType<typeof attentionTask>[] = []
    const openTask = vi.fn(), invoke = vi.fn(async () => { throw new Error('denied') })
    const attention = mountWorkbenchAttention({ host: host as any, documentTarget: documentTarget as any, invokeWorkbenchApi: async () => ({ tasks }), invoke, openTask })
    await attention.start()
    tasks = [attentionTask('A', ['a-1'])]
    await attention.refresh()
    expect(host.hidden).toBe(false)
    host.find(element => element.getAttribute('aria-controls') === 'workbench-attention-tasks')!.dispatch('click')
    expect(openTask).toHaveBeenCalledWith('A')
    await attention.refresh()
    expect(invoke).toHaveBeenCalledTimes(1)
    attention.destroy()
  })

  it('allows a newer destination while an older task is still opening and ignores stale clicks', async () => {
    const { mountWorkbenchAttention } = await import('./workbench-attention.js')
    const { host, documentTarget } = dom()
    const older = deferred<void>()
    let tasks = [attentionTask('A', ['a-1']), attentionTask('B', ['b-1'])]
    const openTask = vi.fn((id: string) => id === 'A' ? older.promise : Promise.resolve())
    const attention = mountWorkbenchAttention({ host: host as any, documentTarget: documentTarget as any, invokeWorkbenchApi: async () => ({ tasks }), invoke: vi.fn(), openTask })
    await attention.start()
    const first = host.find(element => element.dataset.taskId === 'A')!
    first.dispatch('click')
    first.dispatch('click')
    host.find(element => element.dataset.taskId === 'B')!.dispatch('click')
    expect(openTask.mock.calls.map(([id]) => id)).toEqual(['A', 'B'])
    tasks = [attentionTask('B', ['b-1'])]
    await attention.refresh()
    first.dispatch('click')
    expect(openTask.mock.calls.map(([id]) => id)).toEqual(['A', 'B'])
    older.resolve()
    await Promise.resolve()
    attention.destroy()
  })
})
