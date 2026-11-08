// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, ChatPageT } from '../backend/types'
import { advance, background, cleanup, focus, host, mount, reduce, resetHost } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('expo-router', async () => ({ ...(await (await import('../ui/native-motion.test-support')).routerBoundary()), useRouter: () => ({ push() {} }) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }))
const { ConversationPresence: Now } = await import('../ui/ConversationPresence')
beforeEach(() => { resetHost(); vi.useFakeTimers() })
afterEach(cleanup)

// 真的此刻页、真 Provider、真 CCFigure:「收到」动作 = CC 先往下沉 1(176ms)再回到 0(再 264ms)。
const translateY = (container: Element) => JSON.parse(container.querySelector('[data-testid="cc-lit"]')!.parentElement!.getAttribute('data-style')!)
  .transform.find((entry: any) => entry.translateY !== undefined).translateY

describe('home follows live chat evidence', () => {
  it('keeps live activity accessible and static under reduced motion, with expiry and lifecycle baselines', async () => {
    host.reduced = true
    const demo = makeDemoBackend({ lang: 'zh-Hans' })
    const backend: Backend = { ...demo, mode: 'live', cliSessions: async () => [],
      connection: () => ({ state: 'online', lastSyncedAt: 1, epoch: 1 }),
      onConnection: cb => { cb({ state: 'online', lastSyncedAt: 1, epoch: 1 }); return () => {} },
      subscribe: (name, cb) => name === 'approvals' ? (cb([] as any), () => {}) : name === 'agents' ? (cb({ running: 0, waiting: 0, tasks: [] } as any), () => {}) : demo.subscribe(name, cb),
    }
    const stream = (text: string) => ({ running: { turnId: 't' }, events: [{ id: 'fragment', turnId: 't', kind: 'agent_message', text }] })
    const node = (text: string) => withProviders(createElement(Now, { stream: stream(text) }), { backend })
    const ui = await mount(node('history')); await advance(0)
    await ui.render(node('history')) // First fresh read after the screen has become active.
    const still = (phase: string) => {
      expect(ui.style(`cc-phase-${phase}`).transform).toEqual([{ translateY: 0 }, { scale: 1 }, { rotate: '0deg' }])
    }
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说，正在处理回复'); still('thinking')
    await reduce(false)
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说，正在处理回复')
    await reduce(true); still('thinking')
    await ui.render(node('new text'))
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说，新回复正在到来'); still('speaking')
    await advance(900)
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说，正在处理回复'); still('thinking')
    await advance(1600)
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说'); still('idle')
    await ui.render(node('fresh')); still('speaking')
    await background('background'); still('idle')
    await ui.render(node('while away')); await background('active'); still('idle')
    await ui.render(node('return baseline')); still('thinking')
    await focus(false); still('idle')
    await focus(true); await ui.render(node('focus baseline')); still('thinking')
    await reduce(false); await advance(2500)
    expect(ui.byId('now-cc').getAttribute('aria-label')).toBe('跟 CC 说')
  })
  it('stays on home, refreshes on chat version changes, and animates only each genuinely new reply once', async () => {
    const message = (id: string, at: number) => ({ id, at, text: 'CC 的回复', role: 'cc' as const, source: 'phone' as const, kind: 'text', truncated: false })
    let page: ChatPageT = { matterId: 'owner', title: 'CC', messages: [message('history', 100)], pending: null, failed: null, hasMore: false, nextBefore: null }
    const callbacks = new Map<string, (data: unknown) => void>()
    const read = vi.fn(async () => page), chatSay = vi.fn()
    const demo = makeDemoBackend({ lang: 'zh-Hans' })
    // 只有「真连着电脑」CC 才亮、才动(演示是暗的),所以假后端报 live + 在线。
    const backend: Backend = { ...demo, mode: 'live', chat: read, chatSay, cliSessions: async () => [],
      connection: () => ({ state: 'online', lastSyncedAt: 1, epoch: 1 }),
      onConnection: cb => { cb({ state: 'online', lastSyncedAt: 1, epoch: 1 }); return () => {} },
      subscribe: <T,>(name: Parameters<Backend['subscribe']>[0], callback: (data: T) => void) => {
        if (name === 'approvals') { callback([] as T); return () => {} } // this test observes replies with no permission blocking them
        if (!name.startsWith('matter/')) return demo.subscribe(name, callback)
        callbacks.set(name, callback as (data: unknown) => void); callback({ version: 1 } as T); return () => { callbacks.delete(name) }
      },
    }
    const ui = await mount(withProviders(createElement(Now), { backend }))
    const settle = () => advance(0)
    const push = async (version: number) => { await act(async () => callbacks.get('matter/owner')?.({ version })); await settle() }
    await settle(); await advance(500)
    expect(read).toHaveBeenCalledOnce(); expect(translateY(ui.container)).toBe(0)
    page = { ...page, messages: [...page.messages, message('fresh-reply', 110)] }
    await push(2)
    expect(read).toHaveBeenCalledTimes(2)
    await advance(176); expect(translateY(ui.container)).toBe(1)
    await advance(264); expect(translateY(ui.container)).toBe(0)
    await push(2)
    expect(read).toHaveBeenCalledTimes(2)
    await push(3)
    expect(read).toHaveBeenCalledTimes(3); await advance(176); expect(translateY(ui.container)).toBe(0)
    page = { ...page, messages: [...page.messages, { ...message('system-notice', 110), text: '🔄 daemon 已重启' }] }
    await push(4)
    expect(read).toHaveBeenCalledTimes(4); await advance(176); expect(translateY(ui.container)).toBe(0)
    expect(chatSay).not.toHaveBeenCalled()
  })
})
