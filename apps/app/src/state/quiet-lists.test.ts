// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../ui/native-motion.test-support'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend, type MatterT } from '../backend/types'
import { t } from '../i18n'
import { WorkSearchResults as All } from '../ui/WorkSearchResults'
import { ConversationMore as Home } from '../ui/ConversationMore'
import Activity from '../app/activity'
import Jobs from '../app/jobs'
import Letters from '../app/letters'
import Connections from '../app/connections'
import Sessions from '../app/sessions'
import { withProviders, type TestCtx } from './providers.test-support'
import { useWork } from './useWork'
import { CONNECTIONS_POLL_MS } from './useConnections'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const host = { ctx: null as unknown as TestCtx, work: null as unknown as ReturnType<typeof useWork> }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }))
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
function backendWithMatters(load: () => Promise<MatterT[]>, opts: { approvals?: boolean } = {}): Backend {
  const demo = makeDemoBackend({ lang: 'en' })
  // approvals: false ⇒ 「等你」这一路是空的(否则演示的批准会在列表里出行,列表就不「空」了)
  const subscribe: Backend['subscribe'] = (name, cb) => opts.approvals === false && name === 'approvals' ? (cb([] as never), () => {}) : demo.subscribe(name, cb)
  return { ...demo, cliSessions: async () => [], matters: load, matterHistory: load, subscribe }
}
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})

describe('matter list loading evidence', () => {
  it('connection confirmation updates while the page stays open, without a refresh tap', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const demo = makeDemoBackend({ lang: 'en' })
      let code = 'terminal.codex_untrusted'
      await mount({ ...demo, async connections() { return { generatedAt: Date.now(), sources: [], computers: [], recent: [], outputs: [], capabilities: [{ id: 'terminal', name: 'Codex', state: code === 'terminal.ok' ? 'ok' : 'needs_you', code, reason: 'fallback', params: { n: 0 } }] } } }, createElement(Connections))
      expect(el('connections-cap-terminal')?.textContent).toContain('Codex needs one more step')
      code = 'terminal.ok'
      await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTIONS_POLL_MS) })
      expect(el('connections-cap-terminal')?.textContent).toContain('Connected: 0 terminal sessions')
      code = 'terminal.codex_changed'
      await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTIONS_POLL_MS) })
      expect(el('connections-cap-terminal')?.textContent).toContain('Codex needs your confirmation again')
    } finally { vi.useRealTimers() }
  })
  it('useWork distinguishes an unread list from a successfully read empty list', async () => {
    let resolve!: (rows: MatterT[]) => void
    await mount(backendWithMatters(() => new Promise(r => { resolve = r })), createElement(WorkProbe))
    expect(host.work).toMatchObject({ matters: [], mattersLoading: true, mattersKnown: false })
    await act(async () => { resolve([]) }); await flush()
    expect(host.work).toMatchObject({ matters: [], mattersLoading: false, mattersKnown: true })
  })

  it('the full list shows loading before the first read and offers a read-only retry after failure', async () => {
    let reject!: (reason: Error) => void
    let succeed = false
    const backend = backendWithMatters(() => succeed ? Promise.resolve([]) : new Promise((_, no) => { reject = no }), { approvals: false })
    await mount(backend, createElement(All))
    expect(el('all-empty')).toBeNull()
    expect(el('all-loading')?.getAttribute('aria-label')).toBeTruthy()
    await act(async () => { reject(new BackendError('offline')) }); await flush()
    expect(el('all-empty')).toBeNull()
    expect(el('all-unavailable')).not.toBeNull()
    succeed = true
    await act(async () => { el('all-retry')?.click() }); await flush()
    expect(el('all-unavailable')).toBeNull()
    expect(el('all-empty')).not.toBeNull()
  })

  it('search filters do not reintroduce excluded waiting tasks as orphan approval references', async () => {
    const backend = makeDemoBackend({ lang: 'en' })
    await mount(backend, createElement(All, { query: 'no-title-matches-this' }))
    expect(el('row-matter-a1b2c3d4')).toBeNull()
    expect(el('row-matter-c9d0e1f2')).toBeNull()
    expect(el('all-empty')).not.toBeNull()
  })

  it('retains known rows and marks them stale when a later read fails', async () => {
    let fail = false
    const matter: MatterT = { id: 'a1b2c3d4', kind: 'task', title: 'Keep this task', projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 }
    await mount(backendWithMatters(async () => {
      if (fail) throw new BackendError('offline')
      return [matter]
    }), createElement(All))
    expect(el('row-matter-a1b2c3d4')?.textContent).toContain('Keep this task')
    fail = true
    await act(async () => { host.ctx.store.revalidateAll() }); await flush()
    expect(el('all-stale')).not.toBeNull()
    expect(el('all-unavailable')).toBeNull()
    expect(el('row-matter-a1b2c3d4')?.textContent).toContain('Keep this task')
  })
})

describe('shared list loading feedback', () => {
  it('keeps secondary routes behind the home more action without removing their destinations', async () => {
    await mount(backendWithMatters(async () => []), createElement(Home))
    expect(el('home-sessions')).toBeNull()
    await act(() => { el('home-more')?.click() }); await flush()
    expect(el('home-sessions')).not.toBeNull()
    expect(el('home-saved-inputs')).not.toBeNull()
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
