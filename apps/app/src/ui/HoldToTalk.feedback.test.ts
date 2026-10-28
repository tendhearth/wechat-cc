// @vitest-environment happy-dom
import { act, createElement, useState, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECORD_MS } from '../view/hold-to-talk'
import { SendTalkButton, TalkStatus, useHoldToTalk } from './HoldToTalk'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const host = vi.hoisted(() => ({ props: new Map<string, any>(), permission: vi.fn(), start: vi.fn(), stop: vi.fn(), settings: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const { nativeBoundary } = await import('./native-motion.test-support')
  const View = ({ children, testID, accessibilityLabel, accessibilityState, ...props }: any) => {
    if (testID) host.props.set(testID, props)
    return createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-busy': accessibilityState?.busy }, children)
  }
  const Text = ({ children, testID, accessibilityLabel }: any) => createElement('span', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children)
  const Pressable = ({ children, onPress, testID, accessibilityLabel, disabled }: any) => createElement('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, disabled }, children)
  const Modal = ({ children, visible }: any) => visible ? createElement('section', { role: 'dialog' }, children) : null
  return { ...nativeBoundary(), View, Text, Pressable, Modal, ScrollView: View, ActivityIndicator: View, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default } }
})
vi.mock('expo-router', async () => (await import('./native-motion.test-support')).routerBoundary())
vi.mock('./talk-recorder', () => ({ TALK_MIME: 'audio/mp4', useTalkRecorder: () => ({ permission: host.permission, start: host.start, stop: host.stop }) }))
vi.mock('../push/native', () => ({ openSystemSettings: host.settings }))
// 语言走真 useLang:系统语言(设备边界)报中文。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-Hans-CN' }] }))
let root: Root
let container: HTMLDivElement
let onSend: ReturnType<typeof vi.fn<() => void>>, transcribe: ReturnType<typeof vi.fn<(x: { mime: string; audioBase64: string }) => Promise<string>>>
function Harness({ initial = '' }: { initial?: string }) {
  const [draft, setDraft] = useState(initial)
  const talk = useHoldToTalk({ transcribe, onText: setDraft, configured: true })
  return createElement('main', null,
    createElement('output', { 'data-testid': 'draft' }, draft),
    createElement(TalkStatus, { view: talk.view, elapsedMs: talk.elapsedMs, lang: 'zh-Hans', testID: 'talk' }),
    createElement(SendTalkButton, { ...talk, lang: 'zh-Hans', sendable: !!draft, talkable: true, sending: false, onTap: onSend, testID: 'send' }),
  )
}
async function mount(initial = '') { await act(async () => root.render(createElement(Harness, { initial }))) }
async function gesture(name: string, pageY = 100) { await act(async () => host.props.get('send')[name]?.({ nativeEvent: { pageY } })) }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); host.props.clear()
  host.permission.mockResolvedValue('granted'); host.start.mockResolvedValue(undefined)
  host.stop.mockResolvedValue({ audioBase64: 'voice', size: 10 }); host.settings.mockReset()
  onSend = vi.fn(); transcribe = vi.fn().mockResolvedValue('转写留在草稿')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); vi.useRealTimers(); vi.clearAllMocks(); container.remove() })

describe('quiet native voice feedback with real recording controller', () => {
  it('keeps the idle and send faces icon-only while retaining their accessible action names', async () => {
    await mount()
    expect(byId('send').getAttribute('aria-label')).toBe('按住说话')
    expect(byId('send').textContent).toBe('')
    await act(() => root.unmount()); root = createRoot(container)
    await mount('想说的话')
    expect(byId('send').getAttribute('aria-label')).toBe('发送')
    expect(byId('send').textContent).toBe('')
    await gesture('onResponderGrant'); await gesture('onResponderRelease')
    expect(onSend).toHaveBeenCalledOnce(); expect(host.start).not.toHaveBeenCalled()
  })
  it('shows just elapsed time during recording and keeps slide-to-cancel instructions accessible', async () => {
    await mount(); await gesture('onResponderGrant'); await advance(2250)
    expect(byId('talk-recording').textContent).toBe('0:02')
    expect(byId('talk-recording').getAttribute('aria-label')).toContain('上滑')
    expect(host.props.get('talk-recording').accessibilityLiveRegion).toBe('polite')
    await gesture('onResponderMove', 20); await gesture('onResponderRelease')
    expect(host.stop).toHaveBeenCalledWith(false); expect(transcribe).not.toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled()
  })
  it('never turns the original release after the time limit into send; transcription remains draft', async () => {
    await mount('已有字'); await gesture('onResponderGrant'); await advance(350 + MAX_RECORD_MS)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(byId('draft').textContent).toBe('转写留在草稿')
    await gesture('onResponderRelease')
    expect(onSend).not.toHaveBeenCalled(); expect(host.stop).toHaveBeenCalledOnce()
  })
  it('keeps permission recovery behind the compact problem entry', async () => {
    host.permission.mockResolvedValue('denied')
    await mount(); await gesture('onResponderGrant')
    expect(container.textContent).not.toContain('去设置')
    expect(byId('talk-note-micDenied')).not.toBeNull()
    await act(() => byId('talk-note-micDenied').click())
    await act(() => byId('talk-settings').click())
    expect(host.settings).toHaveBeenCalledOnce()
  })
})
