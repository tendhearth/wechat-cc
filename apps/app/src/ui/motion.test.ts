// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advance, background, cleanup, focus, host, mount, reduce, resetHost } from './native-motion.test-support'
vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-router', async () => (await import('./native-motion.test-support')).routerBoundary())
vi.mock('../i18n/useLang', () => ({ useLang: () => 'en' }))
afterEach(cleanup)
beforeEach(() => { resetHost(); vi.useFakeTimers() })

describe('native motion primitives', () => {
  it('enters only a fresh explicit event and exposes the full child at rest after background/blur', async () => {
    const { MotionView } = await import('./motion')
    const node = (key?: string) => createElement(MotionView, { eventKey: key, testID: 'event', children: 'body' })
    const ui = await mount(node()); expect(ui.style('event').opacity).toBe(1)
    await ui.render(node('message-1')); expect(ui.style('event').opacity).toBe(0)
    await advance(180); expect(ui.style('event').opacity).toBe(1)
    await ui.render(node('message-1')); expect(ui.style('event').opacity).toBe(1)
    await ui.render(node('message-2')); expect(ui.style('event').opacity).toBe(0)
    await background('background'); expect(ui.style('event').opacity).toBe(1)
    await background('active'); expect(ui.style('event').opacity).toBe(1)
    await focus(false); await ui.render(node('message-hidden')); await focus(true)
    expect(ui.style('event').opacity).toBe(1)
    await ui.render(node('message-1')); expect(ui.style('event').opacity).toBe(1)
  })
  it('does not replay an initial key when the accessibility read becomes available', async () => {
    const { MotionView } = await import('./motion')
    let finish!: (on: boolean) => void; host.read = () => new Promise(resolve => { finish = resolve })
    const ui = await mount(createElement(MotionView, { eventKey: 'history', testID: 'event', children: 'history' }))
    const { act } = await import('react'); await act(() => finish(false))
    expect(ui.style('event').opacity).toBe(1)
  })
  it('keeps a named busy status accessible when static and stops its rotation immediately', async () => {
    const { BusyIndicator } = await import('./motion')
    const ui = await mount(createElement(BusyIndicator, { label: 'CC is replying', testID: 'busy' }))
    expect(ui.byId('busy').getAttribute('aria-label')).toBe('CC is replying')
    expect(ui.byId('busy').getAttribute('role')).toBe('progressbar')
    expect(ui.byId('busy').getAttribute('aria-busy')).toBe('true')
    await advance(1000); expect(ui.style('busy-motion').transform[0].rotate).toBe('360deg')
    await reduce(true); expect(ui.style('busy-motion').transform[0].rotate).toBe('0deg')
    await advance(8000); expect(ui.style('busy-motion').transform[0].rotate).toBe('0deg')
    expect(ui.byId('busy').getAttribute('aria-label')).toBe('CC is replying')
  })
})

it('consumes a pending event before rearming after a frozen route resumes in one render', async () => {
  const { MotionView } = await import('./motion'), { act } = await import('react')
  const ui = await mount(createElement(MotionView, { testID: 'event', children: 'body' }))
  // Native screens can freeze rendering while unfocused; React sees the queued cleanup and return together.
  await act(() => {
    for (const entry of host.focusEntries) { entry.cleanup?.(); entry.cleanup = entry.run() }
    ui.root.render(createElement(MotionView, { eventKey: 'arrived-while-frozen', testID: 'event', children: 'body' }))
  })
  expect(ui.style('event').opacity).toBe(1)
})
