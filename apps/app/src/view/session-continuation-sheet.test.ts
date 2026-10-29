// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { SessionContinueT } from '../backend/types'
import SessionReader from '../app/sessions/[key]'
import { withProviders } from '../state/providers.test-support'
import { continueSheetLines } from './continue'
import { cleanup, mount } from '../ui/native-motion.test-support'

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
vi.mock('react-native', async () => {
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const ScrollView = ({ children, testID, style }: any) => createElement('div', { 'data-testid': testID, 'data-native-scroll': true, 'data-style': JSON.stringify(style ?? {}) }, children)
  return { ...native, ScrollView, ActivityIndicator: () => null, Linking: { openURL: vi.fn() } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({ key: 'demo-claude-2' }),
  useRouter: () => ({ ...route, canGoBack: () => true }),
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(async () => { await cleanup(); vi.clearAllMocks() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

describe.each(['en', 'zh-Hans'] as const)('session continuation with long confirmation content (%s)', lang => {
  const project = `/Users/owner/Documents/${'long folder name with spaces/'.repeat(30)}project`
  const preview: SessionContinueT = { state: 'ready', provider: 'claude', displayName: 'Claude', project, mode: 'native_resume', matterId: null }

  it('keeps all safety copy and both actions inside a bounded scroll surface without bypassing fresh confirmation', async () => {
    const backend = makeDemoBackend({ lang })
    let previews = 0, release!: (value: SessionContinueT) => void
    const checking = new Promise<SessionContinueT>(resolve => { release = resolve })
    backend.continuePreview = async () => ++previews === 1 ? preview : checking
    const adopt = vi.spyOn(backend, 'continueSession')
    const ui = await mount(withProviders(createElement(SessionReader), { backend, lang })); await flush()
    await act(() => ui.byId('session-continue').click()); await flush()
    const sheet = ui.byId('continue-sheet')
    const scroll = sheet.querySelector('[data-native-scroll="true"]')
    expect(scroll).not.toBeNull()
    const bound = ui.style('continue-sheet').maxHeight
    expect(typeof bound).toBe('string')
    expect(bound.endsWith('%')).toBe(true)
    expect(parseFloat(bound)).toBeGreaterThan(0)
    expect(parseFloat(bound)).toBeLessThanOrEqual(100)
    for (const line of continueSheetLines(preview, lang)) expect(scroll!.textContent).toContain(line)
    const confirm = ui.byId('continue-confirm') as HTMLButtonElement
    expect(confirm.closest('[data-native-scroll="true"]')).toBe(scroll)
    expect(ui.byId('continue-cancel').closest('[data-native-scroll="true"]')).toBe(scroll)
    expect(confirm.disabled).toBe(true)
    await act(() => confirm.click())
    expect(adopt).not.toHaveBeenCalled()
    await act(async () => { release(preview); await checking }); await flush()
    expect((ui.byId('continue-confirm') as HTMLButtonElement).disabled).toBe(false)
    await act(() => ui.byId('continue-confirm').click()); await flush()
    expect(adopt).toHaveBeenCalledExactlyOnceWith('demo-claude-2')
    expect(route.replace).toHaveBeenCalledWith('/matter/demo0001')
    expect(route.push).toHaveBeenCalledWith('/compose?matter=demo0001&focus=1')
  })

  it('retains a reachable cancel action without continuing the session', async () => {
    const backend = makeDemoBackend({ lang })
    backend.continuePreview = async () => preview
    const adopt = vi.spyOn(backend, 'continueSession')
    const ui = await mount(withProviders(createElement(SessionReader), { backend, lang })); await flush()
    await act(() => ui.byId('session-continue').click()); await flush()
    expect(ui.byId('continue-cancel').closest('[data-native-scroll="true"]')).not.toBeNull()
    await act(() => ui.byId('continue-cancel').click()); await flush()
    expect(ui.byId('continue-sheet')).toBeNull()
    expect(adopt).not.toHaveBeenCalled()
    expect(route.replace).not.toHaveBeenCalled()
    expect(route.push).not.toHaveBeenCalled()
  })
})
