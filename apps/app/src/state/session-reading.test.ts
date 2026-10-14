// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from '../backend/live'
import type { Backend, NativeSessionPageT, NativeSessionRowT, SessionContinueT } from '../backend/types'
import { makeStore, type Store } from './store'
import { watchConnection } from './wiring'
import Sessions from '../app/sessions/index'
import SessionReader from '../app/sessions/[key]'
import Together from '../app/(tabs)/together'
import { palette } from '../ui/tokens'

type Root = { render(node: ReactNode): void; unmount(): void }
type FocusEntry = { run(): void | (() => void); cleanup?: void | (() => void) }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = [], disposers: Array<() => void> = []
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store }, params: { key: 'k1' }, focused: true, focusEntries: new Set<FocusEntry>(), back: vi.fn(), push: vi.fn(), replace: vi.fn(), dotColours: [] as string[] }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  const View = ({ children, testID, style }: any) => {
    const flat = Object.assign({}, ...(Array.isArray(style) ? style : [style]))
    if (flat.width === 8 && flat.height === 8) host.dotColours.push(flat.backgroundColor)
    return createElement('div', { 'data-testid': testID, 'data-dot': flat.width === 8 && flat.height === 8 ? flat.backgroundColor : undefined }, children)
  }
  const Text = ({ children, onPress, testID, accessibilityRole }: any) => createElement('span', { 'data-testid': testID, onClick: onPress, role: accessibilityRole }, children)
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID, accessibilityLabel, maxLength }: any, ref) => createElement('textarea', { ref, value, maxLength, 'data-testid': testID, 'aria-label': accessibilityLabel, onInput: (event: any) => onChangeText(event.currentTarget.value) }))
  const Pressable = ({ children, onPress, disabled, testID, accessibilityLabel, accessibilityRole, accessibilityState }: any) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel, role: accessibilityRole, 'aria-expanded': accessibilityState?.expanded, 'aria-disabled': accessibilityState?.disabled }, children)
  const Modal = ({ visible, children }: any) => visible ? createElement('div', null, children) : null
  const FlatList = ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => createElement('div', null, ListHeaderComponent, data.length ? data.map((item: any) => createElement('div', { key: item.id }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent)
  return { View, Text, TextInput, Pressable, Modal, FlatList, ScrollView: View, ActivityIndicator: View, Linking: { openURL: vi.fn() }, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default } }
})
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react')
  return { SafeAreaView: ({ children }: any) => createElement('main', null, children) }
})
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useLocalSearchParams: () => host.params,
    useRouter: () => ({ canGoBack: () => true, back: host.back, push: host.push, replace: host.replace }),
    useFocusEffect: (run: FocusEntry['run']) => useEffect(() => {
      const entry: FocusEntry = { run }; host.focusEntries.add(entry)
      if (host.focused) entry.cleanup = run()
      return () => { entry.cleanup?.(); host.focusEntries.delete(entry) }
    }, [run]),
  }
})
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('./BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('./useWork', () => ({ useWork: () => ({ approvals: [], agents: undefined, matters: [] }) }))
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))
vi.mock('../ui/CCFigure', () => ({ CCFigure: () => null }))

type Reply = { status: number; json: unknown } | Error
const ok = (json: unknown, status = 200): Reply => ({ status, json })
const row = (key = 'k1', provider: 'claude' | 'codex' = 'claude'): NativeSessionRowT => ({ key, provider, title: `会话 ${key}`, project: 'demo', updatedAt: 1, active: true })
const messages = (start: number, end: number): NativeSessionPageT['messages'] => Array.from({ length: end - start }, (_, i) => ({ id: `msg-${i + start}`, role: i % 2 ? 'assistant' : 'user', text: `第${i + start}条`, truncated: false }))
const ready = (state: SessionContinueT['state'] = 'ready'): SessionContinueT => ({ state, provider: 'claude', project: 'demo', mode: state === 'ready' ? 'native_resume' : null, matterId: null })
function harness() {
  let list: (url: URL) => Reply | Promise<Reply> = url => ok({ ok: true, items: [row(url.searchParams.get('q') || 'k1', url.searchParams.get('provider') as 'claude' | 'codex')], nextCursor: null })
  let read: (url: URL) => Reply | Promise<Reply> = url => {
    const window = url.searchParams.get('window') ?? 'start'
    const cursor = url.searchParams.get('cursor')
    return ok({ ok: true, session: row(url.searchParams.get('key')!), managed: false, window, messages: window === 'recent' ? messages(20, 40) : cursor ? messages(19, 40) : messages(0, 20), nextCursor: window === 'recent' || cursor ? null : 'next' })
  }
  let preview: (url: URL) => Reply | Promise<Reply> = () => ok({ ok: true, ...ready() })
  let adopt: (body: unknown) => Reply | Promise<Reply> = () => ok({ ok: true, matterId: 'ab12cd34', created: true })
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  const clients: Array<{ opts: ClientOpts; subs: Map<string, (data: unknown) => void> }> = []
  const makeClient = (opts: ClientOpts): ProtocolClient => {
    const client = { opts, subs: new Map<string, (data: unknown) => void>() }; clients.push(client)
    return {
      version: () => 2,
      async request(request: ProtocolRequest) {
        const url = new URL(request.path, 'http://test.local'), body = typeof request.body === 'string' ? JSON.parse(request.body) : undefined
        requests.push({ path: request.path, method: request.method, body })
        let reply: Reply
        if (url.pathname === '/m/api/sessions') reply = await list(url)
        else if (url.pathname === '/m/api/session') reply = await read(url)
        else if (url.pathname === '/m/api/session/continue') reply = request.method === 'GET' ? await preview(url) : await adopt(body)
        else if (url.pathname === '/m/api/chat') reply = ok({ ok: false, error: 'no_owner_chat' }, 404)
        else throw new Error(`unexpected ${request.path}`)
        if (reply instanceof Error) throw reply
        if (reply.status < 400) expect(PHONE_API_SCHEMAS[`${request.method} ${url.pathname}`]?.safeParse(reply.json).success).toBe(true)
        const text = JSON.stringify(reply.json)
        return { status: reply.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe(topic, callback) { client.subs.set(topic, data => callback(data, { epoch: 'test', seq: 1 })); return () => { client.subs.delete(topic) } },
      close() {},
    }
  }
  const backend = makeLiveBackend({ open: () => { throw new Error('no network') }, token: 'test-only', makeClient })
  const store = makeStore(backend, { lang: 'zh-Hans' }), stop = watchConnection(backend, store, () => {})
  disposers.push(() => { stop(); backend.dispose() })
  const status = (state: 'ready' | 'down') => clients.at(-1)!.opts.onStatus?.(state)
  status('ready'); host.ctx = { backend, store }
  return { backend, store, requests, status, setList: (run: typeof list) => { list = run }, setRead: (run: typeof read) => { read = run }, setPreview: (run: typeof preview) => { preview = run }, setAdopt: (run: typeof adopt) => { adopt = run }, posts: () => requests.filter(request => request.method === 'POST') }
}
beforeEach(() => { host.params = { key: 'k1' }; host.focused = true; host.back.mockClear(); host.push.mockClear(); host.replace.mockClear(); host.dotColours.length = 0 })
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  for (const dispose of disposers.splice(0)) dispose()
  host.focusEntries.clear(); document.body.innerHTML = ''
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function focus(on: boolean) { await act(() => {
  if (host.focused === on) return
  host.focused = on
  for (const entry of host.focusEntries) {
    if (on) entry.cleanup = entry.run()
    else { entry.cleanup?.(); entry.cleanup = undefined }
  }
}); await flush() }
async function mount(component: () => ReactNode) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container); roots.push(root)
  await act(() => root.render(createElement(component))); await flush()
  const byId = <T extends Element = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)!
  const click = async (id: string) => { await act(() => byId<HTMLButtonElement>(id).click()); await flush() }
  const type = async (value: string) => { await act(() => {
    const input = byId<HTMLTextAreaElement>('sessions-search-input'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await flush() }
  return { container, root, byId, click, type }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(run => { resolve = run }); return { promise, resolve } }

describe('session reading with real LiveBackend and native UI', () => {
  it('defaults to confirmed recent 20; from-head paging deduplicates overlap', async () => {
    const h = harness(), ui = await mount(SessionReader)
    expect(h.requests.some(request => request.path === '/m/api/session?key=k1&window=recent')).toBe(true)
    expect(ui.byId('session-window').textContent).toBe('最近的对话')
    expect(ui.container.querySelectorAll('[data-testid^="session-message-"]')).toHaveLength(20)
    expect(ui.container.textContent).toContain('第39条'); expect(ui.container.textContent).not.toContain('第0条')
    expect(ui.byId('session-more')).toBeNull()
    await ui.click('session-view-start')
    expect(ui.byId('session-window').textContent).toBe('从头的记录')
    expect(ui.container.textContent).toContain('第0条')
    await ui.click('session-more')
    expect(h.requests.at(-1)!.path).toBe('/m/api/session?key=k1&cursor=next&window=start')
    expect(ui.container.querySelectorAll('[data-testid^="session-message-"]')).toHaveLength(40)
    expect(h.posts()).toHaveLength(0)
  })
  it('never labels legacy unconfirmed history as recent and offers from-head reading', async () => {
    const h = harness(); h.setRead(() => ok({ ok: true, session: row(), managed: false, messages: messages(0, 4), nextCursor: 'old' }))
    const ui = await mount(SessionReader)
    expect(ui.byId('session-window')).toBeNull()
    expect(ui.byId('session-window-unconfirmed').textContent).toContain('没能确认最近')
    expect(ui.byId('session-view-start')).not.toBeNull()
    expect(ui.byId('session-more')).toBeNull()
    await ui.click('session-view-start')
    expect(h.requests.some(request => request.path.endsWith('window=start'))).toBe(true)
    expect(ui.byId('session-more')).not.toBeNull()
  })
  it('does not silently fall back after unavailable recent; the owner can explicitly read from the start', async () => {
    const h = harness(); h.setRead(url => url.searchParams.get('window') === 'recent' ? ok({ ok: false, error: 'unavailable' }, 503) : ok({ ok: true, session: row(), managed: false, window: 'start', messages: messages(0, 4), nextCursor: null }))
    const ui = await mount(SessionReader)
    expect(ui.byId('sessions-slow').textContent).toContain('可以从头查看')
    expect(h.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(1)
    await ui.click('session-view-start')
    expect(ui.container.textContent).toContain('第0条')
    expect(ui.byId('session-window').textContent).toBe('从头的记录')
  })
  it('discards late mode, pagination and key responses without overwriting the current reader', async () => {
    const h = harness(), recent = gate<Reply>(), headPage = gate<Reply>()
    h.setRead(url => {
      const key = url.searchParams.get('key')!, window = url.searchParams.get('window')!
      if (key === 'k2') return ok({ ok: true, session: row('k2'), messages: [{ id: 'other', role: 'assistant', text: '另一个会话的新消息', truncated: false }], nextCursor: null, managed: false, window })
      if (window === 'recent') return recent.promise
      if (url.searchParams.has('cursor')) return headPage.promise
      return ok({ ok: true, session: row(), messages: messages(0, 4), nextCursor: 'p2', managed: false, window: 'start' })
    })
    const ui = await mount(SessionReader)
    await ui.click('session-view-start')
    await act(() => recent.resolve(ok({ ok: true, session: row(), messages: [{ id: 'old', role: 'assistant', text: '过期近期回包', truncated: false }], nextCursor: null, managed: false, window: 'recent' }))); await flush()
    expect(ui.container.textContent).not.toContain('过期近期回包')
    await act(() => ui.byId<HTMLButtonElement>('session-more').click()); await flush()
    host.params = { key: 'k2' }; await act(() => ui.root.render(createElement(SessionReader))); await flush()
    await act(() => headPage.resolve(ok({ ok: true, session: row(), messages: [{ id: 'old2', role: 'assistant', text: '过期追加页', truncated: false }], nextCursor: null, managed: false, window: 'start' }))); await flush()
    expect(ui.byId('session-window').textContent).toBe('最近的对话')
    expect(ui.container.textContent).toContain('另一个会话的新消息')
    expect(ui.container.textContent).not.toContain('过期追加页')
  })
  it('moves busy to ready by same-page recheck, locks duplicate confirmation while checking and preserves explicit stop confirmation', async () => {
    const h = harness(); h.setPreview(() => ok({ ok: true, ...ready('busy_session') }))
    const ui = await mount(SessionReader)
    expect(ui.byId('session-continue-note').textContent).toContain('停下后')
    expect(ui.byId('session-continue-retry').textContent).toBe('重新检查')
    h.setPreview(() => ok({ ok: true, ...ready() }))
    await ui.click('session-continue-retry')
    expect(ui.byId('session-continue')).not.toBeNull()
    const check = gate<Reply>(); h.setPreview(() => check.promise)
    await ui.click('session-continue')
    expect(ui.byId<HTMLButtonElement>('continue-confirm').disabled).toBe(true)
    await ui.click('continue-confirm')
    expect(h.posts()).toHaveLength(0)
    await act(() => check.resolve(ok({ ok: true, ...ready() }))); await flush()
    expect(ui.container.textContent).toContain('先让电脑上原来那个 Claude Code 停下')
    expect(ui.byId('continue-confirm').textContent).toBe('已经停了，接着做')
    await ui.click('continue-confirm')
    expect(h.posts()).toEqual([{ path: '/m/api/session/continue', method: 'POST', body: { key: 'k1' } }])
    expect(host.replace).toHaveBeenCalledWith('/matter/ab12cd34')
    expect(host.push).toHaveBeenCalledWith('/compose?matter=ab12cd34&focus=1')
  })
  it('rechecks only preview on focus and reconnect without replacing loaded records or starting a task', async () => {
    const h = harness(); h.setPreview(() => ok({ ok: true, ...ready('busy_folder') }))
    const ui = await mount(SessionReader)
    await focus(false)
    h.setPreview(() => ok({ ok: true, ...ready() }))
    await focus(true)
    expect(ui.byId('session-continue')).not.toBeNull()
    const before = h.requests.length
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    expect(h.requests.slice(before).map(request => request.path)).toContain('/m/api/session/continue?key=k1')
    expect(h.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(1)
    expect(h.posts()).toHaveLength(0)
  })
  it('keeps from-head pages and expanded exact source across focus and epoch; explicit refresh replaces them', async () => {
    const h = harness()
    const raw = '\r\n**保留原文**\r\n'
    let refreshed = false
    h.setRead(url => {
      const window = url.searchParams.get('window') ?? 'start'
      if (refreshed) return ok({ ok: true, session: row(), messages: [{ id: 'new', role: 'assistant', text: '明确刷新的记录', truncated: false }], nextCursor: null, managed: false, window })
      const chunk = url.searchParams.has('cursor') ? messages(19, 40) : window === 'recent' ? messages(20, 40) : [{ id: 'source', role: 'user', text: raw, truncated: false }, ...messages(1, 20)]
      return ok({ ok: true, session: row(), messages: chunk, nextCursor: window === 'start' && !url.searchParams.has('cursor') ? 'next' : null, managed: false, window })
    })
    const ui = await mount(SessionReader)
    await ui.click('session-view-start'); await ui.click('session-more'); await ui.click('message-source-toggle')
    expect(ui.container.querySelectorAll('[data-testid^="session-message-"]')).toHaveLength(40)
    expect(ui.byId('message-source-text').textContent).toBe(raw)
    const readsBefore = h.requests.filter(request => request.path.startsWith('/m/api/session?')).length
    const sourceElement = ui.byId('message-source-text')
    refreshed = true
    await focus(false); await focus(true)
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    expect(h.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(readsBefore)
    expect(ui.container.querySelectorAll('[data-testid^="session-message-"]')).toHaveLength(40)
    expect(ui.byId('message-source-text')).toBe(sourceElement)
    expect(ui.byId('message-source-text').textContent).toBe(raw)
    expect(ui.container.textContent).not.toContain('明确刷新的记录')
    await ui.click('session-refresh')
    expect(h.requests.at(-1)!.path).toBe('/m/api/session?key=k1&window=start')
    expect(ui.container.querySelectorAll('[data-testid^="session-message-"]')).toHaveLength(1)
    expect(ui.container.textContent).toContain('明确刷新的记录')
    expect(ui.byId('message-source-text')).toBeNull()
  })
  it('retries the first read after blur interrupted it; a late interrupted response cannot become the loaded context', async () => {
    const h = harness(), first = gate<Reply>()
    h.setRead(() => first.promise)
    const ui = await mount(SessionReader)
    expect(ui.byId('session-refresh')).toBeNull()
    await focus(false)
    h.setRead(() => ok({ ok: true, session: row(), messages: [{ id: 'fresh', role: 'assistant', text: '回页重新读取', truncated: false }], nextCursor: null, managed: false, window: 'recent' }))
    await focus(true)
    await act(() => first.resolve(ok({ ok: true, session: row(), messages: [{ id: 'late', role: 'assistant', text: '已打断的旧读取', truncated: false }], nextCursor: null, managed: false, window: 'recent' }))); await flush()
    expect(h.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(2)
    expect(ui.container.textContent).toContain('回页重新读取')
    expect(ui.container.textContent).not.toContain('已打断的旧读取')
    expect(ui.byId('session-refresh')).not.toBeNull()
  })
  it('does not hide a failed explicit refresh on return; keeps the previously read body available', async () => {
    const h = harness(), ui = await mount(SessionReader)
    h.setRead(() => new Error('daemon_offline'))
    await ui.click('session-refresh')
    expect(ui.byId('sessions-slow')).not.toBeNull()
    expect(ui.container.textContent).toContain('第39条')
    const reads = h.requests.filter(request => request.path.startsWith('/m/api/session?')).length
    await focus(false); await focus(true)
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    expect(ui.byId('sessions-slow')).not.toBeNull()
    expect(ui.container.textContent).toContain('第39条')
    expect(h.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(reads)
  })
  it('loads a changed backend context instead of keeping the old computer body, and refuses a mismatched key', async () => {
    harness()
    const ui = await mount(SessionReader)
    expect(ui.container.textContent).toContain('第39条')
    const other = harness()
    other.setRead(() => ok({ ok: true, session: row(), messages: [{ id: 'other', role: 'assistant', text: '另一台电脑的记录', truncated: false }], nextCursor: null, managed: false, window: 'recent' }))
    await act(() => ui.root.render(createElement(SessionReader))); await flush()
    expect(other.requests.filter(request => request.path.startsWith('/m/api/session?'))).toHaveLength(1)
    expect(ui.container.textContent).toContain('另一台电脑的记录')
    expect(ui.container.textContent).not.toContain('第39条')
    other.setRead(() => ok({ ok: true, session: row('unexpected'), messages: [{ id: 'wrong', role: 'assistant', text: '不属于这页的记录', truncated: false }], nextCursor: null, managed: false, window: 'recent' }))
    await ui.click('session-refresh')
    expect(ui.byId('sessions-slow')).not.toBeNull()
    expect(ui.container.textContent).not.toContain('不属于这页的记录')
    expect(ui.container.textContent).toContain('另一台电脑的记录')
  })
  it('puts a plain sessions entry at the end of Together, with no pinned chat and 交办 as its bottom action', async () => {
    const h = harness(), ui = await mount(Together)
    expect(ui.byId('together-sessions').textContent).toContain('电脑上的会话')
    await ui.click('together-sessions')
    expect(host.push).toHaveBeenCalledWith('/sessions')
    expect(ui.byId('together-pinned-chat')).toBeNull()
    await ui.click('together-delegate')
    expect(host.push).toHaveBeenCalledWith('/compose')
    expect(h.posts()).toHaveLength(0)
  })
})

describe('session list search and observations', () => {
  it('submits search explicitly, carries it between providers and rejects >200 chars without querying', async () => {
    const h = harness(), ui = await mount(Sessions), before = h.requests.length
    await ui.type('  按钮 & layout  ')
    expect(h.requests).toHaveLength(before)
    await ui.click('sessions-search')
    expect(h.requests.at(-1)!.path).toBe('/m/api/sessions?provider=claude&q=%E6%8C%89%E9%92%AE%20%26%20layout')
    expect(ui.container.textContent).toContain('会话 按钮 & layout')
    await ui.click('sessions-tab-codex')
    expect(h.requests.at(-1)!.path).toBe('/m/api/sessions?provider=codex&q=%E6%8C%89%E9%92%AE%20%26%20layout')
    await ui.type('x'.repeat(201)); const count = h.requests.length
    await ui.click('sessions-search')
    expect(ui.byId('sessions-search-error').textContent).toContain('200')
    expect(h.requests).toHaveLength(count)
  })
  it('shows cache/last-seen wording and neutral dots after cached refresh failure or disconnect', async () => {
    const h = harness(), ui = await mount(Sessions)
    expect(ui.container.textContent).toContain('原工具报告正在执行')
    expect(ui.container.querySelector('[data-dot]')!.getAttribute('data-dot')).toBe(palette.ok)
    await focus(false); h.setList(() => new Error('daemon_offline')); await focus(true)
    expect(ui.byId('sessions-cached').textContent).toContain('上次读到')
    expect(ui.container.textContent).toContain('上次看到正在执行')
    expect(ui.container.textContent).not.toContain('原工具报告正在执行')
    expect(ui.container.querySelector('[data-dot]')!.getAttribute('data-dot')).toBe(palette.unknown)
    expect(ui.byId('sessions-refresh')).not.toBeNull()
    await act(() => h.status('down')); await flush()
    expect(ui.container.textContent).toContain('上次看到正在执行')
  })
  it('rejects stale search/provider appended pages, including switching away and back before reply', async () => {
    const h = harness(), extra = gate<Reply>()
    h.setList(url => url.searchParams.has('cursor') ? extra.promise : ok({ ok: true, items: [row(url.searchParams.get('q') || url.searchParams.get('provider')!, url.searchParams.get('provider') as 'claude' | 'codex')], nextCursor: 'p2' }))
    const ui = await mount(Sessions)
    await act(() => ui.byId<HTMLButtonElement>('sessions-more').click()); await flush()
    await ui.click('sessions-tab-codex'); await ui.click('sessions-tab-claude')
    await ui.type('新搜索'); await ui.click('sessions-search')
    await act(() => extra.resolve(ok({ ok: true, items: [row('过期追加页')], nextCursor: null }))); await flush()
    expect(ui.container.textContent).toContain('新搜索')
    expect(ui.container.textContent).not.toContain('过期追加页')
    const firstSearchMore = gate<Reply>()
    h.setList(url => url.searchParams.has('cursor') ? firstSearchMore.promise : ok({ ok: true, items: [row(url.searchParams.get('q')!)], nextCursor: 'p2' }))
    await act(() => ui.byId<HTMLButtonElement>('sessions-more').click()); await flush()
    expect(h.requests.at(-1)!.path).toBe('/m/api/sessions?provider=claude&cursor=p2&q=%E6%96%B0%E6%90%9C%E7%B4%A2')
    await act(() => firstSearchMore.resolve(ok({ ok: true, items: [row('新搜索'), row('第二页')], nextCursor: null }))); await flush()
    expect(ui.container.querySelectorAll('[data-testid^="sessions-row-"]')).toHaveLength(2)
  })
})
