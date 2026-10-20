// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { ActivityItemT, ActivityPageT, Backend } from '../backend/types'
import { makeStore, type Store } from './store'
import Activity from '../app/activity'

// 「CC 做过的事」页的翻页状态(评审 10-20):游标交接、第一页重拉不冲掉翻到的页、换后端作废旧配对在飞的结果。
type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store }, push: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const View = ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children)
  const Text = ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children)
  const Pressable = ({ children, onPress, disabled, testID }: any) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID }, typeof children === 'function' ? children({ pressed: false }) : children)
  return { View, Text, Pressable, ScrollView: View, ActivityIndicator: View, Image: () => null, Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default } }
})
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react')
  return { SafeAreaView: ({ children }: any) => createElement('main', null, children) }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ canGoBack: () => true, back: vi.fn(), push: host.push, replace: vi.fn() }) }))
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('../state/BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))
vi.mock('../ui/ConnectionNotice', () => ({ ConnectionNotice: () => null }))

const NOW = Date.now()
const it_ = (id: string, ago: number, extra: Partial<ActivityItemT> = {}): ActivityItemT => ({ id, kind: 'proactive', at: NOW - ago, title: `t-${id}`, ...extra })

/** 假后端:第一页可换;按游标给的页可以挂起,手动放行。 */
function fake() {
  let first: ActivityPageT = { items: [it_('a1', 1000), it_('a2', 2000)], next: 'c1', degraded: [] }
  const calls: Array<string | null> = []
  const pending = new Map<string, (p: ActivityPageT) => void>()
  const pages: Record<string, ActivityPageT> = {
    c1: { items: [it_('b1', 3000)], next: 'c2', degraded: [] },
    c2: { items: [it_('c1', 4000)], next: null, degraded: [] },
  }
  let hold = false
  const backend: Backend = {
    ...makeDemoBackend({ lang: 'zh-Hans' }),
    async activity(p) {
      const cur = p?.cursor ?? null
      calls.push(cur)
      if (!cur) return first
      if (hold) return new Promise(res => pending.set(cur, res))
      return pages[cur]!
    },
  }
  return {
    backend, store: makeStore(backend, { lang: 'zh-Hans' }), calls,
    setFirst: (p: ActivityPageT) => { first = p },
    hold: (on: boolean) => { hold = on },
    release: (cur: string) => pending.get(cur)!(pages[cur]!),
  }
}

async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const rowIds = () => [...document.querySelectorAll('[data-testid^="activity-row-"]')].map(e => e.getAttribute('data-testid')!.slice('activity-row-'.length))
const more = () => document.querySelector('[data-testid="activity-more"]') as HTMLButtonElement | null
async function click(el: Element | null) { await act(async () => { (el as HTMLElement).click() }); await flush() }
async function mount(ctx: { backend: Backend; store: Store }) {
  host.ctx = ctx
  const div = document.createElement('div'); document.body.appendChild(div)
  const root = createRoot(div); roots.push(root)
  await act(async () => { root.render(createElement(Activity)) })
  await flush()
  return root
}

afterEach(async () => {
  await act(() => { for (const r of roots.splice(0)) r.unmount() })
  document.body.innerHTML = ''
  host.push.mockClear()
})

describe('CC 做过的事 页面翻页', () => {
  it('游标交接:第一页 next ⇒ 第二次带 c1;第二页 next ⇒ 第三次带 c2;没了就不再显示「再早一点」', async () => {
    const f = fake()
    await mount(f)
    expect(rowIds()).toEqual(['a1', 'a2'])
    await click(more())
    expect(f.calls.at(-1)).toBe('c1')
    expect(rowIds()).toEqual(['a1', 'a2', 'b1'])
    await click(more())
    expect(f.calls.at(-1)).toBe('c2')
    expect(rowIds()).toEqual(['a1', 'a2', 'b1', 'c1'])
    expect(more()).toBeNull()
  })

  it('第一页重拉(重连 / 回前台)不冲掉已翻到的页;新来的那条插在最上面,重复的按 id 去重', async () => {
    const f = fake()
    await mount(f)
    await click(more())
    expect(rowIds()).toEqual(['a1', 'a2', 'b1'])
    f.setFirst({ items: [it_('a0', 500), it_('a1', 1000)], next: 'c1', degraded: [] })
    await act(async () => { f.store.revalidateAll() })
    await flush()
    expect(rowIds()).toEqual(['a0', 'a1', 'b1'])
    // 接着往下翻仍用翻到的那页的游标,不从头再翻
    await click(more())
    expect(f.calls.at(-1)).toBe('c2')
  })

  it('换后端(换配对)⇒ 清掉翻到的页;旧配对在飞的那页回来也不进新页面', async () => {
    const a = fake()
    const root = await mount(a)
    a.hold(true)
    await click(more())
    expect(a.calls.at(-1)).toBe('c1')
    const b = fake()
    b.setFirst({ items: [it_('x1', 1000)], next: null, degraded: [] })
    host.ctx = b
    await act(async () => { root.render(createElement(Activity)) })
    await flush()
    expect(rowIds()).toEqual(['x1'])
    await act(async () => { a.release('c1') })
    await flush()
    expect(rowIds()).toEqual(['x1'])
  })

  it('能点的行 push 对应路由;不能点的只是一行字', async () => {
    const f = fake()
    f.setFirst({ items: [it_('t', 1000, { kind: 'together', ref: { type: 'task', id: 'e5f6a7b8' } }), it_('p', 2000)], next: null, degraded: [] })
    await mount(f)
    await click(document.querySelector('[data-testid="activity-row-t"]'))
    expect(host.push).toHaveBeenCalledWith('/matter/e5f6a7b8')
    expect(document.querySelector('[data-testid="activity-row-p"]')!.tagName).toBe('DIV')
  })
})
