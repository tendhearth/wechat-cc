// @vitest-environment happy-dom
import { act, createElement, Fragment, useSyncExternalStore } from 'react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { advance, cleanup, mount } from '../ui/native-motion.test-support'
import { notebookPen } from '../view/notebook'
import { NotebookCache } from './notebook'
import { withProviders } from './providers.test-support'

const fonts = vi.hoisted(() => ({
  loaded: new Set<string>(),
  listeners: new Set<() => void>(),
  files: new Map<string, string>(),
}))
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
  return {
    ...native,
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    TextInput: ({ testID, autoFocus, value }: { testID: string; autoFocus?: boolean; value: string }) =>
      createElement('textarea', { 'data-testid': testID, 'data-autofocus': !!autoFocus, value, readOnly: true }),
  }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }),
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-secure-store', () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only', getItemAsync: async () => null, deleteItemAsync: async () => {} }))

// Metro returns an asset ID. Give the native font boundary a file path in Node.
const require = createRequire(import.meta.url)
require.extensions['.ttf'] = (module, file) => { module.exports = file }

afterEach(async () => {
  await cleanup()
  fonts.loaded.clear()
  fonts.files.clear()
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
  expect(fallback.textContent).toBe(body)
  const style = JSON.parse(fallback.querySelector('span')!.getAttribute('data-style')!)
  expect(style).toMatchObject({ fontFamily: 'NotoSerifSC-Regular', transform: [{ skewX: '-9deg' }], color: '#24405f' })

  await act(() => {
    fonts.loaded.add('THPenKai-Regular')
    for (const listener of fonts.listeners) listener()
  })
  expect(page.byId(ccLine).textContent).toBe(body)
  expect(page.style(ccLine)).toMatchObject({ fontFamily: 'THPenKai-Regular', color: '#24405f' })
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
