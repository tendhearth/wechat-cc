// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../ui/native-motion.test-support'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type MatterT } from '../backend/types'
import { t } from '../i18n'
import Together from '../app/(tabs)/together'
import Activity from '../app/activity'
import Jobs from '../app/jobs'
import Letters from '../app/letters'
import Sessions from '../app/sessions'
import { withProviders, type TestCtx } from './providers.test-support'
import { useWork } from './useWork'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const host = { ctx: null as unknown as TestCtx, work: null as unknown as ReturnType<typeof useWork> }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const View = ({ children, testID, accessibilityLabel }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children)
  const Pressable = ({ children, onPress, disabled, testID, accessibilityLabel }: any) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children)
  class Value { constructor(public value: number) {} setValue(n: number) { this.value = n }; stopAnimation() {}; interpolate() { return this } }
  const animation = () => ({ start() {}, stop() {} })
  return {
    View, Text: View, Pressable, ScrollView: View, ActivityIndicator: View, Image: () => null, TextInput: () => createElement('input'),
    SectionList: ({ sections, ListEmptyComponent, ListHeaderComponent, ListFooterComponent, renderItem, renderSectionHeader }: any) => createElement('div', null,
      ListHeaderComponent, sections.some((s: any) => s.data.length) ? sections.map((s: any) => createElement('section', { key: s.key }, renderSectionHeader({ section: s }), s.data.map((item: any) => createElement('div', { key: item.id }, renderItem({ item }))))) : ListEmptyComponent, ListFooterComponent),
    Modal: ({ visible, children }: any) => visible ? createElement('dialog', { open: true }, children) : null,
    Animated: { Value, View, timing: animation, loop: animation, parallel: animation },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove() {} }) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Easing: { ease: (x: number) => x, out: (x: any) => x, linear: (x: number) => x }, findNodeHandle: () => null,
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: ({ children }: any) => createElement('main', null, children) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) }))

const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(backend: Backend, node: ReactNode) {
  const div = document.createElement('div'); document.body.appendChild(div)
  const root = createRoot(div); roots.push(root)
  await act(async () => { root.render(withProviders(node, { backend, lang: 'en', onCtx: ctx => { host.ctx = ctx } })) })
  await flush()
}
function WorkProbe() { host.work = useWork(); return null }
// 终端会话这一路给空(此前是把 useTerminal 整个 mock 成空;现在走真 hook,空列表放在后端边界上)。
function backendWithMatters(load: () => Promise<MatterT[]>): Backend {
  return { ...makeDemoBackend({ lang: 'en' }), cliSessions: async () => [], matters: load }
}
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})

describe('matter list loading evidence', () => {
  it('useWork distinguishes an unread list from a successfully read empty list', async () => {
    let resolve!: (rows: MatterT[]) => void
    await mount(backendWithMatters(() => new Promise(r => { resolve = r })), createElement(WorkProbe))
    expect(host.work).toMatchObject({ matters: [], mattersLoading: true, mattersKnown: false })
    await act(async () => { resolve([]) }); await flush()
    expect(host.work).toMatchObject({ matters: [], mattersLoading: false, mattersKnown: true })
  })

  it('together shows loading before the first read and offers a read-only retry after failure', async () => {
    let reject!: (reason: Error) => void
    let succeed = false
    const backend = backendWithMatters(() => succeed ? Promise.resolve([]) : new Promise((_, no) => { reject = no }))
    await mount(backend, createElement(Together))
    expect(el('together-empty')).toBeNull()
    expect(el('together-loading')?.getAttribute('aria-label')).toBeTruthy()
    await act(async () => { reject(new BackendError('offline')) }); await flush()
    expect(el('together-empty')).toBeNull()
    expect(el('together-unavailable')).not.toBeNull()
    succeed = true
    await act(async () => { el('together-retry')?.click() }); await flush()
    expect(el('together-unavailable')).toBeNull()
    expect(el('together-empty')).not.toBeNull()
  })

  it('retains known rows and marks them stale when a later read fails', async () => {
    let fail = false
    const matter: MatterT = { id: 'a1b2c3d4', kind: 'task', title: 'Keep this task', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }
    await mount(backendWithMatters(async () => {
      if (fail) throw new BackendError('offline')
      return [matter]
    }), createElement(Together))
    expect(el('together-item-a1b2c3d4')?.textContent).toContain('Keep this task')
    fail = true
    await act(async () => { host.ctx.store.revalidateAll() }); await flush()
    expect(el('together-stale')).not.toBeNull()
    expect(el('together-unavailable')).toBeNull()
    expect(el('together-item-a1b2c3d4')?.textContent).toContain('Keep this task')
  })
})

describe('shared list loading feedback', () => {
  it('keeps secondary Together routes behind the more action without removing their destinations', async () => {
    await mount(backendWithMatters(async () => []), createElement(Together))
    expect(el('together-sessions')).toBeNull()
    await act(() => { el('together-more')?.click() }); await flush()
    expect(el('together-sessions')).not.toBeNull()
    expect(el('together-saved-inputs')).not.toBeNull()
  })
  it('letters marks a previously read empty list stale after a later read fails', async () => {
    let fail = false
    const backend = { ...makeDemoBackend({ lang: 'en' }), letters: async () => {
      if (fail) throw new BackendError('offline')
      return []
    } } as Backend
    await mount(backend, createElement(Letters))
    expect(el('letters-empty')).not.toBeNull()
    fail = true
    await act(() => { host.ctx.store.revalidateAll() }); await flush()
    expect(el('letters-stale')).not.toBeNull()
    expect(el('letters-empty')).not.toBeNull()
  })

  it.each([
    ['activity', Activity, 'activity', 'activity.unavailable'], ['jobs', Jobs, 'jobs', 'jobs.unavailable'], ['letters', Letters, 'letters', 'letters.unavailable'], ['sessions', Sessions, 'sessions', 'sessions.slow'],
  ] as const)('%s uses an accessible busy indicator until the first read, and never shows empty success after a failed read', async (id, Page, method, errorKey) => {
    let reject!: (reason: Error) => void
    const backend = { ...makeDemoBackend({ lang: 'en' }), [method]: () => new Promise((_, no) => { reject = no }) } as Backend
    await mount(backend, createElement(Page))
    expect(el(`${id}-loading`)).not.toBeNull()
    expect(el(`${id}-loading`)?.getAttribute('aria-label')).toBeTruthy()
    expect(el(`${id}-empty`)).toBeNull()
    await act(async () => { reject(new BackendError('offline')) }); await flush()
    expect(el(`${id}-loading`)).toBeNull()
    expect(el(`${id}-empty`)).toBeNull()
    expect(el(`${id}-retry`)).not.toBeNull()
    expect(el(id === 'sessions' ? 'sessions-slow' : `${id}-unavailable`)?.getAttribute('aria-label')).toBe(t('en', errorKey))
  })
})
