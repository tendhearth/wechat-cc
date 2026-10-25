// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type ChatPageT } from '../backend/types'
import { clearDrafts, getDraft, listReceipts, putReceipt, setDraft } from './drafts'
import { makeStore, type Store } from './store'
import { useChat } from './useChat'

const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store } }))
vi.mock('./BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let view: ReturnType<typeof useChat>
const roots: Array<{ unmount(): void }> = []
function Probe() { view = useChat(); return null }
const page = (): ChatPageT => ({ matterId: 'owner-chat', title: 'CC', messages: [], pending: null, failed: null, hasMore: false, nextBefore: null })
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(chat: Backend['chat']) {
  const chatSay = vi.fn(makeDemoBackend({ lang: 'zh-Hans' }).chatSay)
  const backend = { ...makeDemoBackend({ lang: 'zh-Hans' }), chat, chatSay }
  host.ctx = { backend, store: makeStore(backend, { lang: 'zh-Hans' }) }
  const div = document.createElement('div'); document.body.appendChild(div)
  const root = createRoot(div); roots.push(root)
  await act(() => root.render(createElement(Probe))); await flush()
  return { backend, chatSay }
}
beforeEach(() => clearDrafts())
afterEach(async () => { await act(() => roots.splice(0).forEach(r => r.unmount())); document.body.innerHTML = '' })

describe('chat status checking is read-only', () => {
  it('refreshes history without resending, dropping unresolved receipts, or changing a draft', async () => {
    const read = vi.fn(async () => page())
    const h = await mount(read)
    setDraft('chat', '新的草稿')
    await act(() => putReceipt({ requestId: 'unconfirmed', text: '原文', at: Date.now(), localAt: Date.now() }))
    await act(async () => { await view.refresh() })
    expect(read).toHaveBeenCalledTimes(2)
    expect(h.chatSay).not.toHaveBeenCalled()
    expect(listReceipts().map(r => r.requestId)).toEqual(['unconfirmed'])
    expect(getDraft('chat')).toBe('新的草稿')
    expect(view.bubbles.some(b => b.requestId === 'unconfirmed' && b.state === 'failed')).toBe(true)
  })

  it('keeps unresolved status when reading fails even though the query promise resolves', async () => {
    let fail = false
    const h = await mount(async () => { if (fail) throw new BackendError('offline'); return page() })
    await act(() => putReceipt({ requestId: 'uncertain', text: '原文', at: Date.now(), localAt: Date.now() }))
    fail = true
    await act(async () => { await view.refresh() })
    expect(view.error).toBe('offline')
    expect(view.loading).toBe(false)
    expect(listReceipts().map(r => r.requestId)).toEqual(['uncertain'])
    expect(h.chatSay).not.toHaveBeenCalled()
  })

  it('shows loading while checking and only settles a receipt when actual matching history arrives', async () => {
    let resolve: ((value: ChatPageT) => void) | undefined
    let hold = false
    await mount(async () => hold ? new Promise(r => { resolve = r }) : page())
    const at = Date.now()
    await act(() => putReceipt({ requestId: 'landed', text: '原文', at, localAt: at }))
    hold = true
    let done!: Promise<void>
    await act(() => { done = view.refresh() })
    expect(view.loading).toBe(true)
    await act(async () => { resolve!({ ...page(), messages: [{ id: 'message', role: 'me', kind: 'text', source: 'phone', text: '原文', at, truncated: false }] }); await done })
    expect(view.loading).toBe(false)
    expect(listReceipts()).toEqual([])
  })
})
