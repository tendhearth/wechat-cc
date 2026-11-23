// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationSearch } from '../app/chat-search'
import { makeDemoBackend } from '../backend/demo'
import { withProviders } from '../state/providers.test-support'
import { cleanup, mount } from './native-motion.test-support'
import { palette } from './tokens'

const { push, dismiss } = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn() }))
vi.mock('react-native', async () => {
  const { nativeBoundary } = await import('./native-motion.test-support')
  const native = nativeBoundary()
  return {
    ...native,
    Pressable: ({ accessibilityRole, ...props }: any) =>
      createElement('div', { role: accessibilityRole }, createElement(native.Pressable, props)),
    TextInput: ({ testID, placeholder, accessibilityLabel }: any) =>
      createElement('input', { 'data-testid': testID, placeholder, 'aria-label': accessibilityLabel }),
    Keyboard: { dismiss },
    FlatList: () => null,
    ActivityIndicator: () => null,
  }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('./native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('./native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push }),
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

it('switches the selected search tab and keeps Topics as a separate link', async () => {
  const ui = await mount(withProviders(createElement(ConversationSearch), { backend: makeDemoBackend(), lang: 'zh-Hans' }))
  const messages = ui.byId('search-messages')
  const work = ui.byId('search-work')
  const topics = ui.byId('search-topics')
  const input = ui.byId('chat-search-input')
  const tabList = ui.container.querySelector('[role="tablist"]')
  expect(tabList?.contains(messages)).toBe(true)
  expect(tabList?.contains(work)).toBe(true)
  expect(tabList?.contains(topics)).toBe(false)
  for (const [target, role] of [[messages, 'tab'], [work, 'tab'], [topics, 'link']] as const) {
    expect(target.parentElement?.getAttribute('role')).toBe(role)
    expect(ui.style(target.dataset.testid!).minHeight).toBeGreaterThanOrEqual(44)
  }
  expect(messages.getAttribute('aria-selected')).toBe('true')
  expect(ui.style('search-messages').backgroundColor).toBe(palette.rail)
  expect(input.getAttribute('placeholder')).toBe('搜和 CC 说过的话')
  await act(() => work.click())
  expect(messages.getAttribute('aria-selected')).toBe('false')
  expect(work.getAttribute('aria-selected')).toBe('true')
  expect(ui.style('search-messages').backgroundColor).toBeUndefined()
  expect(ui.style('search-work').backgroundColor).toBe(palette.rail)
  expect(input.getAttribute('placeholder')).toBe('搜交办过的事')
  expect(input.getAttribute('aria-label')).toBe('搜交办过的事')
  expect(ui.container.textContent).toContain('搜事项')
  expect(dismiss).toHaveBeenCalledOnce()
  await act(() => topics.click())
  expect(push).toHaveBeenCalledWith('/topics')
  expect(work.getAttribute('aria-selected')).toBe('true')
})
