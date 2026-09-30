import { describe, it, expect, vi } from 'vitest'
import { makePhoneNotifier } from './phone-notifier'

function harness(opts: { registered?: string[]; online?: string[]; tasks?: Record<string, { title: string; status: string }>; throwTask?: string; notifyThrowsFor?: string } = {}) {
  const handlers = new Map<string, (ev: { epoch: string; seq: number; data: unknown }) => void>()
  const unsubs: string[] = []
  const events = {
    subscribe: vi.fn((topic: string, _since: unknown, send: (ev: any) => void) => { handlers.set(topic, send); return () => { unsubs.push(topic); handlers.delete(topic) } }),
  }
  let registered = opts.registered ?? ['dev1', 'dev2']
  const notify = vi.fn((id: string, _p: unknown) => { if (id === opts.notifyThrowsFor) throw new Error('down'); return true })
  const n = makePhoneNotifier({
    events, push: { registered: () => registered, notify },
    subscribedDevices: () => new Set(opts.online ?? []),
    taskInfo: (id) => { if (opts.throwTask === id) throw new Error('boom'); return opts.tasks?.[id] ?? null },
    log: () => {},
  })
  let seq = 0
  const emit = (topic: string, data: unknown) => handlers.get(topic)!({ epoch: 'e', seq: ++seq, data })
  return { n, events, handlers, unsubs, notify, emit, setRegistered: (r: string[]) => { registered = r } }
}

const agents = (tasks: Array<{ id: string; title: string; phase: string }>) => ({ running: 0, waiting: 0, tasks })

describe('phone-notifier', () => {
  it('没登记设备就不订阅;有了才订阅,没了退订', () => {
    const h = harness({ registered: [] })
    h.n.refresh()
    expect(h.events.subscribe).not.toHaveBeenCalled()
    h.setRegistered(['dev1']); h.n.refresh()
    expect([...h.handlers.keys()].sort()).toEqual(['agents', 'approvals'])
    h.setRegistered([]); h.n.refresh()
    expect(h.unsubs.sort()).toEqual(['agents', 'approvals'])
  })

  it('第一份快照是基线,不推;新出现的待批准 ⇒ 推给不在线的设备', () => {
    const h = harness({ online: ['dev2'], tasks: { ab12cd34: { title: '修登录', status: 'running' } } })
    h.n.refresh()
    h.emit('approvals', [{ taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: rm -rf build' }])
    expect(h.notify).not.toHaveBeenCalled()
    h.emit('approvals', [
      { taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: rm -rf build' },
      { taskId: 'ab12cd34', kind: 'question', id: 'q1', summary: '用哪个分支?' },
    ])
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith('dev1', { kind: 'question', title: 'CC 有问题问你', body: '修登录:用哪个分支?', taskId: 'ab12cd34' })
  })

  it('working → replied ⇒ task_done;离开列表且 failed ⇒ task_failed;cancelled 不推', () => {
    const h = harness({ registered: ['dev1'], tasks: { t1: { title: 'A', status: 'running' }, t2: { title: 'B', status: 'failed' }, t3: { title: 'C', status: 'cancelled' } } })
    h.n.refresh()
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'working' }, { id: 't2', title: 'B', phase: 'working' }, { id: 't3', title: 'C', phase: 'working' }]))
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'replied' }]))
    const kinds = h.notify.mock.calls.map(c => (c[1] as any).kind + ':' + (c[1] as any).taskId).sort()
    expect(kinds).toEqual(['task_done:t1', 'task_failed:t2'])
  })

  it('已经 replied 的任务再离开列表(completed)不重复推', () => {
    const h = harness({ registered: ['dev1'], tasks: { t1: { title: 'A', status: 'completed' } } })
    h.n.refresh()
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'working' }]))
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'replied' }]))
    h.emit('agents', agents([]))
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('两台都在线 ⇒ 一条不推', () => {
    const h = harness({ online: ['dev1', 'dev2'] })
    h.n.refresh()
    h.emit('approvals', [])
    h.emit('approvals', [{ taskId: 'x', kind: 'permission', id: 'p', summary: 's' }])
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('taskInfo 抛错:handler 不抛,后续新事件照推', () => {
    const h = harness({ registered: ['dev1'], throwTask: 'bad', tasks: { good: { title: 'G', status: 'running' } } })
    h.n.refresh()
    h.emit('approvals', [])
    expect(() => h.emit('approvals', [{ taskId: 'bad', kind: 'permission', id: 'p', summary: 's' }])).not.toThrow()
    h.emit('approvals', [{ taskId: 'good', kind: 'permission', id: 'p2', summary: 's2' }])
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith('dev1', expect.objectContaining({ taskId: 'good' }))
  })

  it('畸形数据(null 元素 / 非数组)不抛,后续合法事件照推', () => {
    const h = harness({ registered: ['dev1'] })
    h.n.refresh()
    expect(() => h.emit('approvals', [])).not.toThrow()
    expect(() => h.emit('approvals', [null, 3, { taskId: 'x' }])).not.toThrow()
    expect(() => h.emit('approvals', 'nope')).not.toThrow()
    expect(() => h.emit('agents', { tasks: 'x' })).not.toThrow()
    expect(() => h.emit('agents', null)).not.toThrow()
    expect(() => h.emit('agents', { tasks: [null, { id: 't', title: 'T', phase: 'working' }] })).not.toThrow()
    h.emit('agents', { tasks: [{ id: 't', title: 'T', phase: 'replied' }] })
    h.emit('approvals', [{ taskId: 'y', kind: 'permission', id: 'p', summary: 's' }])
    expect(h.notify.mock.calls.map(c => (c[1] as any).kind).sort()).toEqual(['permission', 'task_done'])
  })

  it('一台设备 notify 抛错,另一台照样收到', () => {
    const h = harness({ registered: ['dev1', 'dev2'], notifyThrowsFor: 'dev1' })
    h.n.refresh()
    h.emit('approvals', [])
    expect(() => h.emit('approvals', [{ taskId: 'x', kind: 'permission', id: 'p', summary: 's' }])).not.toThrow()
    expect(h.notify.mock.calls.map(c => c[0])).toEqual(['dev1', 'dev2'])
  })
})
