// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mount } from './native-motion.test-support'
vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('../i18n/useLang', () => ({ useLang: () => 'en' }))
afterEach(cleanup)

it('opens an accessible explanation without invoking recovery; recovery remains explicit and closing returns to the entry', async () => {
  const { StatusHint } = await import('./StatusHint')
  let recovered = 0
  const ui = await mount(createElement(StatusHint, { label: 'Delivery uncertain', description: 'The message may have arrived. Your draft is kept.', icon: 'help', testID: 'status' }, createElement('button', { onClick: () => { recovered++ }, 'data-testid': 'recover' }, 'Check status')))
  expect(ui.container.textContent).not.toContain('The message may have arrived')
  expect(ui.byId('status').getAttribute('aria-label')).toBe('Delivery uncertain')
  expect(ui.style('status').minWidth).toBeGreaterThanOrEqual(44)
  expect(ui.style('status').minHeight).toBeGreaterThanOrEqual(44)
  await act(() => ui.byId('status').click())
  expect(ui.container.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Delivery uncertain')
  expect(ui.container.textContent).toContain('The message may have arrived. Your draft is kept.')
  expect(recovered).toBe(0)
  await act(() => ui.byId('recover').click()); expect(recovered).toBe(1)
  await act(() => ui.byId('status-close').click())
  expect(ui.container.querySelector('[role="dialog"]')).toBeNull()
  expect(ui.byId('status').getAttribute('aria-expanded')).toBe('false')
})

it('supports a compact visible label and native back dismissal without performing any action', async () => {
  const { StatusHint } = await import('./StatusHint')
  const ui = await mount(createElement(StatusHint, { label: 'Connection details', description: 'Previously read data', shortLabel: 'Last read', testID: 'connection' }))
  expect(ui.byId('connection').textContent).toBe('Last read')
  await act(() => ui.byId('connection').click())
  await act(() => ui.container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(ui.container.querySelector('[role="dialog"]')).toBeNull()
})
