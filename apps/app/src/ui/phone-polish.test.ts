// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { withProviders } from '../state/providers.test-support'
import type { HomeRow } from '../view/home'
import { ButlerStatus } from './ButlerStatus'
import { DelegationMessage } from './DelegationMessage'
import { DemoBanner } from './DemoBanner'
import { cleanup, mount } from './native-motion.test-support'
import { palette, space } from './tokens'

vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-router', async () => ({
  ...(await (await import('./native-motion.test-support')).routerBoundary()),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

it.each([
  ['zh-Hans', '以前交办的事 · 昨天 19:30'],
  ['en', 'Previously delegated · Yesterday 7:30 PM'],
] as const)('renders the delegated work timestamp in %s and spaces the demo notice', async (lang, expected) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 22, 8))
  const row: HomeRow = {
    id: 'sample', source: 'terminal', href: '/terminal/sample', title: 'Sample',
    status: 'done', updatedAt: new Date(2026, 10, 21, 19, 30, 1).getTime(),
    caption: null, detail: null, note: null, pendingRequestId: null, agents: [], origin: null,
  }
  const ui = await mount(withProviders(createElement(Fragment, null,
    createElement(DemoBanner), createElement(DelegationMessage, { row, historical: true, synced: true }),
  ), { backend: makeDemoBackend(), lang }))
  expect(ui.byId('delegation-terminal-sample').firstElementChild?.textContent).toBe(expected)
  expect(ui.style('demo-banner').marginVertical).toBe(space.s)
})

it('shows checkup grades in one right column and reads each item as label, grade, detail', async () => {
  const ui = await mount(withProviders(createElement(ButlerStatus), { backend: makeDemoBackend() }))
  await act(async () => {})
  const memory = ui.byId('checkup-memory')
  const grade = memory.firstElementChild!.lastElementChild!
  const detail = memory.lastElementChild!
  const styleOf = (element: Element) => JSON.parse(element.getAttribute('data-style')!)
  expect(memory.getAttribute('aria-label')).toBe('记性，弱，早先交代的事容易忘')
  expect(styleOf(memory.firstElementChild!)).toMatchObject({ flexDirection: 'row' })
  expect(grade.textContent).toBe('弱')
  expect(styleOf(grade)).toMatchObject({ textAlign: 'right', color: palette.ink })
  expect(detail.textContent).toBe('早先交代的事容易忘')
  expect(styleOf(detail).fontSize).toBeLessThan(styleOf(memory.querySelector('span')!).fontSize)
  expect(styleOf(detail).color).toBe(palette.inkSoft)
  for (const key of ['tracking', 'discretion']) {
    expect(styleOf(ui.byId(`checkup-${key}`).firstElementChild!.lastElementChild!).color).toBe(palette.inkSoft)
  }
  expect(styleOf(ui.byId('checkup-persona').firstElementChild!.lastElementChild!).color).toBe(palette.ink)
  expect(ui.byId('checkup-speed').firstElementChild!.children).toHaveLength(1)
  expect(ui.byId('checkup-speed').getAttribute('aria-label')).toBe('快慢，首字约 250 毫秒，完成约 1000 毫秒')
  expect(styleOf(memory.parentElement!).gap).toBe(space.m)
})
