// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './native-motion.test-support'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, Connection } from '../backend/types'
import { withProviders } from '../state/providers.test-support'
import type { InputSnapshot } from '../state/matter-inputs'
import type { CompanionCard as CardData } from '../view/companion'
import { connectionNotice } from '../view/connection'
import { inputStatusText } from '../view/matter-input'
import { CompanionCard } from './CompanionCard'
import { ConnectionNotice } from './ConnectionNotice'
import { InputReceipts } from './InputReceipts'
import { Expansion, Sheet } from './Sheet'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const host = vi.hoisted(() => ({
  conn: { state: 'offline', lastSyncedAt: Date.now() - 120_000, epoch: 1 } as Connection,
  push: vi.fn(), openURL: vi.fn().mockResolvedValue(undefined), motion: true,
  finish: [] as Array<() => void>,
  reducedListeners: new Set<(value: boolean) => void>(), appListeners: new Set<(value: string) => void>(), blurListeners: new Set<() => void>(),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const props = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, 'aria-expanded': p.accessibilityState?.expanded,
    'aria-hidden': p.accessibilityElementsHidden || p.importantForAccessibility === 'no-hide-descendants' || undefined, 'aria-live': p.accessibilityLiveRegion })
  const View = (p: any) => createElement('div', { ...props(p), onClickCapture: p.pointerEvents === 'none' ? (e: any) => e.stopPropagation() : undefined }, p.children)
  const Pressable = (p: any) => createElement('button', { ...props(p), onClick: p.onPress, disabled: p.disabled }, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children)
  class Value { constructor(public value: number) {} setValue(n: number) { this.value = n }; stopAnimation() {}; interpolate() { return this } }
  const animation = (_: any, config: any) => ({ start: (fn?: (r: { finished: boolean }) => void) => { if (fn) host.finish.push(() => fn({ finished: true })) }, stop: () => {} })
  return {
    // selectable 的文字(原文)标出来,好按原样核对
    View, Text: (p: any) => createElement('span', { ...props(p), 'data-selectable': p.selectable || undefined }, p.children), Pressable, ScrollView: View, Image: () => null, ActivityIndicator: View,
    Modal: ({ visible, children }: any) => visible ? createElement('dialog', { open: true }, children) : null,
    Linking: { openURL: host.openURL }, findNodeHandle: () => null,
    Animated: { Value, View, timing: animation, parallel: (a: any[]) => ({ start: (fn?: (r: { finished: boolean }) => void) => { a.forEach(n => n.start()); if (fn) host.finish.push(() => fn({ finished: true })) }, stop: () => {} }), loop: () => ({ start() {}, stop() {} }) },
    Easing: { ease: (x: number) => x, out: (x: any) => x, inOut: (x: any) => x, linear: (x: number) => x },
    AccessibilityInfo: { isReduceMotionEnabled: async () => !host.motion, addEventListener: (_: string, callback: (value: boolean) => void) => { host.reducedListeners.add(callback); return { remove: () => host.reducedListeners.delete(callback) } }, setAccessibilityFocus() {} },
    AppState: { currentState: 'active', addEventListener: (_: string, callback: (value: string) => void) => { host.appListeners.add(callback); return { remove: () => host.appListeners.delete(callback) } } },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  }
})
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useRouter: () => ({ push: host.push }), useFocusEffect: (fn: () => void | (() => void)) => useEffect(() => {
    const cleanup = fn()
    if (cleanup) host.blurListeners.add(cleanup)
    return () => { if (cleanup) { cleanup(); host.blurListeners.delete(cleanup) } }
  }, [fn]) }
})
// 语言、连接都走真的:系统语言(设备边界)报英文;连接状态从注入真 BackendProvider 的假后端来(网络边界)。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }))

const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function click(id: string) { await act(async () => { el(id)?.click() }); await flush() }
const connected = (node: ReactNode) => {
  const backend: Backend = { ...makeDemoBackend({ lang: 'en' }), connection: () => host.conn, onConnection: cb => { cb(host.conn); return () => {} } }
  return withProviders(node, { backend, lang: 'en' })
}
async function mount(node: ReactNode) {
  const div = document.createElement('div'); document.body.appendChild(div)
  const root = createRoot(div); roots.push(root)
  await act(async () => { root.render(node) }); await flush()
  return root
}
beforeEach(() => { host.motion = true; host.finish = []; host.conn = { state: 'offline', lastSyncedAt: Date.now() - 120_000, epoch: 1 } })
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''; host.push.mockClear(); host.openURL.mockClear()
})

describe('compact native status details', () => {
  it('keeps offline status discoverable and exposes the exact stale-sync explanation on demand', async () => {
    const description = connectionNotice(host.conn, Date.now(), 'en')!.text
    await mount(connected(createElement(ConnectionNotice)))
    expect(el('conn-notice-offline')?.tagName).toBe('BUTTON')
    expect(el('conn-notice-offline')?.closest('[aria-live="polite"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain(description)
    await click('conn-notice-offline')
    expect(document.querySelector('dialog')?.textContent).toContain(description)
  })

  it('revoked pairing always retains its explicit repair action, including the home-only mode', async () => {
    host.conn = { state: 'revoked', lastSyncedAt: null, epoch: 2 }
    await mount(connected(createElement<{ only?: 'revoked' }>(ConnectionNotice, { only: 'revoked' })))
    expect(el('conn-notice-revoked')?.textContent).toContain("This phone can't connect anymore")
    await click('conn-repair')
    expect(host.push).toHaveBeenCalledWith('/pair')
  })

  it('folds lengthy receipt details while preserving raw original text and exact restore/retry identity', async () => {
    const row: InputSnapshot = { taskId: 'task1', requestId: 'request1', runId: 'run1', text: 'original', rawText: '  original\n\n text  ', status: 'uncertain' }
    const restore = vi.fn(), retry = vi.fn()
    await mount(createElement(InputReceipts, { rows: [row], onRestore: restore, onRetry: retry }))
    expect(el('input-receipt-request1')?.querySelector('[data-selectable]')?.textContent).toBe('  original\n\n text  ')
    expect(el('input-status-request1')?.closest('[aria-live="polite"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain(inputStatusText('uncertain', 'en'))
    await click('input-status-request1')
    expect(document.querySelector('dialog')?.textContent).toContain(inputStatusText('uncertain', 'en'))
    await click('input-status-request1-close')
    await click('input-restore-request1'); await click('input-retry-request1')
    expect(restore).toHaveBeenCalledWith(row); expect(retry).toHaveBeenCalledWith(row)
  })
})

describe('expandable native content', () => {
  it('lazily retains opted-in editors, hiding their controls for the entire closed interval', async () => {
    const action = vi.fn(), closed = vi.fn()
    const node = (open: boolean) => createElement(Expansion, { open, keepMounted: true, onClosed: closed,
      children: createElement('button', { 'data-testid': 'retained-editor', onClick: action }, 'Draft') })
    const root = await mount(node(false))
    expect(el('retained-editor')).toBeNull()
    await act(() => root.render(node(true))); await flush()
    const editor = el('retained-editor')
    expect(editor).not.toBeNull()
    await act(() => root.render(node(false))); await flush()
    expect(el('retained-editor')?.closest('[aria-hidden="true"]')).not.toBeNull()
    await click('retained-editor')
    expect(action).not.toHaveBeenCalled()
    await act(() => { for (const finish of host.finish.splice(0)) finish() })
    expect(el('retained-editor')).toBe(editor)
    expect(closed).toHaveBeenCalledTimes(1)
    await click('retained-editor')
    expect(action).not.toHaveBeenCalled()
    await act(() => root.render(node(true))); await flush()
    expect(el('retained-editor')).toBe(editor)
    expect(el('retained-editor')?.closest('[aria-hidden="true"]')).toBeNull()
    await click('retained-editor')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('hides closing sheet content from accessibility immediately but retains it until the visual close completes', async () => {
    await mount(createElement(Sheet, { title: 'Details', testID: 'sheet-toggle', children: createElement('span', { 'data-testid': 'sheet-detail' }, 'details') }))
    expect(el('sheet-detail')).toBeNull()
    await click('sheet-toggle')
    expect(el('sheet-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(el('sheet-detail')).not.toBeNull()
    await click('sheet-toggle')
    expect(el('sheet-toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(el('sheet-detail')).not.toBeNull()
    expect(el('sheet-detail')?.closest('[aria-hidden="true"]')).not.toBeNull()
    await act(async () => { for (const finish of host.finish.splice(0)) finish() })
    expect(el('sheet-detail')).toBeNull()
  })

  it.each(['reduced motion', 'background', 'blur'])('settles a closing sheet immediately on %s', async reason => {
    await mount(createElement(Sheet, { title: 'Details', testID: 'sheet-toggle', children: createElement('span', { 'data-testid': 'sheet-detail' }, 'details') }))
    await click('sheet-toggle'); await click('sheet-toggle')
    expect(el('sheet-detail')).not.toBeNull()
    await act(() => {
      if (reason === 'reduced motion') host.reducedListeners.forEach(listener => listener(true))
      else if (reason === 'background') host.appListeners.forEach(listener => listener('background'))
      else host.blurListeners.forEach(listener => listener())
    })
    expect(el('sheet-detail')).toBeNull()
  })

  it('disables child controls as soon as closing begins', async () => {
    const action = vi.fn()
    await mount(createElement(Sheet, { title: 'Details', testID: 'sheet-toggle', children: createElement('button', { 'data-testid': 'inside-action', onClick: action }, 'Act') }))
    await click('sheet-toggle'); await click('sheet-toggle')
    await click('inside-action')
    expect(action).not.toHaveBeenCalled()
    await click('sheet-toggle'); await click('inside-action')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('does not remove reopened content when an earlier close completion arrives', async () => {
    await mount(createElement(Sheet, { title: 'Details', testID: 'sheet-toggle', children: createElement('span', { 'data-testid': 'sheet-detail' }, 'details') }))
    await click('sheet-toggle'); await click('sheet-toggle'); await click('sheet-toggle')
    await act(() => { for (const finish of host.finish.splice(0)) finish() })
    expect(el('sheet-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(el('sheet-detail')).not.toBeNull()
  })

  it('keeps the seen card snapshot through the closing transition, then removes it without marking seen again', async () => {
    const card: CardData = { id: 'card1', kind: 'postcard', ts: '2026-10-24T12:00:00Z', at: Date.now(), title: 'A note', note: 'Full note', url: null }
    const seen = vi.fn()
    const root = await mount(createElement(CompanionCard, { card, onSeen: seen }))
    expect(seen).not.toHaveBeenCalled()
    await click('now-companion-card')
    expect(seen).toHaveBeenCalledExactlyOnceWith(card.ts)
    await act(() => { for (const finish of host.finish.splice(0)) finish() })
    await act(async () => { root.render(createElement(CompanionCard, { card: null, onSeen: seen })) })
    expect(el('now-companion-card')?.textContent).toContain('Full note')
    await click('now-companion-card')
    expect(el('now-companion-card')?.getAttribute('aria-expanded')).toBe('false')
    expect(el('now-companion-card')?.textContent).toContain('Full note')
    await click('now-companion-card')
    expect(seen).toHaveBeenCalledTimes(1)
    await act(() => { for (const finish of host.finish.splice(0)) finish() })
    expect(el('now-companion-card')).toBeNull()
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it.each(['reduced motion', 'background', 'blur'])('removes the closing seen card immediately on %s', async reason => {
    const card: CardData = { id: 'card1', kind: 'postcard', ts: '2026-10-24T12:00:00Z', at: Date.now(), title: 'A note', note: 'Full note', url: null }
    const seen = vi.fn()
    const root = await mount(createElement(CompanionCard, { card, onSeen: seen }))
    await click('now-companion-card')
    await act(() => { for (const finish of host.finish.splice(0)) finish() })
    await act(() => { root.render(createElement(CompanionCard, { card: null, onSeen: seen })) })
    await click('now-companion-card')
    expect(el('now-companion-card')).not.toBeNull()
    await act(() => {
      if (reason === 'reduced motion') host.reducedListeners.forEach(listener => listener(true))
      else if (reason === 'background') host.appListeners.forEach(listener => listener('background'))
      else host.blurListeners.forEach(listener => listener())
    })
    expect(el('now-companion-card')).toBeNull()
    expect(seen).toHaveBeenCalledExactlyOnceWith(card.ts)
  })

  it('closes a seen card immediately when motion was already disabled', async () => {
    host.motion = false
    const card: CardData = { id: 'card1', kind: 'postcard', ts: '2026-10-24T12:00:00Z', at: Date.now(), title: 'A note', note: 'Full note', url: null }
    const seen = vi.fn()
    const root = await mount(createElement(CompanionCard, { card, onSeen: seen }))
    await click('now-companion-card')
    await act(() => { root.render(createElement(CompanionCard, { card: null, onSeen: seen })) })
    await click('now-companion-card')
    expect(el('now-companion-card')).toBeNull()
    expect(seen).toHaveBeenCalledExactlyOnceWith(card.ts)
  })

  it('external links open directly and mark seen without expanding the card', async () => {
    const card: CardData = { id: 'link1', kind: 'hunt', ts: '2026-10-24T12:00:00Z', at: Date.now(), title: 'A link', note: 'Preview', url: 'https://example.com/note' }
    const seen = vi.fn()
    await mount(createElement(CompanionCard, { card, onSeen: seen }))
    await click('now-companion-card')
    expect(host.openURL).toHaveBeenCalledExactlyOnceWith(card.url)
    expect(seen).toHaveBeenCalledExactlyOnceWith(card.ts)
    expect(el('now-companion-card')?.getAttribute('aria-expanded')).toBeNull()
  })
})
