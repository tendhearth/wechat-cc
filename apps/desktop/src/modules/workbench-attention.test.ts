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

  it('notifies once when a task goes from working to replied or stopped while the window is in the background (2026-10-06)', async () => {
    const { createWorkbenchAttentionPoller } = await import('./workbench-attention.js')
    let progress: Array<{ id: string; phase: string }> = [{ id: 'A', phase: 'working' }, { id: 'B', phase: 'working' }, { id: 'C', phase: 'working' }]
    let focused = false
    const invoke = vi.fn(async () => {})
    const attention = createWorkbenchAttentionPoller({ invokeWorkbenchApi: async () => ({ tasks: [], progress }), invoke, onChange: vi.fn(), getContext: () => ({ taskId: null, focused }) })
    await attention.refresh()
    expect(invoke).not.toHaveBeenCalled()                       // 第一次只是记下现状
    progress = [{ id: 'A', phase: 'replied' }, { id: 'B', phase: 'cancelled' }, { id: 'C', phase: 'working' }]
    await attention.refresh(); await Promise.resolve(); await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('notify_user', { title: '一起做有回复了', body: '有一件事回复了。打开 CC 查看。' })
    progress = [{ id: 'A', phase: 'replied' }, { id: 'C', phase: 'interrupted' }]
    await attention.refresh(); await Promise.resolve(); await Promise.resolve()
    expect(invoke).toHaveBeenLastCalledWith('notify_user', { title: '一起做有任务停下了', body: '打开 CC 看看发生了什么。' })
    // 窗口在前面:不弹
    progress = [{ id: 'D', phase: 'working' }]; await attention.refresh()
    focused = true; progress = [{ id: 'D', phase: 'replied' }]
    await attention.refresh(); await Promise.resolve(); await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(2)
    attention.destroy()
  })

  it('an older daemon without progress never notifies about replies', async () => {
    const { progressTransitions, parseProgress } = await import('./workbench-attention.js')
    expect(parseProgress({ tasks: [] })).toBeNull()
    expect(progressTransitions(null, new Map([['A', 'replied']]))).toEqual({ replied: [], stopped: [] })
    expect(progressTransitions(new Map([['A', 'queued']]), new Map([['A', 'replied']]))).toEqual({ replied: [], stopped: [] })
  })
})
