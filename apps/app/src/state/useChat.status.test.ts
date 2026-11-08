// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type ChatPageT } from '../backend/types'
import { clearDrafts, getDraft, listReceipts, putReceipt, setDraft } from './drafts'
import { withProviders } from './providers.test-support'
import { useChat } from './useChat'

const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
// 真 BackendProvider(注入假后端);它要 react-native 的 AppState、useLang 要系统语言 —— 都是设备边界。
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let view: ReturnType<typeof useChat>
const roots: Array<{ unmount(): void }> = []
function Probe() { view = useChat(); return null }
const page = (): ChatPageT => ({ matterId: 'owner-chat', title: 'CC', messages: [], pending: null, failed: null, hasMore: false, nextBefore: null })
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(chat: Backend['chat'],extra:Partial<Backend>={}) {
  const chatSay = vi.fn(makeDemoBackend({ lang: 'zh-Hans' }).chatSay)
  const backend = { ...makeDemoBackend({ lang: 'zh-Hans' }), chat, chatSay, ...extra }
  const div = document.createElement('div'); document.body.appendChild(div)
  const root = createRoot(div); roots.push(root)
  await act(() => root.render(withProviders(createElement(Probe), { backend }))); await flush()
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


it('T5d seeks old messages directly and retains the anchor across refresh, with id-based earlier pagination',async()=>{
  const row=(id:string)=>({messageId:id,kind:'text' as const,text:id,createdAt:1,source:'wechat'})
  const window=vi.fn(async(p:{anchor?:string;before?:string})=>({messages:[row(p.anchor??'earlier')],anchor:p.anchor??null,earlier:p.anchor?'old':null,later:null}))
  const read=vi.fn(async()=>page()),h=await mount(read,{conversationWindow:window})
  setDraft('chat','draft')
  await act(async()=>{expect(await view.seek('old')).toBe(true)})
  expect(window).toHaveBeenCalledWith({anchor:'old'})
  expect(read).toHaveBeenCalledTimes(1)
  await act(async()=>view.refresh())
  expect(view.bubbles.map(b=>b.key)).toContain('old')
  await act(async()=>view.loadOlder())
  expect(window).toHaveBeenLastCalledWith({before:'old'})
  expect(view.bubbles.map(b=>b.key)).toContain('earlier')
  await act(async()=>view.refresh())
  expect(view.bubbles.map(b=>b.key)).toEqual(expect.arrayContaining(['old','earlier']))
  expect(getDraft('chat')).toBe('draft');expect(h.chatSay).not.toHaveBeenCalled()
})

it('bridges the gap from an old anchor to the latest page with later cursors',async()=>{
  const message=(id:string,at:number)=>({messageId:id,kind:'text' as const,text:id,createdAt:at,source:'wechat'})
  const window=vi.fn(async(p:{anchor?:string;after?:string})=>p.anchor?{messages:[message('old',1)],anchor:'old',earlier:null,later:'old'}:p.after==='old'?{messages:[message('middle',2)],anchor:null,earlier:'middle',later:'middle'}:{messages:[message('new',3)],anchor:null,earlier:'new',later:null})
  await mount(async()=>({...page(),messages:[{id:'new',kind:'text',role:'cc',text:'new',at:3,source:'wechat',truncated:false}]}),{conversationWindow:window})
  await act(async()=>{await view.seek('old')})
  expect(view.canLoadLater).toBe(true)
  await act(async()=>view.loadLater())
  expect(window).toHaveBeenLastCalledWith({after:'old'});expect(view.laterAfterId).toBe('middle')
  await act(async()=>view.loadLater())
  expect(window).toHaveBeenLastCalledWith({after:'middle'});expect(view.canLoadLater).toBe(false)
  expect(view.bubbles.map(b=>b.key)).toEqual(['old','middle','new'])
})

it('keeps the earliest boundary when later pages are appended',async()=>{
  const message=(id:string,at:number)=>({messageId:id,kind:'text' as const,text:id,createdAt:at,source:'wechat'})
  const window=vi.fn(async(p:{anchor?:string;after?:string;before?:string})=>p.anchor?{messages:[message('old',2)],anchor:'old',earlier:'old',later:'old'}:p.after?{messages:[message('middle',3)],anchor:null,earlier:'middle',later:'middle'}:{messages:[message('earliest',1)],anchor:null,earlier:null,later:'earliest'})
  await mount(async()=>({...page(),messages:[{id:'new',kind:'text',role:'cc',text:'new',at:4,source:'wechat',truncated:false}]}),{conversationWindow:window})
  await act(async()=>{await view.seek('old')});await act(async()=>view.loadLater());await act(async()=>view.loadOlder())
  expect(window).toHaveBeenLastCalledWith({before:'old'});expect(view.canLoadOlder).toBe(false)
  expect(view.bubbles.map(b=>b.key)).toEqual(['earliest','old','middle','new'])
})
