// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advance, background, cleanup, focus, host, mount, reduce, resetHost } from './native-motion.test-support'
vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-router', async () => (await import('./native-motion.test-support')).routerBoundary())
// 语言走真 useLang:系统语言(设备边界)报英文。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }))
const { CCFigure } = await import('./CCFigure')
afterEach(cleanup)
beforeEach(() => { resetHost(); vi.useFakeTimers() })
const node = (props: Record<string, unknown> = {}) => createElement(CCFigure, { size: 120, presence: 'here', ...props } as any)
const scale = (container: Element) => JSON.parse(container.firstElementChild!.getAttribute('data-style')!).transform.find((value: any) => value.scale !== undefined).scale

describe('CC native motion lifecycle', () => {
  it('stops at rest in the background and when the route blurs', async () => {
    const ui = await mount(node())
    await advance(2000); expect(scale(ui.container)).toBe(1.02)
    await background('background'); expect(scale(ui.container)).toBe(1)
    await advance(5000); expect(scale(ui.container)).toBe(1)
    await background('active'); await advance(2000); expect(scale(ui.container)).toBe(1.02)
    await focus(false); expect(scale(ui.container)).toBe(1)
    await advance(5000); expect(scale(ui.container)).toBe(1)
  })
  it('keeps Dark static and respects reduced motion', async () => {
    const ui = await mount(node({ presence: 'away' }))
    await advance(6000); expect(scale(ui.container)).toBe(1)
    await reduce(true); await ui.render(node({ presence: 'here' }))
    await advance(6000); expect(scale(ui.container)).toBe(1)
  })
})

const pose = (container: Element) => JSON.parse(container.firstElementChild!.getAttribute('data-style')!).transform
const value = (container: Element, key: string) => pose(container).find((entry: any) => entry[key] !== undefined)[key]

describe('CC event identities and connection evidence', () => {
  it('receives once per stable event, including an old ID seen again after a newer event', async () => {
    const ui = await mount(node())
    await ui.render(node({ behavior: 'receive', eventKey: 'chat-1' }))
    await advance(176); expect(value(ui.container, 'translateY')).toBe(1)
    await advance(264); expect(value(ui.container, 'translateY')).toBe(0)
    await ui.render(node({ behavior: 'receive', eventKey: 'chat-1' })); await advance(176)
    expect(value(ui.container, 'translateY')).toBe(0)
    await ui.render(node({ behavior: 'receive', eventKey: 'chat-2' })); await advance(176)
    expect(value(ui.container, 'translateY')).toBe(1)
    await ui.render(node({ behavior: 'receive', eventKey: 'chat-1' })); await advance(176)
    expect(value(ui.container, 'translateY')).toBe(0)
  })
  it('does not play historical keys that arrive while blurred or disabled, or replay an interrupted event', async () => {
    const ui = await mount(node())
    await focus(false); await ui.render(node({ behavior: 'done', eventKey: 'done-hidden' }))
    await focus(true); await advance(230); expect(value(ui.container, 'translateY')).toBe(0)
    await ui.render(node({ behavior: 'done', eventKey: 'done-live' })); await advance(230)
    expect(value(ui.container, 'translateY')).toBe(-2)
    await background('inactive'); expect(value(ui.container, 'translateY')).toBe(0)
    await background('active'); await advance(230); expect(value(ui.container, 'translateY')).toBe(0)
    await reduce(true); await ui.render(node({ behavior: 'done', eventKey: 'done-reduced' }))
    await reduce(false); await advance(230); expect(value(ui.container, 'translateY')).toBe(0)
  })
  it('waits once and remains still, with the original foot anchor at every size', async () => {
    const ui = await mount(node({ size: 80 }))
    await ui.render(node({ size: 80, behavior: 'wait', eventKey: 'approval-1' }))
    expect(value(ui.container, 'rotate')).toBe('-1.2deg')
    await advance(360); expect(value(ui.container, 'rotate')).toBe('0deg')
    await advance(8000); expect(scale(ui.container)).toBe(1)
    const style = JSON.parse(ui.container.firstElementChild!.getAttribute('data-style')!)
    expect(style.transformOrigin).toEqual([40, 73.4375, 0])
  })
  it('crossfades only a new real away→here transition; never on initial Light or page return', async () => {
    const ui = await mount(node({ presence: 'away' }))
    await ui.render(node({ presence: 'here' }))
    const light = () => JSON.parse(ui.container.querySelector('[data-testid="cc-lit"]')!.getAttribute('data-style')!).opacity
    expect(light()).toBe(0)
    await advance(720); expect(light()).toBe(1)
    await focus(false); await ui.render(node({ presence: 'away' })); await ui.render(node({ presence: 'here' }))
    await focus(true); expect(light()).toBe(1)
  })
  it('is conservative on a failed accessibility read and ignores a late read after a change event', async () => {
    host.read = () => Promise.reject(new Error('not supported'))
    const ui = await mount(node()); await advance(8000); expect(scale(ui.container)).toBe(1)
    await cleanup(); vi.useFakeTimers(); resetHost()
    let finish!: (value: boolean) => void
    host.read = () => new Promise(resolve => { finish = resolve })
    const pending = await mount(node()); await reduce(true)
    await import('react').then(async ({ act }) => { await act(() => finish(false)) })
    await advance(8000); expect(scale(pending.container)).toBe(1)
  })
})
