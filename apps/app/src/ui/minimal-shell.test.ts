// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, mount } from './native-motion.test-support'
import { withProviders } from '../state/providers.test-support'
import { makeDemoBackend } from '../backend/demo'
vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
const { IconButton } = await import('./IconButton')
const { TopBar } = await import('./TopBar')
afterEach(cleanup)

it('gives an icon action a complete label and a native touch target without rendering duplicate text', async () => {
  const pressed=vi.fn()
  const ui=await mount(createElement(IconButton,{ name:'plus',label:'New task',onPress:pressed,testID:'new' }))
  expect(ui.byId('new').getAttribute('aria-label')).toBe('New task')
  expect(ui.byId('new').textContent).toBe('')
  expect(ui.style('new').minWidth).toBeGreaterThanOrEqual(44)
  expect(ui.style('new').minHeight).toBeGreaterThanOrEqual(44)
  ui.byId('new').click();expect(pressed).toHaveBeenCalledOnce()
})

it('does not show a nonfunctional settings control on detail pages and keeps supplied actions reachable', async () => {
  const action=createElement('button',{'data-testid':'detail-action'},'Action')
  const ui=await mount(withProviders(createElement(TopBar,{title:'Details',actions:action}),{backend:makeDemoBackend({lang:'en'}),lang:'en'}))
  expect(ui.byId('topbar-settings')).toBeNull()
  expect(ui.byId('detail-action')).not.toBeNull()
})

it('keeps the compact connection entry at least 44pt without relying on hit slop', async () => {
  const ui=await mount(withProviders(createElement(TopBar,{title:'CC',showStatus:true,onConnection:()=>{},connectionTestID:'connect'}),{backend:makeDemoBackend({lang:'en'}),lang:'en'}))
  expect(ui.style('connect').minWidth).toBeGreaterThanOrEqual(44)
  expect(ui.style('connect').minHeight).toBeGreaterThanOrEqual(44)
  expect(ui.style('connect').flexShrink).toBe(0)
})
