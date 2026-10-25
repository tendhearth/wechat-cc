// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type ChatPageT } from '../backend/types'
import { clearDrafts, getDraft, putReceipt, setDraft } from './drafts'
import { makeStore, type Store } from './store'
import Chat from '../app/chat'
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store } }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('./BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('expo-router', async () => ({ ...await (await import('../ui/native-motion.test-support')).routerBoundary(), useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }) }))
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  const { nativeBoundary } = await import('../ui/native-motion.test-support')
  const View = ({ children, testID, accessibilityLabel, accessibilityRole }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, role: accessibilityRole }, children)
  const Text = ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children)
  const Pressable = ({ children, testID, accessibilityLabel, disabled, onPress }: any) => createElement('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children)
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('textarea', { ref, value, 'data-testid': testID, onInput: (e: any) => onChangeText(e.currentTarget.value) }))
  const FlatList = ({ data, renderItem, ListEmptyComponent, ListFooterComponent }: any) => createElement('article', null, data.length ? data.map((item: any) => createElement('section', { key: item.key }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent)
  const Modal = ({ children, visible }: any) => visible ? createElement('section', { role: 'dialog' }, children) : null
  return { ...nativeBoundary(), View, Text, Pressable, TextInput, FlatList, Modal, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View }

})
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))
vi.mock('../ui/ConnectionNotice', () => ({ ConnectionNotice: () => null }))
vi.mock('../ui/ReplyExtras', () => ({ ReplyAttachments: () => null, ReplyProcess: () => null }))
vi.mock('../ui/Markdown', async () => { const { createElement } = await import('react'); return { MessageText: ({ text }: any) => createElement('p', null, text) } })
vi.mock('../ui/HoldToTalk', async () => {
  const { createElement } = await import('react')
  return { useHoldToTalk: () => ({ view: {}, ctl: { clearNote() {} }, elapsedMs: 0 }), TalkStatus: () => null,
    SendTalkButton: ({ onTap, testID, sendable }: any) => createElement('button', { 'data-testid': testID, onClick: onTap, disabled: !sendable }) }
})
let root: { render(node: ReactNode): void; unmount(): void }, container: HTMLDivElement
const empty = (): ChatPageT => ({ matterId: 'owner', title: 'CC', messages: [], pending: null, failed: null, hasMore: false, nextBefore: null })
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function click(id: string) { await act(() => byId(id).click()); await flush() }
async function mount(page: ChatPageT, say: Backend['chatSay'] = vi.fn(), fail = false) {
  const read = vi.fn(async () => { if (fail) throw new BackendError('offline'); return page })
  const backend = { ...makeDemoBackend({ lang: 'zh-Hans' }), chat: read, chatSay: say }
  host.ctx = { backend, store: makeStore(backend, { lang: 'zh-Hans' }) }
  await act(() => root.render(createElement(Chat))); await flush()
  return { read, say }
}
beforeEach(() => { clearDrafts(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(async () => { await act(() => root.unmount()); container.remove() })

describe('native chat feedback', () => {
  it('keeps uncertain explanation behind the affected message and checks only by reading', async () => {
    setDraft('chat', '新的草稿')
    const at = Date.now(); putReceipt({ requestId: 'uncertain', text: '原文', at, localAt: at })
    const h = await mount(empty())
    expect(container.textContent).not.toContain('可能没送到')
    expect(byId('chat-failed-maybeLost')).not.toBeNull()
    await click('chat-failed-maybeLost')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('可能没送到')
    await click('chat-check')
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.say).not.toHaveBeenCalled()
    expect(getDraft('chat')).toBe('新的草稿')
    expect(byId('chat-failed-maybeLost')).not.toBeNull()
  })
  it('keeps pending reply as an accessible loader without the old thinking sentence', async () => {
    const page = { ...empty(), pending: { requestId: 'pending', text: '问题', since: Date.now() } } as ChatPageT
    await mount(page)
    expect(byId('chat-thinking')).not.toBeNull()
    expect(container.textContent).not.toContain('在想')
    expect(byId('chat-thinking').getAttribute('aria-label')).toBeTruthy()
  })
  it('exposes an uncertain send result beside the retained draft without fabricating a received message', async () => {
    setDraft('chat', '还没确认的一句')
    const say = vi.fn(async () => { throw new BackendError('timeout') })
    const h = await mount(empty(), say)
    await click('chat-send')
    expect(h.say).toHaveBeenCalledOnce()
    expect(byId('chat-outcome-uncertain')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-bubble-me"]')).toBeNull()
    expect(getDraft('chat')).toBe('还没确认的一句')
    await click('chat-outcome-uncertain'); await click('chat-check')
    expect(h.say).toHaveBeenCalledOnce(); expect(h.read).toHaveBeenCalledTimes(2)
  })
  it('says so when a successful check still has not seen the message, and not when the read failed', async () => {
    const at = Date.now(); putReceipt({ requestId: 'uncertain', text: '原文', at, localAt: at })
    await mount(empty())
    await click('chat-failed-maybeLost')
    expect(container.querySelector('[data-testid="chat-check-none"]')).toBeNull()
    await click('chat-check')
    expect(byId('chat-check-none')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-check-failed"]')).toBeNull()
  })
  it('shows a failed check as not refreshed, never as checked', async () => {
    const at = Date.now(); putReceipt({ requestId: 'uncertain', text: '原文', at, localAt: at })
    await mount(empty(), vi.fn(), true)
    await click('chat-failed-maybeLost'); await click('chat-check')
    expect(container.querySelector('[data-testid="chat-check-none"]')).toBeNull()
  })
  it('closes the explanation when retrying so the new result is not hidden behind it', async () => {
    const at = Date.now(); putReceipt({ requestId: 'uncertain', text: '原文', at, localAt: at })
    const say = vi.fn(async () => { throw new BackendError('timeout') })
    await mount(empty(), say)
    await click('chat-failed-maybeLost')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await click('chat-retry')
    expect(say).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
