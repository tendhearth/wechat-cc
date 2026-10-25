// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, ChatPageT } from '../backend/types'
import { makeStore, type Store } from './store'
import Now from '../app/(tabs)/index'
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store }, events: [] as string[] }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('./BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('react-native', async () => (await import('../ui/native-motion.test-support')).nativeBoundary())
vi.mock('react-native-safe-area-context', async () => { const { createElement } = await import('react'); return { SafeAreaView: ({ children }: any) => createElement('main', null, children) } })
vi.mock('expo-router', () => ({ useRouter: () => ({ push() {} }) }))
vi.mock('./useWork', () => ({ useWork: () => ({ approvals: [], approvalsKnown: true, agents: { running: 0 }, matters: [], demo: false }) }))
vi.mock('./useTerminal', () => ({ useTerminalSessions: () => ({ sessions: [], loaded: true }) }))
vi.mock('./useToday', () => ({ useToday: () => ({ today: undefined }) }))
vi.mock('./useAway', () => ({ useAwaySince: () => null }))
vi.mock('./useCompanion', () => ({ useCompanion: () => ({ activity: undefined, home: undefined, localSeen: [] }) }))
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))
vi.mock('../ui/ConnectionNotice', () => ({ ConnectionNotice: () => null }))
vi.mock('../ui/CompanionCard', () => ({ CompanionCard: () => null }))
vi.mock('../ui/motion', () => ({ useMotionEnabled: () => true }))
vi.mock('../ui/CCFigure', async () => {
  const { useEffect } = await import('react')
  return { CCFigure: ({ eventKey }: any) => { useEffect(() => { if (eventKey) host.events.push(eventKey) }, [eventKey]); return null } }
})
let root: { render(node: any): void; unmount(): void } | undefined
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
afterEach(async () => { await act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; host.events.length = 0 })

describe('home follows live chat evidence', () => {
  it('stays on home, refreshes on chat version changes, and animates only each genuinely new reply once', async () => {
    const message = (id: string, at: number) => ({ id, at, text: 'CC 的回复', role: 'cc' as const, source: 'phone' as const, kind: 'text', truncated: false })
    let page: ChatPageT = { matterId: 'owner', title: 'CC', messages: [message('history', 100)], pending: null, failed: null, hasMore: false, nextBefore: null }
    const callbacks = new Map<string, (data: unknown) => void>()
    const read = vi.fn(async () => page), chatSay = vi.fn()
    const backend: Backend = { ...makeDemoBackend({ lang: 'zh-Hans' }), chat: read, chatSay,
      connection: () => ({ state: 'online', lastSyncedAt: 1, epoch: 1 }),
      subscribe: <T,>(name: Parameters<Backend['subscribe']>[0], callback: (data: T) => void) => { callbacks.set(name, callback as (data: unknown) => void); callback({ version: 1 } as T); return () => { callbacks.delete(name) } },
    }
    host.ctx = { backend, store: makeStore(backend, { lang: 'zh-Hans' }) }
    const div = document.createElement('div'); document.body.appendChild(div); root = createRoot(div)
    await act(() => root!.render(createElement(Now))); await flush()
    expect(read).toHaveBeenCalledOnce(); expect(host.events).toEqual([])
    page = { ...page, messages: [...page.messages, message('fresh-reply', 110)] }
    await act(() => callbacks.get('matter/owner')?.({ version: 2 })); await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(host.events).toEqual(['receive:fresh-reply:110'])
    await act(() => callbacks.get('matter/owner')?.({ version: 2 })); await flush()
    expect(read).toHaveBeenCalledTimes(2)
    await act(() => callbacks.get('matter/owner')?.({ version: 3 })); await flush()
    expect(read).toHaveBeenCalledTimes(3); expect(host.events).toEqual(['receive:fresh-reply:110'])
    page = { ...page, messages: [...page.messages, { ...message('system-notice', 110), text: '🔄 daemon 已重启' }] }
    await act(() => callbacks.get('matter/owner')?.({ version: 4 })); await flush()
    expect(read).toHaveBeenCalledTimes(4); expect(host.events).toEqual(['receive:fresh-reply:110'])
    expect(chatSay).not.toHaveBeenCalled()
  })
})
