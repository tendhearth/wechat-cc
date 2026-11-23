// @vitest-environment happy-dom
import { act, createElement, Fragment, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { advance, background, cleanup, focus, mount, resetHost } from '../ui/native-motion.test-support'
import { notebookPen } from '../view/notebook'
import { beginMatterInput, matterInputState } from './matter-inputs'
import { NotebookCache } from './notebook'
import { withProviders } from './providers.test-support'
import { useNotebookMailDay } from './useNotebookMail'

const fonts = vi.hoisted(() => ({
  loaded: new Set<string>(),
  listeners: new Set<() => void>(),
  files: new Map<string, string>(),
}))
const route = vi.hoisted(() => ({ day: undefined as string | undefined, push: vi.fn() }))
type Geometry = {
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void
  onScroll?: (event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => void
}
const geometry = new WeakMap<Element, Geometry>()
vi.mock('expo-font', () => ({
  useFonts(files: Record<string, string>) {
    for (const [family, file] of Object.entries(files)) fonts.files.set(family, file)
    const loaded = useSyncExternalStore(listener => {
      fonts.listeners.add(listener)
      return () => fonts.listeners.delete(listener)
    }, () => Object.keys(files).every(family => fonts.loaded.has(family)))
    return [loaded, null]
  },
}))
vi.mock('react-native', async () => {
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const LayoutView = ({ onLayout, onScroll, ...props }: Geometry & Record<string, unknown>) => {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => { if (ref.current) geometry.set(ref.current, { onLayout, onScroll }) })
    const view = createElement(native.View, props)
    return onLayout || onScroll ? createElement('div', { ref }, view) : view
  }
  return {
    ...native,
    View: LayoutView,
    ScrollView: LayoutView,
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    TextInput: ({ testID, autoFocus, value }: { testID: string; autoFocus?: boolean; value: string }) =>
      createElement('textarea', { 'data-testid': testID, 'data-autofocus': !!autoFocus, value, readOnly: true }),
  }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({ day: route.day }),
  useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn(), push: route.push }),
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-secure-store', () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only', getItemAsync: async () => null, deleteItemAsync: async () => {} }))

// Metro returns an asset ID. Give the native font boundary a file path in Node.
const require = createRequire(import.meta.url)
require.extensions['.ttf'] = (module, file) => { module.exports = file }

afterEach(async () => {
  await cleanup()
  await matterInputState.clear()
  fonts.loaded.clear()
  fonts.files.clear()
  route.day = undefined
  route.push.mockClear()
  resetHost()
  vi.unstubAllGlobals()
})

const body = '你上回说想在河边坐一会儿。我也记得。'
const ccLine = 'notebook-cc-line'

it('shows the demo CC message in slanted Song after 1.5s, then swaps to Kai when it loads', async () => {
  vi.useFakeTimers()
  const { default: Notebook } = await import('../app/notebook')
  const page = await mount(withProviders(createElement(Fragment, null,
    createElement(NotebookCache), createElement(Notebook)), { backend: makeDemoBackend({ lang: 'zh-Hans' }) }))
  expect(page.byId('notebook-owner-line')).toBeTruthy()
  expect(page.byId('notebook-input').dataset.autofocus).toBe('false')
  await advance(1499)
  expect(page.byId(ccLine)).toBeNull()
  await advance(1)
  const fallback = page.byId(ccLine)
  expect(fallback.textContent === body).toBe(true)
  const style = JSON.parse(fallback.querySelector('span')!.getAttribute('data-style')!)
  expect(style).toMatchObject({ fontFamily: 'NotoSerifSC-Regular', transform: [{ skewX: '-9deg' }], color: '#24405f' })

  await act(() => {
    fonts.loaded.add('THPenKai-Regular')
    for (const listener of fonts.listeners) listener()
  })
  expect(page.byId(ccLine).textContent === body).toBe(true)
  expect(page.style(ccLine)).toMatchObject({ fontFamily: 'THPenKai-Regular', color: '#24405f' })
})

it('opens the requested day, and sends only a drawn reply at least halfway onscreen while focused and foregrounded', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 1))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const today = '2026-11-22', day = '2026-11-21'
  route.day = day
  const demo = makeDemoBackend({ now: () => Date.parse(today), lang: 'en' })
  const example = (await demo.notebookPage({})).entries.find(entry => entry.author === 'cc')!
  const reply = { ...example, id: 'reply', day }
  const starter = { ...reply, id: 'starter', refId: null }
  const read = vi.fn(async () => ({ today, day, days: [day, today], entries: [reply, starter],
    paper: 'ruled' as const, pen: { font: 'kai' as const, ink: 'blueBlack' as const, reason: '' }, penPending: false }))
  const seen = vi.fn(async () => {})
  const unseen = vi.fn(async () => undefined)
  const backend = { ...demo, notebookPage: read, notebookSeen: seen, notebookUnseen: unseen }
  const { default: Notebook } = await import('../app/notebook')
  const ui = await mount(withProviders(createElement(Fragment, null, createElement(NotebookCache), createElement(Notebook)), { backend, lang: 'en' }))
  const paper = () => ui.byId('notebook-paper').parentElement!
  const layout = (element: Element, y: number, height: number) => geometry.get(element)!.onLayout!({ nativeEvent: { layout: { y, height } } })
  const scroll = (y: number) => geometry.get(paper())!.onScroll!({ nativeEvent: { contentOffset: { y }, contentSize: { height: 300 }, layoutMeasurement: { height: 100 } } })
  expect(read.mock.calls).toEqual([[{ day, fonts: 'kai,hand,fangsong,songItalic' }]])
  expect(ui.byId('notebook-today')).toBeTruthy()
  layout(paper(), 0, 100)
  await advance(2)
  expect(ui.byId(ccLine)).toBeNull()
  expect(seen).not.toHaveBeenCalled()

  await act(() => {
    fonts.loaded.add('THPenKai-Regular')
    for (const listener of fonts.listeners) listener()
  })
  const [line, standalone] = ui.container.querySelectorAll(`[data-testid="${ccLine}"]`)
  expect(standalone).toBeTruthy()
  const bodyFrame = line!.parentElement!.parentElement!
  const rowFrame = bodyFrame.parentElement!.parentElement!
  layout(rowFrame, 81, 90)
  layout(bodyFrame, 0, 40)
  await advance(2)
  expect(seen).not.toHaveBeenCalled()

  await background('background')
  scroll(1)
  await advance(2)
  expect(seen).not.toHaveBeenCalled()
  await focus(false)
  await background('active')
  await advance(2)
  expect(seen).not.toHaveBeenCalled()
  await focus(true)
  await advance(2)
  expect(seen).toHaveBeenCalledExactlyOnceWith(['reply'])
  expect(unseen).toHaveBeenCalledTimes(1)
})

it('refreshes Home on focus, foreground and the 60-second tick, and binds the reply to all three indicators', async () => {
  vi.useFakeTimers()
  const { ConversationMore } = await import('../ui/ConversationMore')
  const { ConversationPresence } = await import('../ui/ConversationPresence')
  const day = '2026-11-21'
  let replyDay: string | undefined = day
  const notebookUnseen = vi.fn(async () => replyDay)
  const backend = { ...makeDemoBackend(), notebookUnseen }
  function Home() {
    const notebookReplyDay = useNotebookMailDay()
    return createElement(Fragment, null,
      createElement(ConversationPresence, { notebookReply: !!notebookReplyDay }),
      createElement(ConversationMore, { notebookReplyDay }))
  }
  const ui = await mount(withProviders(createElement(Home), { backend }))
  const label = (id: string) => ui.byId(id).getAttribute('aria-label')
  const press = async (id: string) => { await act(() => ui.byId(id).click()) }
  const dot = 'home-notebook-reply-dot', envelope = 'home-notebook-envelope', row = 'conversation-notebook'
  const more = 'home-more'
  expect(notebookUnseen).toHaveBeenCalledTimes(1)
  expect(label(more)).toBe('更多，本子上有 CC 的回信')
  expect(JSON.parse(ui.byId(dot).firstElementChild!.getAttribute('data-style')!)).toMatchObject({ width: 6, height: 6 })
  expect(ui.style(envelope)).toMatchObject({ width: 13, height: 13 })
  expect(ui.byId(envelope).getAttribute('aria-hidden')).toBe('true')
  expect(label('now-cc')).toBe('跟 CC 说')
  await press(more)
  expect(ui.byId(row).textContent).toBe('本子有回信')
  expect(label(row)).toBe('本子，有回信')
  await press(row)
  expect(route.push).toHaveBeenLastCalledWith({ pathname: '/notebook', params: { day } })
  await act(() => { beginMatterInput('task', 'draft', undefined, () => 'saved-1') })
  expect(ui.byId(more).textContent).toBe('1')
  expect(ui.byId(dot)).toBeNull()
  expect(label(more)).toBe('更多，本子上有 CC 的回信')
  await act(async () => { await matterInputState.clear() })

  await advance(59_999)
  expect(notebookUnseen).toHaveBeenCalledTimes(1)
  await advance(1)
  expect(notebookUnseen).toHaveBeenCalledTimes(2)
  await background('background')
  await advance(90_000)
  expect(notebookUnseen).toHaveBeenCalledTimes(2)
  await background('active')
  expect(notebookUnseen).toHaveBeenCalledTimes(3)
  await advance(30_000)
  expect(notebookUnseen).toHaveBeenCalledTimes(3)
  await focus(false)
  await background('background')
  await background('active')
  await advance(60_000)
  expect(notebookUnseen).toHaveBeenCalledTimes(3)
  replyDay = undefined
  await focus(true)
  expect(notebookUnseen).toHaveBeenCalledTimes(4)
  expect(label(more)).toBe('更多')
  expect(ui.byId(dot)).toBeNull()
  expect(ui.byId(envelope)).toBeNull()
  await press(more)
  expect(ui.byId(row).textContent).toBe('本子')
  expect(label(row)).toBe('本子')
  await press(row)
  expect(route.push).toHaveBeenLastCalledWith('/notebook')
})

it('registers each pen with useFonts and in the native bundle under its PostScript name', async () => {
  const { default: Notebook } = await import('../app/notebook')
  await mount(withProviders(createElement(Notebook), { backend: makeDemoBackend({ lang: 'zh-Hans' }) }))

  const app = JSON.parse(readFileSync(join(__dirname, '../../app.json'), 'utf8'))
  const [, config] = app.expo.plugins.find((entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-font')
  const families = (['kai', 'hand', 'fangsong'] as const).map(font => notebookPen({ font, ink: 'blueBlack', reason: '' }).family!)
  expect([...fonts.files.keys()].sort()).toEqual(families.sort())
  expect(config.fonts.toSorted()).toEqual(families.map(family => `./assets/fonts/${family}.ttf`).sort())
  for (const family of families) {
    const bytes = readFileSync(fonts.files.get(family)!)
    // OpenType name table, Windows Unicode records, name ID 6 (PostScript name).
    let name = 0
    for (let i = 0; i < bytes.readUInt16BE(4); i++) {
      const record = 12 + i * 16
      if (bytes.toString('ascii', record, record + 4) === 'name') name = bytes.readUInt32BE(record + 8)
    }
    expect(name).toBeGreaterThan(0)
    const strings = name + bytes.readUInt16BE(name + 4)
    const postScriptNames = new Set<string>()
    for (let i = 0; i < bytes.readUInt16BE(name + 2); i++) {
      const record = name + 6 + i * 12
      if (bytes.readUInt16BE(record) !== 3 || bytes.readUInt16BE(record + 6) !== 6) continue
      const start = strings + bytes.readUInt16BE(record + 10)
      const length = bytes.readUInt16BE(record + 8)
      postScriptNames.add(Buffer.from(bytes.subarray(start, start + length)).swap16().toString('utf16le'))
    }
    expect([...postScriptNames]).toEqual([family])
  }
})
