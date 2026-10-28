import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

let window: Window
let memory: typeof import('./memory.js')
const item = (key = 'c:one') => ({ key, text: `收回的记录 ${key}`, section: '偏好', day: '2026-10-28' })
const restoredNote = '已恢复记忆。当初从笔记中删掉的行不会恢复。'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function mount() {
  document.body.innerHTML = '<article data-pane="memory"><div id="memory-retractions"></div><p id="memory-retractions-note" role="status"></p></article>'
}
function deps(call: any) {
  return { invoke: vi.fn(), invokeApi: vi.fn(), invokeWorkbenchApi: call, doctorPoller: { current: null }, formatInvokeError: (err: unknown) => String(err instanceof Error ? err.message : err) }
}
const note = () => document.getElementById('memory-retractions-note')!
const button = () => document.querySelector<HTMLButtonElement>('[data-action="restore-retraction"]')!

beforeEach(async () => {
  vi.resetModules()
  window = new Window()
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('localStorage', window.localStorage)
  mount()
  memory = await import('./memory.js')
})
afterEach(() => { window.close(); vi.unstubAllGlobals() })

describe('memory retraction recovery through the system API', () => {
  it('synchronously locks duplicate restores so serialized 404 cannot replace success', async () => {
    const gate = deferred<void>()
    let rows = [item()]
    let serial = Promise.resolve()
    const call = vi.fn((method: string, path: string) => {
      if (method === 'GET') return Promise.resolve({ ok: true, items: rows })
      const pending = serial.then(async () => {
        await gate.promise
        if (!rows.length) throw new Error('memory_retraction_not_found (404)')
        rows = []
        return { ok: true, note: restoredNote }
      })
      serial = pending.then(() => {}, () => {})
      return pending
    })
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const first = memory.restoreMemoryRetraction(d, 'c:one')
    const busy = button().getAttribute('aria-busy'), disabled = button().disabled
    const second = memory.restoreMemoryRetraction(d, 'c:one')
    gate.resolve()
    await Promise.all([first, second])
    expect.soft(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
    expect.soft(busy).toBe('true')
    expect.soft(disabled).toBe(true)
    expect(note().textContent).toBe(restoredNote)
    expect(document.getElementById('memory-retractions')!.textContent).toContain('还没有收回过什么')
  })

  it('retains the entity lock through a list refresh and allows retry after genuine failure', async () => {
    const gate = deferred<any>()
    const call = vi.fn((method: string) => method === 'GET' ? Promise.resolve({ ok: true, items: [item()] }) : gate.promise)
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const first = memory.restoreMemoryRetraction(d, 'c:one')
    await memory.loadMemoryRetractions(d)
    const duringRefresh = button().disabled
    const duplicate = memory.restoreMemoryRetraction(d, 'c:one')
    gate.resolve({ ok: false, code: 'memory_retraction_not_found' })
    await Promise.all([first, duplicate])
    expect.soft(duringRefresh).toBe(true)
    expect.soft(note().textContent).toContain('没恢复成')
    expect.soft(button().disabled).toBe(false)
    call.mockImplementation((method: string) => Promise.resolve(method === 'GET' ? { ok: true, items: [] } : { ok: true, note: restoredNote }))
    await memory.restoreMemoryRetraction(d, 'c:one')
    expect(note().textContent).toBe(restoredNote)
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2)
  })

  it('keeps the lock until the authoritative post-restore list has settled', async () => {
    const refresh = deferred<any>()
    const call = vi.fn().mockResolvedValueOnce({ ok: true, items: [item()] }).mockResolvedValueOnce({ ok: true, note: restoredNote }).mockReturnValueOnce(refresh.promise)
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const pending = memory.restoreMemoryRetraction(d, 'c:one')
    await Promise.resolve(); await Promise.resolve()
    const disabled = button().disabled
    const duplicate = memory.restoreMemoryRetraction(d, 'c:one')
    refresh.resolve({ ok: true, items: [] })
    await Promise.all([pending, duplicate])
    expect.soft(disabled).toBe(true)
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
    expect(note().textContent).toBe(restoredNote)
  })

  it('keeps a successful record locked when reopening supersedes its post-restore refresh', async () => {
    const oldRead = deferred<any>(), reopenedRead = deferred<any>(), refreshing = deferred<void>()
    let reads = 0, restores = 0
    const call = vi.fn((method: string) => {
      if (method === 'POST') {
        restores++
        return restores === 1 ? Promise.resolve({ ok: true, note: restoredNote }) : Promise.reject(new Error('memory_retraction_not_found (404)'))
      }
      reads++
      if (reads === 1) return Promise.resolve({ ok: true, items: [item()] })
      if (reads === 2) { refreshing.resolve(); return oldRead.promise }
      if (reads === 3) return reopenedRead.promise
      return Promise.resolve({ ok: true, items: [] })
    })
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const restoring = memory.restoreMemoryRetraction(d, 'c:one')
    await refreshing.promise
    const reopening = memory.loadMemoryRetractions(d)
    oldRead.resolve({ ok: true, items: [] })
    await restoring
    expect.soft(button().disabled).toBe(true)
    expect.soft(button().getAttribute('aria-busy')).toBeNull()
    expect.soft(button().textContent).toBe('已恢复')
    await memory.restoreMemoryRetraction(d, 'c:one')
    expect.soft(restores).toBe(1)
    expect.soft(note().textContent).toBe(restoredNote)
    reopenedRead.resolve({ ok: true, items: [] })
    await reopening
    expect(document.querySelector('[data-action="restore-retraction"]')).toBeNull()
    expect(note().textContent).toBe(restoredNote)
  })

  it('keeps a successful record locked when another record invalidates its refresh', async () => {
    const oldRead = deferred<any>(), secondRestore = deferred<any>(), refreshing = deferred<void>()
    let reads = 0
    const posted: string[] = []
    const call = vi.fn((method: string, _path: string, body?: any) => {
      if (method === 'POST') {
        posted.push(body.key)
        if (body.key === 'c:two') return secondRestore.promise
        return posted.filter(key => key === 'c:one').length === 1 ? Promise.resolve({ ok: true, note: restoredNote }) : Promise.reject(new Error('memory_retraction_not_found (404)'))
      }
      reads++
      if (reads === 1) return Promise.resolve({ ok: true, items: [item(), item('c:two')] })
      if (reads === 2) { refreshing.resolve(); return oldRead.promise }
      return Promise.resolve({ ok: true, items: [] })
    })
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const first = memory.restoreMemoryRetraction(d, 'c:one')
    await refreshing.promise
    const second = memory.restoreMemoryRetraction(d, 'c:two')
    oldRead.resolve({ ok: true, items: [item('c:two')] })
    await first
    const firstButton = document.querySelector<HTMLButtonElement>('[data-key="c:one"][data-action="restore-retraction"]')!
    expect.soft(firstButton.disabled).toBe(true)
    const latestFeedback = note().textContent
    await memory.restoreMemoryRetraction(d, 'c:one')
    expect.soft(posted).toEqual(['c:one', 'c:two'])
    expect.soft(note().textContent).toBe(latestFeedback)
    secondRestore.resolve({ ok: true, note: restoredNote })
    await second
    expect(document.querySelector('[data-action="restore-retraction"]')).toBeNull()
    expect(note().textContent).toBe(restoredNote)
  })

  it('releases a retained lock on a reopened view without overwriting its feedback', async () => {
    const old = deferred<any>()
    const call = vi.fn((method: string) => method === 'GET' ? Promise.resolve({ ok: true, items: [item()] }) : old.promise)
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const pending = memory.restoreMemoryRetraction(d, 'c:one')
    mount()
    await memory.loadMemoryRetractions(d)
    expect(button().disabled).toBe(true)
    note().textContent = '重新打开后的提示'
    old.resolve({ ok: false, code: 'failed' })
    await pending
    expect(button().disabled).toBe(false)
    expect(button().getAttribute('aria-busy')).toBeNull()
    expect(note().textContent).toBe('重新打开后的提示')
  })

  it('does not let an older list read replace a newer list', async () => {
    const old = deferred<any>()
    const call = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, items: [item('c:new')] })
    const d = deps(call)
    const opening = memory.loadMemoryRetractions(d)
    await memory.loadMemoryRetractions(d)
    old.resolve({ ok: true, items: [item('c:old')] })
    await opening
    expect(button().dataset.key).toBe('c:new')
  })

  it('does not populate a replacement view or refresh it when an old restore completes', async () => {
    const old = deferred<any>()
    const call = vi.fn((method: string) => method === 'GET' ? Promise.resolve({ ok: true, items: [item()] }) : old.promise)
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const pending = memory.restoreMemoryRetraction(d, 'c:one')
    mount()
    note().textContent = '另一视图的提示'
    document.getElementById('memory-retractions')!.textContent = '另一视图的内容'
    const reads = call.mock.calls.filter(([method]) => method === 'GET').length
    old.resolve({ ok: true, note: restoredNote })
    await pending
    expect(note().textContent).toBe('另一视图的提示')
    expect(document.getElementById('memory-retractions')!.textContent).toBe('另一视图的内容')
    expect(call.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(reads)
  })

  it('keeps the newer entity feedback when an earlier restore fails late', async () => {
    const old = deferred<any>()
    const call = vi.fn((method: string, _path: string, body?: any) => method === 'GET' ? Promise.resolve({ ok: true, items: [item('c:one')] }) : body.key === 'c:one' ? old.promise : Promise.resolve({ ok: true, note: restoredNote }))
    const d = deps(call)
    await memory.loadMemoryRetractions(d)
    const pending = memory.restoreMemoryRetraction(d, 'c:one')
    await memory.restoreMemoryRetraction(d, 'c:two')
    old.resolve({ ok: false, code: 'failed' })
    await pending
    expect(note().textContent).toBe(restoredNote)
  })
})
