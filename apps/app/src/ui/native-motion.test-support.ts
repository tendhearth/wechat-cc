// Native animation and lifecycle boundary for DOM tests; timers stand in for the native driver.
import { act, createElement, useSyncExternalStore, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { vi } from 'vitest'
type Animation = { start(callback?: (result: { finished: boolean }) => void): void; stop(): void }
type FocusEntry = { run(): void | (() => void); cleanup?: void | (() => void) }
export const host = { reduced: false, appState: 'active', focused: true, read: (): Promise<boolean> => Promise.resolve(host.reduced), reducedListeners: new Set<(value: boolean) => void>(), appListeners: new Set<(value: string) => void>(), focusEntries: new Set<FocusEntry>() }
export class Value {
  private current: number
  private listeners = new Set<() => void>()
  constructor(value: number) { this.current = value }
  setValue(value: number) { this.current = value; for (const listener of this.listeners) listener() }
  get = () => this.current
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  stopAnimation() {}
  interpolate({ inputRange, outputRange }: { inputRange: number[]; outputRange: (string | number)[] }) { return { get: () => {
    const progress = (this.current - inputRange[0]!) / (inputRange[1]! - inputRange[0]!)
    const first = outputRange[0]!, last = outputRange[1]!, result = parseFloat(String(first)) + progress * (parseFloat(String(last)) - parseFloat(String(first)))
    return typeof first === 'string' ? `${result}${first.replace(/[\d.\-]/g, '')}` : result
  }, subscribe: this.subscribe } }
}
function timing(value: Value, { toValue, duration }: { toValue: number; duration: number }): Animation {
  let timer: ReturnType<typeof setTimeout> | undefined, done: ((r: { finished: boolean }) => void) | undefined
  return { start(callback) { done = callback; timer = setTimeout(() => { value.setValue(toValue); done?.({ finished: true }) }, duration) }, stop() { clearTimeout(timer); done?.({ finished: false }); done = undefined } }
}
function sequence(children: Animation[]): Animation {
  let current = 0, stopped = false, done: ((r: { finished: boolean }) => void) | undefined
  const next = () => { if (stopped) return; const child = children[current++]; if (!child) { done?.({ finished: true }); return }; child.start(result => { if (result.finished) next() }) }
  return { start(callback) { current = 0; stopped = false; done = callback; next() }, stop() { stopped = true; children[current - 1]?.stop(); done?.({ finished: false }) } }
}
function parallel(children: Animation[]): Animation {
  let remaining = children.length, stopped = false
  return { start(callback) { for (const child of children) child.start(result => { if (result.finished && !stopped && --remaining === 0) callback?.({ finished: true }) }) }, stop() { stopped = true; for (const child of children) child.stop() } }
}
function loop(child: Animation): Animation { let stopped = false; const next = () => child.start(result => { if (!stopped && result.finished) next() }); return { start() { next() }, stop() { stopped = true; child.stop() } } }
function flatten(style: any): any { return Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ?? {} }
function valuesIn(style: any, output = new Set<any>()): Set<any> { if (style && typeof style.get === 'function') output.add(style); else if (style && typeof style === 'object') Object.values(style).forEach(value => valuesIn(value, output)); return output }
function resolve(value: any): any { if (value && typeof value.get === 'function') return value.get(); if (Array.isArray(value)) return value.map(resolve); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)])); return value }
export function View({ children, testID, style, accessibilityLabel, accessibilityRole, accessibilityState, accessible, accessibilityViewIsModal }: any) {
  const flat = flatten(style), values = [...valuesIn(flat)], state = () => JSON.stringify(resolve(flat))
  const snapshot = useSyncExternalStore(listener => { const removes = values.map(value => value.subscribe(listener)); return () => removes.forEach(remove => remove()) }, state, state)
  return createElement('div', { 'data-testid': testID, 'data-style': snapshot, 'aria-label': accessibilityLabel, role: accessibilityViewIsModal ? 'dialog' : accessibilityRole, 'aria-busy': accessibilityState?.busy, 'aria-hidden': accessible === false ? true : undefined }, children)
}
export function nativeBoundary() {
  const Pressable = ({ children, onPress, disabled, testID, accessibilityLabel, accessibilityState, style, ref }: any) => createElement('button', { ref, onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, 'data-style': JSON.stringify(flatten(typeof style === 'function' ? style({ pressed: false }) : style)) }, typeof children === 'function' ? children({ pressed: false }) : children)
  const Text = ({ children, accessibilityRole, accessibilityLabel, testID }: any) => createElement('span', { role: accessibilityRole, 'aria-label': accessibilityLabel, 'data-testid': testID }, children)
  const Image = ({ source, style, testID, accessibilityLabel, accessible }: any) => createElement('img', { src: source, 'data-testid': testID, 'data-style': JSON.stringify(flatten(style)), 'aria-label': accessibilityLabel, 'aria-hidden': accessible === false ? true : undefined })
  const Modal = ({ visible, children, onRequestClose }: any) => visible ? createElement('section', { onKeyDown: (event: any) => { if (event.key === 'Escape') onRequestClose() } }, children) : null
  return { useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), View, Text, Image, Pressable, Modal, ScrollView: View, Animated: { View, Image, Value, timing, sequence, parallel, loop }, Easing: { ease: () => {}, linear: () => {}, out: (value: unknown) => value, inOut: (value: unknown) => value, bezier: () => () => {} }, AccessibilityInfo: { isReduceMotionEnabled: () => host.read(), addEventListener: (_: string, callback: (v: boolean) => void) => { host.reducedListeners.add(callback); return { remove: () => host.reducedListeners.delete(callback) } }, setAccessibilityFocus: () => {} }, AppState: { get currentState() { return host.appState }, addEventListener: (_: string, callback: (v: string) => void) => { host.appListeners.add(callback); return { remove: () => host.appListeners.delete(callback) } } }, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default }, findNodeHandle: () => 1 }
}
export async function routerBoundary() { const { useEffect } = await import('react'); return { useFocusEffect: (run: FocusEntry['run']) => useEffect(() => { const entry: FocusEntry = { run }; host.focusEntries.add(entry); if (host.focused) entry.cleanup = run(); return () => { entry.cleanup?.(); host.focusEntries.delete(entry) } }, [run]) } }
export async function focus(on: boolean) { await act(() => { host.focused = on; for (const entry of host.focusEntries) { if (on) entry.cleanup = entry.run(); else { entry.cleanup?.(); entry.cleanup = undefined } } }) }
export async function background(state: string) { await act(() => { host.appState = state; host.appListeners.forEach(listener => listener(state)) }) }
export async function reduce(on: boolean) { await act(() => { host.reduced = on; host.reducedListeners.forEach(listener => listener(on)) }) }
export async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
export function resetHost() { host.reduced = false; host.appState = 'active'; host.focused = true; host.read = () => Promise.resolve(host.reduced) }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const require = createRequire(import.meta.url)
require.extensions['.png'] = (module, file) => { module.exports = file }
const createRoot = require('react-dom/client').createRoot as (container: Element) => { render(node: ReactNode): void; unmount(): void }
const roots: ReturnType<typeof createRoot>[] = []
export async function mount(node: ReactNode) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container); roots.push(root)
  const render = async (next: ReactNode) => { await act(async () => root.render(next)) }
  await render(node)
  return { root, container, render, byId: (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!, style: (id: string) => JSON.parse(container.querySelector(`[data-testid="${id}"]`)!.getAttribute('data-style')!) }
}
export async function cleanup() { await act(() => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; host.focusEntries.clear(); vi.useRealTimers() }
