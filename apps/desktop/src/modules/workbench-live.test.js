import { describe, it, expect, vi } from 'vitest'
import { mergeEvents, structuralSignature, patchLiveTimeline, createLongPoll } from './workbench-live.js'

const ev = (id, text, extra = {}) => ({ id, taskId: 't', kind: 'text', text, createdAt: id, ...extra })

describe('mergeEvents', () => {
  it('已有 id 原位替换,新 id 按 id 升序插入', () => {
    const merged = mergeEvents([ev(1, 'a'), ev(3, 'c')], [ev(3, 'cc'), ev(2, 'b'), ev(4, 'd')])
    expect(merged.map(e => [e.id, e.text])).toEqual([[1, 'a'], [2, 'b'], [3, 'cc'], [4, 'd']])
  })
  it('空 incoming 返回同一引用', () => { const a = [ev(1, 'a')]; expect(mergeEvents(a, [])).toBe(a) })
  it('替换保留服务端送来的那个对象(身份可用于「最后一条回复」比较)', () => {
    const fresh = ev(1, 'aa')
    expect(mergeEvents([ev(1, 'a')], [fresh])[0]).toBe(fresh)
  })
})

describe('structuralSignature', () => {
  const base = { task: { status: 'running', phase: 'working', error: null }, runId: 'r', permissions: [{ id: 'p1' }], questions: [], artifacts: [{ id: 'a', sha256: 'x' }], inputs: [], runtime: { retained: false }, attachments: [], events: [ev(1, 'a')] }
  it('事件变化不改签名;状态/权限/成果变化改签名', () => {
    expect(structuralSignature({ ...base, events: [ev(1, 'a'), ev(2, 'b')] })).toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, task: { ...base.task, status: 'completed' } })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, permissions: [] })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, artifacts: [{ id: 'a', sha256: 'y' }] })).not.toBe(structuralSignature(base))
  })
  it('问题/待回答输入/运行时/附件数/交接数也算结构', () => {
    expect(structuralSignature({ ...base, questions: [{ id: 'q1' }] })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, inputs: [{ id: 'i1', status: 'pending' }] })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, runtime: { retained: true } })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, attachments: [{ id: 'f1' }] })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, handoffs: [{ id: 'h1' }] })).not.toBe(structuralSignature(base))
  })
  it('没有详情时是空串', () => { expect(structuralSignature(null)).toBe('') })
})

describe('patchLiveTimeline', () => {
  // 假节点:补丁函数用 `el.outerHTML = html` 替换,setter 把结果记下来。
  const node = (id) => ({ id, replaced: null, set outerHTML(value) { this.replaced = value } })
  const fakeRoot = (ids, liveList, dialogue = liveList) => {
    const found = []
    return {
      found,
      querySelector(sel) {
        if (sel.startsWith('#')) { const el = ids.includes(sel.slice(1)) ? node(sel.slice(1)) : null; if (el) found.push(el); return el }
        if (sel === '[data-timeline-group]:not(details) .wb-operation-list') return liveList
        if (sel === '.wb-dialogue') return dialogue
        return null
      },
    }
  }
  const list = () => ({ appended: [], insertAdjacentHTML(_pos, html) { this.appended.push(html) } })
  const render = { eventId: e => `wb-event-${e.id}`, message: e => `<m>${e.text}</m>`, operation: e => `<o>${e.text}</o>` }
  const activity = (id, text) => ev(id, text, { kind: 'tool_call', activity: { id: 'a', type: 'command', status: 'running', label: 'ls' } })

  it('找得到的替换,找不到的追加到 live 组', () => {
    const operations = list()
    const root = fakeRoot(['wb-event-1'], operations)
    const r = patchLiveTimeline(root, [ev(1, 'x'), activity(2, 'y')], render)
    expect(r).toEqual({ patched: 1, appended: 1, missing: 0 })
    expect(operations.appended).toEqual(['<o>y</o>'])
    expect(root.found[0].replaced).toBe('<m>x</m>')
  })
  it('文字追加到对话区,操作追加到 live 组', () => {
    const operations = list(), dialogue = list()
    const root = fakeRoot([], operations, dialogue)
    const r = patchLiveTimeline(root, [ev(5, 'hi', { kind: 'user' }), activity(6, 'ls')], render)
    expect(r).toEqual({ patched: 0, appended: 2, missing: 0 })
    expect(dialogue.appended).toEqual(['<m>hi</m>'])
    expect(operations.appended).toEqual(['<o>ls</o>'])
  })
  it('没有 live 组可追加时记成 missing(调用方整页重画)', () => {
    const root = fakeRoot([], null, null)
    expect(patchLiveTimeline(root, [activity(7, 'ls')], render)).toEqual({ patched: 0, appended: 0, missing: 1 })
  })
  it('没有变化时不碰 DOM', () => {
    const root = fakeRoot([], null, null)
    expect(patchLiveTimeline(root, [], render)).toEqual({ patched: 0, appended: 0, missing: 0 })
  })
})

describe('createLongPoll', () => {
  const deferred = () => { let resolve = () => {}, reject = () => {}; const promise = new Promise((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
  const harness = (options = {}) => {
    const calls = []
    let pending = deferred()
    const fetchDetail = vi.fn((id, since, waitMs) => { calls.push([id, since, waitMs]); pending = deferred(); return pending.promise })
    const onDetail = vi.fn(), onError = vi.fn()
    const poll = createLongPoll({ fetchDetail, onDetail, onError, waitMs: 20000, backoff: [100, 200], ...options })
    return { calls, onDetail, onError, poll, current: () => pending }
  }

  it('循环拉取、since 跟着 version 走、stop 后不再回调', async () => {
    vi.useFakeTimers()
    const { calls, onDetail, poll, current } = harness()
    poll.start('t', 0)
    expect(poll.active).toBe(true)
    expect(calls).toEqual([['t', 0, 20000]])
    current().resolve({ version: 1, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([['t', 0, 20000], ['t', 1, 20000]])
    expect(onDetail).toHaveBeenCalledTimes(1)
    current().resolve({ version: 4, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[2]).toEqual(['t', 4, 20000])
    expect(onDetail).toHaveBeenCalledTimes(2)
    poll.stop()
    expect(poll.active).toBe(false)
    current().resolve({ version: 9, events: [] })
    await vi.advanceTimersByTimeAsync(5000)
    expect(onDetail).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(3)
    vi.useRealTimers()
  })

  it('出错退避,重试用原来的 since,成功后退避归零', async () => {
    vi.useFakeTimers()
    const { calls, onError, poll, current } = harness()
    poll.start('t', 7)
    current().reject(new Error('net'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls[1]).toEqual(['t', 7, 20000])
    current().reject(new Error('net'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(3)
    current().resolve({ version: 8, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    current().reject(new Error('net'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(5)
    poll.stop()
    vi.useRealTimers()
  })

  it('stop 之后到达的失败也不回调', async () => {
    vi.useFakeTimers()
    const { onError, poll, current } = harness()
    poll.start('t', 0)
    poll.stop()
    current().reject(new Error('net'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('再次 start 会甩掉上一轮:旧响应不回调,新循环用新的 since', async () => {
    vi.useFakeTimers()
    const { calls, onDetail, poll, current } = harness()
    poll.start('a', 0)
    const stale = current()
    poll.start('b', 3)
    expect(calls).toEqual([['a', 0, 20000], ['b', 3, 20000]])
    stale.resolve({ version: 99, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(onDetail).not.toHaveBeenCalled()
    poll.stop()
    vi.useRealTimers()
  })

  it('onDetail 里 stop 掉就不再继续', async () => {
    vi.useFakeTimers()
    const calls = []
    let pending = deferred()
    const fetchDetail = vi.fn((id, since) => { calls.push([id, since]); pending = deferred(); return pending.promise })
    const poll = createLongPoll({ fetchDetail, onDetail: () => poll.stop(), backoff: [100] })
    poll.start('t', 0)
    pending.resolve({ version: 1, events: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
    expect(poll.active).toBe(false)
    vi.useRealTimers()
  })

  it('响应没有数字 version(旧后台)就停下来,不空转', async () => {
    vi.useFakeTimers()
    const { calls, poll, current } = harness()
    poll.start('t', 0)
    current().resolve({ events: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
    expect(poll.active).toBe(false)
    vi.useRealTimers()
  })
})
