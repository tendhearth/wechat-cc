import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

let window: Window
let memory: typeof import('./memory.js')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }

beforeEach(async () => {
  vi.resetModules()
  window = new Window()
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('localStorage', window.localStorage)
  vi.stubGlobal('MutationObserver', window.MutationObserver)
  document.body.innerHTML = `<article data-pane="memory"><div id="memory-profile-overview"></div><div id="memory-sidebar"></div>
    <div id="memory-content-head" hidden><span id="memory-content-path"></span><span id="memory-content-mtime"></span></div>
    <p id="memory-status" hidden></p><div id="memory-rendered"></div><textarea id="memory-editor" hidden></textarea>
    <button id="memory-edit-btn" hidden></button><button id="memory-save-btn" hidden></button><button id="memory-cancel-btn" hidden></button></article>`
  memory = await import('./memory.js')
})
afterEach(() => { window.close(); vi.unstubAllGlobals() })

it('a file read dropped while the pane was hidden is re-issued on return, so header, body, edit and save all agree', async () => {
  let slowB: ReturnType<typeof deferred<unknown>> | null = deferred()
  const writes: unknown[] = []
  const call = vi.fn((method: string, path: string, body?: unknown) => {
    if (path === '/v1/memory/files') return Promise.resolve([{ userId: 'u1', fileCount: 2, files: [{ path: 'a.md', mtime: '', size: 1 }, { path: 'b.md', mtime: '', size: 1 }] }])
    if (path.startsWith('/v1/memory/file?') && path.includes('a.md')) return Promise.resolve({ ok: true, content: 'AAA' })
    if (path.startsWith('/v1/memory/file?') && path.includes('b.md')) {
      if (slowB) { const p = slowB.promise; return p }
      return Promise.resolve({ ok: true, content: 'BBB' })
    }
    if (method === 'POST' && path === '/v1/memory/file/write') { writes.push(body); return Promise.resolve({ ok: true, bytesWritten: 3 }) }
    return Promise.resolve({ ok: false, error: 'unused' })
  })
  const deps = { invoke: vi.fn(), invokeApi: vi.fn(), invokeWorkbenchApi: call, doctorPoller: { current: null }, formatInvokeError: String } as any
  memory.wireMemoryButtons(deps)
  await memory.loadMemoryPane(deps)
  const file = (p: string) => document.querySelector<HTMLButtonElement>(`.mem-file[data-path="${p}"]`)!
  const pane = document.querySelector('article[data-pane="memory"]')!
  const rendered = document.getElementById('memory-rendered')!
  const editBtn = document.getElementById('memory-edit-btn')!

  file('a.md').click(); await flush()
  expect(rendered.innerHTML).toContain('AAA')
  file('b.md').click(); await flush()
  pane.setAttribute('hidden', ''); await flush()
  const gate = slowB!; slowB = null
  gate.resolve({ ok: true, content: 'BBB-late' }); await flush()
  pane.removeAttribute('hidden'); await flush()

  expect(document.getElementById('memory-content-path')!.textContent).toContain('b.md')
  expect(rendered.innerHTML).not.toContain('读取中')
  expect(rendered.innerHTML).toContain('BBB')
  expect(editBtn.hidden).toBe(false)
  editBtn.click()
  ;(document.getElementById('memory-editor') as HTMLTextAreaElement).value = 'BBB edited'
  document.getElementById('memory-save-btn')!.click(); await flush()
  expect(writes).toEqual([{ userId: 'u1', path: 'b.md', content: 'BBB edited' }])
})
