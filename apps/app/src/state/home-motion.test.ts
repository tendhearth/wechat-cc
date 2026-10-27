// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, ChatPageT } from '../backend/types'
import { advance, cleanup, mount, resetHost } from '../ui/native-motion.test-support'
import { withProviders } from './providers.test-support'
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('expo-router', async () => ({ ...(await (await import('../ui/native-motion.test-support')).routerBoundary()), useRouter: () => ({ push() {} }) }))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {} }))
const { default: Now } = await import('../app/(tabs)/index')
beforeEach(() => { resetHost(); vi.useFakeTimers() })
afterEach(cleanup)

// 真的此刻页、真 Provider、真 CCFigure:「收到」动作 = CC 先往下沉 1(176ms)再回到 0(再 264ms)。
const translateY = (container: Element) => JSON.parse(container.querySelector('[data-testid="cc-lit"]')!.parentElement!.getAttribute('data-style')!)
  .transform.find((entry: any) => entry.translateY !== undefined).translateY

describe('home follows live chat evidence', () => {
  it('stays on home, refreshes on chat version changes, and animates only each genuinely new reply once', async () => {
    const message = (id: string, at: number) => ({ id, at, text: 'CC 的回复', role: 'cc' as const, source: 'phone' as const, kind: 'text', truncated: false })
    let page: ChatPageT = { matterId: 'owner', title: 'CC', messages: [message('history', 100)], pending: null, failed: null, hasMore: false, nextBefore: null }
    const callbacks = new Map<string, (data: unknown) => void>()
    const read = vi.fn(async () => page), chatSay = vi.fn()
    const demo = makeDemoBackend({ lang: 'zh-Hans' })
    // 只有「真连着电脑」CC 才亮、才动(演示是暗的),所以假后端报 live + 在线。
    const backend: Backend = { ...demo, mode: 'live', chat: read, chatSay,
      connection: () => ({ state: 'online', lastSyncedAt: 1, epoch: 1 }),
      onConnection: cb => { cb({ state: 'online', lastSyncedAt: 1, epoch: 1 }); return () => {} },
      subscribe: <T,>(name: Parameters<Backend['subscribe']>[0], callback: (data: T) => void) => {
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
