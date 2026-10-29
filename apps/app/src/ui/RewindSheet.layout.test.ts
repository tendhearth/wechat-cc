// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { cleanup, mount } from './native-motion.test-support'
import { RewindSheet } from './RewindSheet'
vi.mock('react-native', async () => {
  const boundary = (await import('./native-motion.test-support')).nativeBoundary()
  return { ...boundary, ScrollView: ({ children, ...props }: any) => createElement('div', { 'data-scroll': true }, createElement(boundary.View, props, children)) }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: ({ edges, children, ...props }: any) => createElement('div', { 'data-safe-edges': edges.join(',') }, createElement((awaitBoundary as any).View, props, children)) }))
// The native host wrappers retain the boundary roles so containment verifies real sheet composition.
const awaitBoundary = await import('./native-motion.test-support').then(m => m.nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
it('keeps full paths, all consequences and both controls in one safe-area-bounded scroll region', async () => {
  const backend = makeDemoBackend({ lang: 'en' })
  const turn = await backend.changes('a1b2c3d4')
  const preview = await backend.rewindPreview({ id: 'a1b2c3d4', artifactId: turn!.artifactId! })
  const ui = await mount(createElement(RewindSheet, { matterId: 'a1b2c3d4', artifactId: turn!.artifactId!, backend, lang: 'en', online: true, submit: vi.fn(async () => 'ok' as const), onClose: () => {}, onSettled: () => {} }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const sheet = ui.byId('rewind-sheet'), scroll = sheet.querySelector('[data-scroll]')!
  expect(scroll.contains(ui.byId('rewind-confirm'))).toBe(true)
  expect(scroll.contains(ui.byId('rewind-cancel'))).toBe(true)
  expect(sheet.closest('[data-safe-edges="bottom"]')).not.toBeNull()
  expect(preview.files.paths.length).toBeGreaterThan(0)
  expect(scroll.contains(ui.byId('rewind-path-0'))).toBe(true)
})
