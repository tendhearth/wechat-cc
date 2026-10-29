// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type ChatPageT } from '../backend/types'
import { clearDrafts, getDraft, putReceipt, setDraft } from './drafts'
import { withProviders } from './providers.test-support'
import Chat from '../app/chat'
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('expo-router', async () => ({ ...await (await import('../ui/native-motion.test-support')).routerBoundary(), useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }) }))
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  const { nativeBoundary } = await import('../ui/native-motion.test-support')
  // 无障碍「激活」= 点一下(发送键是 View + onAccessibilityAction,没有 onPress)
  const View = ({ children, testID, accessibilityLabel, accessibilityRole, onAccessibilityAction }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, role: accessibilityRole,
    onClick: onAccessibilityAction ? () => onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }) : undefined }, children)
  const Text = ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children)
  const Pressable = ({ children, testID, accessibilityLabel, disabled, onPress }: any) => createElement('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children)
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('textarea', { ref, value, 'data-testid': testID, onInput: (e: any) => onChangeText(e.currentTarget.value) }))
  const FlatList = ({ data, renderItem, ListEmptyComponent, ListFooterComponent }: any) => createElement('article', null, data.length ? data.map((item: any) => createElement('section', { key: item.key }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent)
  const Modal = ({ children, visible }: any) => visible ? createElement('section', { role: 'dialog' }, children) : null
  return { ...nativeBoundary(), View, Text, Pressable, TextInput, FlatList, Modal, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View }

})
// 设备边界:系统语言、录音 / 播放、文件系统(真页面、真 Provider、真 TopBar / Markdown / ReplyExtras 都照常渲染)。
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-audio', () => ({ createAudioPlayer: () => ({}), setAudioModeAsync: async () => {} }))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaProvider: ({ children }: any) => children, SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
// 真的 HoldToTalk / SendTalkButton;录音器、系统设置是设备边界(守卫的 BOUNDARY_FILES 里登记过)。
vi.mock('../ui/talk-recorder', () => ({ TALK_MIME: 'audio/mp4', useTalkRecorder: () => ({ permission: async () => 'granted', start: async () => {}, stop: async () => null }) }))
vi.mock('../push/native', () => ({ openSystemSettings() {} }))
let root: { render(node: ReactNode): void; unmount(): void }, container: HTMLDivElement
const empty = (): ChatPageT => ({ matterId: 'owner', title: 'CC', messages: [], pending: null, failed: null, hasMore: false, nextBefore: null })
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function click(id: string) { await act(() => byId(id).click()); await flush() }
async function mount(page: ChatPageT, say: Backend['chatSay'] = vi.fn(), fail = false, lang: 'en' | 'zh-Hans' = 'zh-Hans') {
  const read = vi.fn(async () => { if (fail) throw new BackendError('offline'); return page })
  const backend = { ...makeDemoBackend({ lang }), chat: read, chatSay: say }
  await act(() => root.render(withProviders(createElement(Chat), { backend, lang }))); await flush()
  return { read, say, backend }
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


it('keeps validated inbound file metadata discoverable with the original message/index and truthful failed-open feedback', async () => {
  const page = empty()
  const text = '原始输入 [文件×1]'
  page.messages = [{ id: 'incoming-1', role: 'me', kind: 'text', text, at: 1, source: 'phone', truncated: false, attachments: [{ kind: 'file', name: 'source.txt' }] }]
  const h = await mount(page)
  expect(byId('chat-att-file')?.textContent).toContain('source.txt')
  expect(byId('chat-bubble-me')?.textContent).toContain(text)
  const load = vi.fn(async () => { throw new BackendError('not_found') }); h.backend.chatFileChunk = load
  await click('chat-att-file')
  expect(load).toHaveBeenCalledWith({ messageId: 'incoming-1', index: 0, offset: 0 })
  expect(byId('chat-att-file-note')?.textContent).toContain('没打开，稍后再试。')
  expect(byId('chat-bubble-me')?.textContent).toContain(text)
})

it('never fabricates an attachment for legacy inbound text whose original metadata is absent', async () => {
  const page = empty()
  page.messages = [{ id: 'legacy', role: 'me', kind: 'text', text: '以前的图片 [图片×2]', at: 1, source: 'wechat', truncated: false }]
  await mount(page)
  expect(byId('chat-bubble-me')?.textContent).toContain('以前的图片 [图片×2]')
  expect(byId('chat-att-file')).toBeNull()
  expect(byId('chat-att-image')).toBeNull()
})

for (const lang of ['en', 'zh-Hans'] as const) it(`explains unavailable originals on persisted count-only input without changing its text (${lang})`, async () => {
  const page = empty(), text = '以前的图片\n[图片 ×2]'
  page.messages = [{ id: 'legacy-note', role: 'me', kind: 'text', text, at: 1, source: 'phone', truncated: false }]
  await mount(page, vi.fn(), false, lang)
  expect(byId('chat-bubble-me')?.textContent).toContain(text)
  expect(byId('chat-original-unavailable')?.textContent).toBe(lang === 'en' ? 'This record kept only text. The original attachment is not available to open.' : '这条记录只保留了文字，无法打开原附件。')
  expect(byId('chat-att-file')).toBeNull()
  expect(byId('chat-att-image')).toBeNull()
})
