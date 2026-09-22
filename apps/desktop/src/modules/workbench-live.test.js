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
  it('waitingFor.closeInMs 现算的秒数不算结构;holderWriting 翻转才算(评审修复轮 2 #2)', () => {
    const waiting = { taskId: 'A', title: 'Holder', reason: 'same_path', holderWriting: false, closeInMs: 15000 }
    const withWaiting = { ...base, task: { ...base.task, waitingFor: waiting } }
    // 主人正看着这条排队任务、长轮询在计时武装期间收了一轮:只有 closeInMs 在走,签名不该变——
    // 不然 applyLiveDetail 判 restructured 就会 paint(true) 无条件全量重画,绕过 paintKey() 那道去重。
    expect(structuralSignature({ ...withWaiting, task: { ...withWaiting.task, waitingFor: { ...waiting, closeInMs: 3000 } } })).toBe(structuralSignature(withWaiting))
    expect(structuralSignature({ ...withWaiting, task: { ...withWaiting.task, waitingFor: { ...waiting, closeInMs: 0 } } })).toBe(structuralSignature(withWaiting))
    // 真正的转变(持有者不再安静,倒计时撤掉)必须照样算结构变化。
    expect(structuralSignature({ ...withWaiting, task: { ...withWaiting.task, waitingFor: { ...waiting, holderWriting: true, closeInMs: null } } })).not.toBe(structuralSignature(withWaiting))
    expect(structuralSignature({ ...withWaiting, task: { ...withWaiting.task, waitingFor: null } })).not.toBe(structuralSignature(withWaiting))
  })
  it('closeInMs 从 null(没计时)变成已武装必须单独算结构变化，不能被抹平成同一个键（终审 M1）', () => {
    // holderWriting 全程不变，唯一的差异是 closeInMs 从 null 变成 15000——补充投递失败后
    // armIdleClose 重新武装计时正是这个形状：不单独算结构变化，applyLiveDetail 就不会重画。
    const notArmed = { taskId: 'A', title: 'Holder', reason: 'same_path', holderWriting: false, closeInMs: null }
    const armed = { ...notArmed, closeInMs: 15000 }
    const withNotArmed = { ...base, task: { ...base.task, waitingFor: notArmed } }
    const withArmed = { ...base, task: { ...base.task, waitingFor: armed } }
    expect(structuralSignature(withArmed)).not.toBe(structuralSignature(withNotArmed))
  })
})

describe('patchLiveTimeline', () => {
  // 假 DOM:对话区带有序的孩子,因为「追加到哪一组」取决于位置。
  const operationList = () => ({ appended: [], insertAdjacentHTML(_pos, html) { this.appended.push(html) } })
  const liveGroup = () => {
    const list = operationList()
    return { tagName: 'DIV', dataset: { timelineGroup: '' }, live: true, list, querySelector: sel => sel === '.wb-operation-list' ? list : null }
  }
  const closedGroup = () => ({ tagName: 'DETAILS', dataset: { timelineGroup: '' }, live: false, querySelector: () => null })
  const messageNode = () => ({ tagName: 'ARTICLE', dataset: {}, live: false, querySelector: () => null })
  const dialogue = (children = []) => ({
    children, appended: [],
    get lastElementChild() { return this.children.at(-1) ?? null },
    querySelectorAll(sel) { return sel === '[data-timeline-group]:not(details)' ? this.children.filter(child => child.live) : [] },
    insertAdjacentHTML(_pos, html) { this.appended.push(html); this.children.push(messageNode()) },
  })
  // 找得到的那一行:outerHTML 是 setter,好观察替换;open 表示里面有展开着的详情。
  const row = (id, open = false) => ({ id, replaced: null, set outerHTML(value) { this.replaced = value }, querySelector: sel => open && sel.includes('[open]') ? { id: 'disclosure' } : null })
  const fakeRoot = (rows, dialogueNode) => ({
    rows: new Map(),
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1)
        if (!(id in rows)) return null
        if (!this.rows.has(id)) this.rows.set(id, row(id, rows[id]))
        return this.rows.get(id)
      }
      return sel === '.wb-dialogue' ? dialogueNode : null
    },
  })
  const render = { eventId: e => `wb-event-${e.id}`, message: e => `<m>${e.text}</m>`, operation: e => `<o>${e.text}</o>` }
  const activity = (id, text, status = 'running') => ev(id, text, { kind: 'tool_call', activity: { id: `a${id}`, type: 'command', status, label: text } })

  it('找得到的原位替换;找不到的追到末尾那个 live 组', () => {
    const group = liveGroup()
    const root = fakeRoot({ 'wb-event-1': false }, dialogue([messageNode(), group]))
    const result = patchLiveTimeline(root, [ev(1, 'x'), activity(2, 'y')], render)
    expect(result).toEqual({ patched: 1, appended: 1, missing: 0 })
    expect(group.list.appended).toEqual(['<o>y</o>'])
    expect(root.rows.get('wb-event-1').replaced).toBe('<m>x</m>')
  })

  it('live 组不是对话区最后一个孩子(后面还有消息)就不追加,记 missing', () => {
    const group = liveGroup()
    const root = fakeRoot({}, dialogue([group, messageNode()]))
    expect(patchLiveTimeline(root, [activity(2, 'ls')], render)).toEqual({ patched: 0, appended: 0, missing: 1 })
    expect(group.list.appended).toEqual([])
  })

  it('有好几个 live 组时追到最后那个', () => {
    const first = liveGroup(), last = liveGroup()
    const root = fakeRoot({}, dialogue([first, messageNode(), last]))
    expect(patchLiveTimeline(root, [activity(3, 'ls')], render)).toEqual({ patched: 0, appended: 1, missing: 0 })
    expect(first.list.appended).toEqual([])
    expect(last.list.appended).toEqual(['<o>ls</o>'])
  })

  it('整页渲染会提到组外的行(error / 失败 / 已停止 / 已中断)一律记 missing', () => {
    const group = liveGroup()
    const root = fakeRoot({ 'wb-event-4': false }, dialogue([group]))
    const changed = [ev(4, '出错了', { kind: 'error' }), activity(5, 'ls', 'failed'), activity(6, 'ls', 'cancelled'), activity(7, 'ls', 'interrupted')]
    expect(patchLiveTimeline(root, changed, render)).toEqual({ patched: 0, appended: 0, missing: 4 })
    expect(group.list.appended).toEqual([])
  })

  it('那一行里有展开着的详情就不替换(展开状态和焦点交给整页重画)', () => {
    const root = fakeRoot({ 'wb-event-8': true }, dialogue([liveGroup()]))
    expect(patchLiveTimeline(root, [activity(8, 'ls')], render)).toEqual({ patched: 0, appended: 0, missing: 1 })
    expect(root.rows.get('wb-event-8').replaced).toBe(null)
  })

  it('文字追到对话区末尾;它一旦追进去,后面的操作就没有安全位置了', () => {
    const group = liveGroup()
    const dialogueNode = dialogue([group])
    const root = fakeRoot({}, dialogueNode)
    const result = patchLiveTimeline(root, [ev(9, 'hi', { kind: 'user' }), activity(10, 'ls')], render)
    expect(result).toEqual({ patched: 0, appended: 1, missing: 1 })
    expect(dialogueNode.appended).toEqual(['<m>hi</m>'])
    expect(group.list.appended).toEqual([])
  })

  it('没有 live 组可追加时记成 missing(调用方整页重画)', () => {
    const root = fakeRoot({}, dialogue([closedGroup()]))
    expect(patchLiveTimeline(root, [activity(11, 'ls')], render)).toEqual({ patched: 0, appended: 0, missing: 1 })
  })

  it('没有对话区 / 没有变化时不碰 DOM', () => {
    expect(patchLiveTimeline(fakeRoot({}, null), [activity(12, 'ls')], render)).toEqual({ patched: 0, appended: 0, missing: 1 })
    expect(patchLiveTimeline(fakeRoot({}, dialogue([liveGroup()])), [], render)).toEqual({ patched: 0, appended: 0, missing: 0 })
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
