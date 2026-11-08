// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { color, componentAppearance } from '@wechat-cc/design-tokens'
import { makeDemoBackend } from '../backend/demo'
import { BackendError, type Backend } from '../backend/types'
import { cleanup, focus, mount } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
import { TopicRow } from '../ui/TopicRow'
import { TopicBubble as Topic } from '../app/topic'
const host = vi.hoisted(() => ({ params: {} as { id?: string; open?: string }, push: vi.fn(), back: vi.fn() }))
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('expo-router', async () => ({ ...(await (await import('../ui/native-motion.test-support')).routerBoundary()), useLocalSearchParams: () => host.params, useRouter: () => ({ push: host.push, back: host.back, canGoBack: () => true }) }))
afterEach(async () => { await cleanup(); host.params = {}; host.push.mockClear(); host.back.mockClear() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
describe('native topic surfaces', () => {
  it('hides topics on a routes-only/old connection without issuing topic reads or subscriptions', async () => {
    const demo = makeDemoBackend(), topics = vi.fn(demo.topics), subscribe = vi.fn(demo.subscribe)
    const backend: Backend = { ...demo, topics, subscribe, connection: () => ({ state: 'online', epoch: 1, lastSyncedAt: 1 }), onConnection: cb => { cb({ state: 'online', epoch: 1, lastSyncedAt: 1 }); return () => {} } }
    const ui = await mount(withProviders(createElement(TopicRow), { backend })); await flush()
    expect(ui.byId('topic-row')).toBeNull(); expect(topics).not.toHaveBeenCalled()
    expect(subscribe.mock.calls.filter(([name]) => name === 'topics')).toEqual([])
  })
  it('renders six recent topics; clicking navigates, while reads and closing never write closed', async () => {
    const demo = makeDemoBackend(), topics = vi.fn(demo.topics), open = vi.fn(demo.topicOpen)
    const backend = { ...demo, topics, topicOpen: open }
    const ui = await mount(withProviders(createElement(TopicRow), { backend, lang: 'zh-Hans' })); await flush()
    expect(ui.container.querySelectorAll('[data-testid^="topic-demo-"]')).toHaveLength(6)
    expect(topics).toHaveBeenCalledWith({ limit: 6 }); expect(open).not.toHaveBeenCalled()
    expect(ui.style('topic-demo-backup')).toMatchObject({ borderRadius: componentAppearance.topic.radius, borderColor: color.hair, minHeight: 44, minWidth: 44, backgroundColor: 'transparent' })
    await act(() => ui.byId('topic-demo-backup').click())
    expect(host.push).toHaveBeenCalledWith('/topic?id=demo-backup&open=1'); expect(open).not.toHaveBeenCalled()
    expect(ui.byId('topic-demo-backup').getAttribute('aria-selected')).toBe('true')
    expect(ui.style('topic-demo-backup').borderColor).toBe(color.ink)
    await focus(false); await focus(true)
    expect(ui.byId('topic-demo-backup').getAttribute('aria-selected')).toBe('false')
    expect(ui.style('topic-demo-backup').borderColor).toBe(color.hair)
  })
  it('retains a trailing read when a newer revision arrives during an older in-flight read', async () => {
    const demo = makeDemoBackend(), old = await demo.topics({})
    const fresh = { ...old, revision: 'r3', topics: [{ ...old.topics[0]!, title: '最新的备份' }] }
    let resolve!: (v: typeof old) => void, update: ((data: unknown) => void) | undefined
    const topics = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue(fresh)
    const backend: Backend = { ...demo, topics, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    const ui = await mount(withProviders(createElement(TopicRow), { backend })); await flush()
    await act(() => { update?.({ revision: 'r2' }); update?.({ revision: 'r3' }) })
    await act(() => resolve(old)); await flush(); await flush()
    expect(topics).toHaveBeenCalledTimes(2); expect(ui.container.textContent).toContain('最新的备份')
    await act(() => update?.({ revision: 'r3' })); await flush(); expect(topics).toHaveBeenCalledTimes(2)
  })

  it('folds a successfully slept selection on return, without popping an overlaid matter or writing closed', async () => {
    const demo = makeDemoBackend(), open = vi.fn(demo.topicOpen)
    let closed = false, update: ((data: unknown) => void) | undefined
    const backend: Backend = { ...demo, topicOpen: open, topicDetail: async p => {
      const d = await demo.topicDetail(p)
      return { ...d, topic: { ...d.topic, bubbleState: closed ? 'closed' : 'open' }, revision: closed ? 'sleep-2' : 'open-1' }
    }, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    host.params = { id: 'demo-backup', open: '1' }
    await mount(withProviders(createElement(Topic), { backend })); await flush(); await flush()
    await focus(false)
    closed = true; await act(() => update?.({ revision: 'sleep-2' })); await flush()
    expect(host.back).not.toHaveBeenCalled()
    await focus(true)
    expect(host.back).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  })

  it('opens only an explicit click, shows source-backed memory, refreshes in place, and clears a deleted selection', async () => {
    const demo = makeDemoBackend({ lang: 'zh-Hans' }), open = vi.fn(demo.topicOpen)
    let title = '原话题', gone = false, update: ((data: unknown) => void) | undefined
    const backend: Backend = { ...demo, topicOpen: open, topicDetail: async p => { if (gone) throw new BackendError('not_found'); const d = await demo.topicDetail(p); return { ...d, topic: { ...d.topic, title } } }, subscribe: (name, cb) => {
      if (name !== 'topics') return demo.subscribe(name, cb)
      update = cb as (data: unknown) => void; return () => { update = undefined }
    } }
    host.params = { id: 'demo-backup', open: '1' }
    const ui = await mount(withProviders(createElement(Topic), { backend, lang: 'zh-Hans' })); await flush(); await flush()
    expect(open).toHaveBeenCalledOnce(); expect(ui.container.textContent).toContain('原话题')
    await act(() => ui.byId('topic-entry-demo-entry').click()); expect(ui.container.textContent).toContain('每周核验一次备份。')
    title = '新的话题'; await act(() => update?.({ revision: 'r2' })); await flush()
    expect(ui.container.textContent).toContain('新的话题'); expect(open).toHaveBeenCalledOnce()
    gone = true; await act(() => update?.({ revision: 'r3' })); await flush()
    expect(ui.container.textContent).not.toContain('新的话题'); expect(ui.container.textContent).toContain('这个话题已不可用')
    await act(() => ui.byId('topbar-back').click()); expect(host.back).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  })
})
